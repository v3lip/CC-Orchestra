import type { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type ServerToTurtle, parseTurtleMessage } from '@ccfleet/protocol';
import { ApiError, type Fleet, type TurtleConn } from './fleet';
import { newId, now } from './util';

const HELLO_TIMEOUT_MS = 10_000;

/** Drive one turtle WebSocket: enrollment, authentication and message dispatch. */
/**
 * A turtle sends ~4 messages per command (ack, snapshot, observations, result), and
 * one-tick ops like inspect or drop can run ~20 commands a second. The limit is far
 * above that but still bounds a misbehaving client.
 */
export function handleTurtleSocket(ws: WebSocket, fleet: Fleet, remote: string, maxMessagesPerSecond = 300): void {
  let turtleId: string | undefined;
  let windowStart = now();
  let windowCount = 0;

  const conn: TurtleConn = {
    send(msg: ServerToTurtle) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
    close(code = 1000, reason = '') {
      ws.close(code, reason);
    },
  };
  const deny = (reason: string) => {
    conn.send({ v: PROTOCOL_VERSION, type: 'denied', id: newId('m'), ts: now(), reason });
    ws.close(4003, reason.slice(0, 120));
  };

  const helloTimer = setTimeout(() => {
    if (!turtleId) deny('no hello received');
  }, HELLO_TIMEOUT_MS);

  ws.on('message', (data, isBinary) => {
    if (fleet.closed) return;
    const t = now();
    if (t - windowStart > 1000) {
      windowStart = t;
      windowCount = 0;
    }
    if (++windowCount > maxMessagesPerSecond) {
      fleet.log('error', `Closing turtle connection from ${remote}: message rate limit exceeded`, turtleId);
      ws.close(4008, 'rate limit');
      return;
    }
    if (isBinary) return deny('binary frames are not supported');
    const parsed = parseTurtleMessage(data.toString());
    if (!parsed.ok) {
      fleet.log('warn', `Rejected message from ${turtleId ?? remote}: ${parsed.error}`, turtleId);
      if (!turtleId) deny(parsed.error);
      return;
    }
    const msg = parsed.msg;

    if (!turtleId) {
      if (msg.type === 'enroll') {
        try {
          const r = fleet.enroll(msg.code, msg.computerId, msg.label, msg.agent);
          conn.send({ v: PROTOCOL_VERSION, type: 'enrolled', id: newId('m'), ts: now(), ...r });
        } catch (e) {
          fleet.log('warn', `Enrollment from ${remote} refused: ${(e as Error).message}`);
          deny(e instanceof ApiError ? e.message : 'enrollment failed');
        }
        return;
      }
      if (msg.type !== 'hello') return deny('expected hello');
      if (!fleet.authenticate(msg.turtleId, msg.secret)) {
        fleet.log('warn', `Authentication failed for turtle id ${msg.turtleId} from ${remote}`);
        return deny('invalid credentials');
      }
      turtleId = msg.turtleId;
      clearTimeout(helloTimer);
      fleet.connect(turtleId, conn, msg);
      return;
    }

    switch (msg.type) {
      case 'snapshot':
        fleet.heartbeat(turtleId);
        fleet.applyState(turtleId, msg.state, true);
        break;
      case 'telemetry':
        fleet.heartbeat(turtleId);
        fleet.applyState(turtleId, msg.state);
        break;
      case 'hb':
        fleet.heartbeat(turtleId);
        conn.send({ v: PROTOCOL_VERSION, type: 'hb_ack', id: newId('m'), ts: now(), seq: msg.seq });
        if (msg.fuel !== undefined) fleet.applyState(turtleId, { fuel: msg.fuel });
        break;
      case 'ack':
        fleet.heartbeat(turtleId);
        fleet.ack(turtleId, msg.commandId, msg.status, msg.code, msg.reason);
        break;
      case 'result':
        fleet.heartbeat(turtleId);
        fleet.result(turtleId, msg);
        break;
      case 'stop_ack':
        fleet.stopAck(turtleId, msg.stopId, msg.finishing);
        break;
      case 'released':
        fleet.released(turtleId, msg.stopId);
        break;
      case 'observe': {
        const r = fleet.observe(turtleId, msg.blocks, msg.scan?.radius);
        if (r.rejected) fleet.log('warn', `Ignored ${r.rejected} observation(s) ${msg.scan ? 'outside the scan radius of' : 'not adjacent to'} the turtle's known position`, turtleId);
        break;
      }
      case 'log':
        fleet.log(msg.level, msg.message, turtleId);
        break;
      case 'enroll':
      case 'hello':
        break;
    }
  });

  ws.on('close', (code, reason) => {
    clearTimeout(helloTimer);
    // The close code tells a clean shutdown (1000/1001) from a link that just dropped (1006).
    const why = reason?.length ? `${code}: ${reason.toString().slice(0, 80)}` : `${code}`;
    if (turtleId) fleet.disconnect(turtleId, conn, `socket closed, code ${why}`);
  });
  ws.on('error', () => ws.close());
}
