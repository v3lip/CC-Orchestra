/**
 * Simulator verification: these tests run the real backend against simulated turtles
 * over real WebSockets. They do NOT prove behaviour inside Minecraft.
 */
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStore, type SimTurtle } from '@ccfleet/sim';
import { openWorld, settle, spawnTurtle, startServer, waitFor } from './helpers';

type Server = Awaited<ReturnType<typeof startServer>>;
let server: Server | undefined;
const turtles: SimTurtle[] = [];

afterEach(async () => {
  for (const t of turtles.splice(0)) t.stop();
  await server?.close();
  server = undefined;
});

async function setup() {
  server = await startServer();
  return { server, world: openWorld() };
}
async function spawn(...args: Parameters<typeof spawnTurtle>) {
  const t = await spawnTurtle(...args);
  turtles.push(t);
  return t;
}

describe('enrollment and authentication', () => {
  it('pairing codes are single-use and credentials are per turtle', async () => {
    const { server, world } = await setup();
    const t = await spawn(server, world, { x: 0, y: 100, z: 0 });
    expect(server.fleet.getTurtle(t.turtleId!)?.simulated).toBe(true);

    const { code } = server.fleet.createEnrollment({});
    server.fleet.enroll(code, 7, undefined, { kind: 'lua', version: 'x' });
    expect(() => server.fleet.enroll(code, 8, undefined, { kind: 'lua', version: 'x' })).toThrow(/already used/);
    expect(() => server.fleet.enroll('AAAA-BBBB', 8, undefined, { kind: 'lua', version: 'x' })).toThrow(/invalid/);
  });

  it('rejects a hello with a wrong secret', async () => {
    const { server, world } = await setup();
    const t = await spawn(server, world, { x: 0, y: 100, z: 0 });
    const ws = new WebSocket(server.wsUrl);
    const denied = new Promise<string>((resolve) => ws.on('message', (d) => resolve(JSON.parse(d.toString()).reason)));
    ws.on('open', () =>
      ws.send(JSON.stringify({ v: 1, id: 'x1', ts: Date.now(), type: 'hello', turtleId: t.turtleId, secret: 'wrong-secret-wrong-secret', computerId: 1, agent: { kind: 'lua', version: '1' }, bootId: 'b', recent: {} })),
    );
    expect(await denied).toBe('invalid credentials');
    expect(server.fleet.getTurtle(t.turtleId!)?.connection).toBe('online'); // the real turtle is unaffected
  });
});

describe('manual control', () => {
  it('moves, tracks pose, and records traversed and observed cells', async () => {
    const { server, world } = await setup();
    world.set(0, 100, -3, { name: 'minecraft:stone' });
    const t = await spawn(server, world, { x: 0, y: 100, z: 0, heading: 0 });
    const b = server.fleet.issueCommand({ turtleIds: [t.turtleId!] }, 'forward', {});
    expect((await settle(server, b.id)).items[0].status).toBe('succeeded');
    const v = server.fleet.getTurtle(t.turtleId!)!;
    expect(v.state?.pose.pos).toEqual({ x: 0, y: 100, z: -1 });
    expect(v.state?.fuel).toBe(99);

    const b2 = server.fleet.issueCommand({ turtleIds: [t.turtleId!] }, 'forward', {});
    await settle(server, b2.id);
    // Facing north from z=-2, the stone at z=-3 is scanned after the move.
    const map = server.fleet.queryMap({ world: 'sim', dimension: 'minecraft:overworld', x0: -1, x1: 1, z0: -4, z1: 1, y0: 99, y1: 101 });
    expect(map.blocks.find((m) => m.z === -3 && m.y === 100)?.block).toBe('minecraft:stone');
    expect(map.blocks.find((m) => m.z === -1 && m.y === 100)?.cell).toBe('empty');

    const b3 = server.fleet.issueCommand({ turtleIds: [t.turtleId!] }, 'forward', {});
    const r3 = await settle(server, b3.id);
    expect(r3.items[0]).toMatchObject({ status: 'failed', code: 'obstructed' });
    expect(server.fleet.getTurtle(t.turtleId!)?.state?.pose.pos).toEqual({ x: 0, y: 100, z: -2 });
  });

  it('runs queued commands strictly one at a time', async () => {
    const { server, world } = await setup();
    const t = await spawn(server, world, { x: 0, y: 100, z: 0, heading: 1 });
    const batches = [1, 2, 3].map(() => server.fleet.issueCommand({ turtleIds: [t.turtleId!] }, 'forward', {}));
    for (const b of batches) expect((await settle(server, b.id)).items[0].status).toBe('succeeded');
    expect(server.fleet.getTurtle(t.turtleId!)?.state?.pose.pos).toEqual({ x: 3, y: 100, z: 0 });
  });

  it('reports per-turtle results for a group command, including partial failure', async () => {
    const { server, world } = await setup();
    world.set(4, 100, -1, { name: 'minecraft:stone' });
    const a = await spawn(server, world, { x: 0, y: 100, z: 0 });
    const blocked = await spawn(server, world, { x: 4, y: 100, z: 0 });
    const gone = await spawn(server, world, { x: 8, y: 100, z: 0 });
    gone.stop();
    await waitFor(() => server.fleet.getTurtle(gone.turtleId!)?.connection === 'offline');
    const g = server.fleet.createGroup('Diggers', [a.turtleId!, blocked.turtleId!, gone.turtleId!]);
    const b = await settle(server, server.fleet.issueCommand({ groupIds: [g.id] }, 'forward', {}).id);
    const by = Object.fromEntries(b.items.map((i) => [i.turtleId, i]));
    expect(by[a.turtleId!].status).toBe('succeeded');
    expect(by[blocked.turtleId!]).toMatchObject({ status: 'failed', code: 'obstructed' });
    expect(by[gone.turtleId!]).toMatchObject({ status: 'undeliverable' });
  });

  it('two turtles cannot occupy the same cell (narrow corridor head-on)', async () => {
    const { server, world } = await setup();
    // A one-wide corridor along X: turtles face each other with one free cell between them.
    const east = await spawn(server, world, { x: 0, y: 100, z: 0, heading: 1 });
    const west = await spawn(server, world, { x: 2, y: 100, z: 0, heading: 3 });
    const b1 = server.fleet.issueCommand({ turtleIds: [east.turtleId!, west.turtleId!] }, 'forward', {});
    const r = await settle(server, b1.id);
    const statuses = r.items.map((i) => i.status).sort();
    // Exactly one wins the middle cell; the other is physically obstructed and reports it.
    expect(statuses).toEqual(['failed', 'succeeded']);
    expect(r.items.find((i) => i.status === 'failed')?.code).toBe('obstructed');
  });
});

describe('duplicate delivery', () => {
  it('a re-delivered command is not executed twice', async () => {
    const { server, world } = await setup();
    const t = await spawn(server, world, { x: 0, y: 100, z: 0, heading: 0 }, { opMs: 60 });
    const b = server.fleet.issueCommand({ turtleIds: [t.turtleId!] }, 'forward', {});
    const cmdId = b.items[0].commandId!;
    await waitFor(() => server.fleet.getBatch(b.id)?.items[0].status === 'running');
    server.fleet.redeliver(cmdId); // while running
    await settle(server, b.id);
    server.fleet.redeliver(cmdId); // after completion
    await new Promise((r) => setTimeout(r, 300));
    expect(t.body.pos).toEqual({ x: 0, y: 100, z: -1 });
    expect(t.body.fuel).toBe(99);
    expect(server.fleet.getBatch(b.id)?.items[0].status).toBe('succeeded');
  });
});

describe('emergency stop', () => {
  it('stops after the current atomic op, reports unreachable turtles, and holds until resumed', async () => {
    const { server, world } = await setup();
    const busy = await spawn(server, world, { x: 0, y: 100, z: 0 }, { opMs: 200 });
    const idle = await spawn(server, world, { x: 4, y: 100, z: 0 });
    const off = await spawn(server, world, { x: 8, y: 100, z: 0 });
    off.stop();
    await waitFor(() => server.fleet.getTurtle(off.turtleId!)?.connection === 'offline');

    const move = server.fleet.issueCommand({ turtleIds: [busy.turtleId!] }, 'forward', {});
    const queued = server.fleet.issueCommand({ turtleIds: [busy.turtleId!] }, 'forward', {});
    await waitFor(() => server.fleet.getBatch(move.id)?.items[0].status === 'running');

    const stop = server.fleet.stop({ all: true }, 'estop');
    const res = await settle(server, stop.id, ['stopped', 'unreachable']);
    const by = Object.fromEntries(res.items.map((i) => [i.turtleId, i.status]));
    expect(by[off.turtleId!]).toBe('unreachable');
    expect(by[idle.turtleId!]).toBe('stopped');
    expect(by[busy.turtleId!]).toBe('stopped');
    // The in-progress move finished (atomic); the queued one never ran.
    expect((await settle(server, move.id)).items[0].status).toBe('succeeded');
    expect((await settle(server, queued.id)).items[0].status).toBe('cancelled');
    expect(busy.body.pos.z).toBe(-1);

    // Held turtles refuse physical commands.
    const refused = await settle(server, server.fleet.issueCommand({ turtleIds: [idle.turtleId!] }, 'forward', {}).id);
    expect(refused.items[0]).toMatchObject({ status: 'rejected', code: 'held' });

    // The offline turtle gets the stop when it reconnects.
    expect(server.fleet.getTurtle(off.turtleId!)?.pendingStop).toBe(true);
    off.start();
    await waitFor(() => off.mem.hold?.reason === 'estop', 5000, 'pending stop delivery');

    const resumed = await settle(server, server.fleet.resume({ turtleIds: [idle.turtleId!] }).id, ['released', 'unreachable']);
    expect(resumed.items[0].status).toBe('released');
    const ok = await settle(server, server.fleet.issueCommand({ turtleIds: [idle.turtleId!] }, 'forward', {}).id);
    expect(ok.items[0].status).toBe('succeeded');
  });
});

describe('restarts and connection loss', () => {
  it('reboot between a physical move and saving it: fuel evidence resolves the position', async () => {
    const { server, world } = await setup();
    const store = new InMemoryStore();
    const t = await spawn(server, world, { x: 0, y: 100, z: 0, heading: 0 }, { store });
    let crashOnce = true;
    t.faults.crashAfterPhysicalMove = () => {
      const c = crashOnce;
      crashOnce = false;
      return c;
    };
    const b = server.fleet.issueCommand({ turtleIds: [t.turtleId!] }, 'forward', {});
    const r = await waitFor(() => {
      const it = server.fleet.getBatch(b.id)?.items[0];
      return it && it.status === 'succeeded' ? it : undefined;
    }, 8000, 'reconciled result');
    expect(r.reason).toMatch(/resolved after reconnect/);
    const pose = server.fleet.getTurtle(t.turtleId!)!.state!.pose;
    expect(pose).toMatchObject({ pos: { x: 0, y: 100, z: -1 }, position: 'known' });
    expect(t.body.pos).toEqual({ x: 0, y: 100, z: -1 });
  });

  it('with unlimited fuel there is no evidence, so the position becomes uncertain', async () => {
    const { server, world } = await setup();
    const t = await spawn(server, world, { x: 0, y: 100, z: 0, heading: 0 }, { fuel: 'unlimited' });
    let crashOnce = true;
    t.faults.crashAfterPhysicalMove = () => {
      const c = crashOnce;
      crashOnce = false;
      return c;
    };
    const b = server.fleet.issueCommand({ turtleIds: [t.turtleId!] }, 'forward', {});
    await waitFor(() => server.fleet.getTurtle(t.turtleId!)?.state?.pose.position === 'uncertain', 8000, 'uncertain pose');
    const pose = server.fleet.getTurtle(t.turtleId!)!.state!.pose;
    expect(pose.candidates).toEqual([
      { x: 0, y: 100, z: 0 },
      { x: 0, y: 100, z: -1 },
    ]);
    expect(server.fleet.getBatch(b.id)?.items[0].status).toBe('unknown');
    // An operator (or GPS) fix resolves it.
    const fix = await settle(server, server.fleet.issueCommand({ turtleIds: [t.turtleId!] }, 'gpsLocate', {}).id);
    expect(fix.items[0].status).toBe('succeeded');
    expect(server.fleet.getTurtle(t.turtleId!)!.state!.pose).toMatchObject({ position: 'known', source: 'gps', pos: { x: 0, y: 100, z: -1 } });
  });

  it('connection lost before the result: outcome is unknown, then reconciled on reconnect', async () => {
    const { server, world } = await setup();
    const t = await spawn(server, world, { x: 0, y: 100, z: 0, heading: 0 }, { opMs: 100 });
    let dropOnce = true;
    t.faults.dropBeforeResult = () => {
      const d = dropOnce;
      dropOnce = false;
      return d;
    };
    const b = server.fleet.issueCommand({ turtleIds: [t.turtleId!] }, 'forward', {});
    await waitFor(() => server.fleet.getBatch(b.id)?.items[0].status === 'unknown', 5000, 'unknown status');
    // Its last position is still shown; it is offline, not gone.
    expect(server.fleet.getTurtle(t.turtleId!)?.connection).toBe('offline');
    const r = await waitFor(() => (server.fleet.getBatch(b.id)?.items[0].status === 'succeeded' ? server.fleet.getBatch(b.id) : undefined), 8000, 'reconciled');
    expect(r.items[0].reason).toMatch(/resolved after reconnect/);
  });

  it('a silent turtle goes stale, then offline', async () => {
    const { server, world } = await setup();
    const t = await spawn(server, world, { x: 0, y: 100, z: 0 });
    // Freeze heartbeats without closing the socket (e.g. the chunk unloaded).
    (t as unknown as { heartbeatTimer: NodeJS.Timeout }).heartbeatTimer && clearInterval((t as unknown as { heartbeatTimer: NodeJS.Timeout }).heartbeatTimer);
    await waitFor(() => server.fleet.getTurtle(t.turtleId!)?.connection === 'stale', 3000, 'stale');
    await waitFor(() => server.fleet.getTurtle(t.turtleId!)?.connection === 'offline', 3000, 'offline');
    t.stop();
  });

  it('backend restart: in-flight commands become unknown and are reconciled from the turtle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccorchestra-'));
    const dbFile = join(dir, 'fleet.sqlite');
    try {
      server = await startServer({ dbFile });
      const port = server.port;
      const world = openWorld();
      const t = await spawn(server, world, { x: 0, y: 100, z: 0, heading: 0 }, { opMs: 300 });
      const b = server.fleet.issueCommand({ turtleIds: [t.turtleId!] }, 'forward', {});
      const cmdId = b.items[0].commandId!;
      await waitFor(() => server!.fleet.getBatch(b.id)?.items[0].status === 'running');
      await server.close();
      server = await startServer({ dbFile, port });
      expect(server.fleet.getBatch(b.id)?.items[0].status).toBe('unknown');
      await waitFor(() => server!.fleet.getTurtle(t.turtleId!)?.connection === 'online', 10000, 'reconnect');
      await waitFor(() => server!.fleet.getBatch(b.id)?.items[0].status === 'succeeded', 5000, 'reconciled after restart');
      expect(cmdId).toBeTruthy();
      expect(server.fleet.getTurtle(t.turtleId!)?.state?.pose.pos).toEqual({ x: 0, y: 100, z: -1 });
    } finally {
      for (const t of turtles.splice(0)) t.stop();
      await server?.close();
      server = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Geo Scanner scans', () => {
  it('accept blocks within the scan radius only, and mark air only from complete scans', async () => {
    server = await startServer();
    const world = openWorld();
    for (let x = -4; x <= 4; x++) for (let y = 96; y <= 104; y++) for (let z = -4; z <= 4; z++) world.set(x, y, z, { name: 'minecraft:stone' });
    world.set(0, 100, 0, null);
    world.set(2, 100, 0, null);
    const t = await spawn(server, world, { x: 0, y: 100, z: 0, heading: 0 }, { opMs: 5, upgrades: { right: 'geoScanner' } });
    const id = t.turtleId!;
    expect(server.fleet.observe(id, [{ x: 3, y: 100, z: 0, name: 'minecraft:stone' }])).toEqual({ accepted: 0, rejected: 1 });
    expect(server.fleet.observe(id, [{ x: 3, y: 100, z: 0, name: 'minecraft:stone' }, { x: 9, y: 100, z: 0, name: 'minecraft:stone' }], 4)).toEqual({ accepted: 1, rejected: 1 });
    // The map wrongly thinks (2 100 0) is stone; a scan that loses a batch must not "fix" anything.
    server.fleet.importObservations('sim', 'minecraft:overworld', [{ x: 2, y: 100, z: 0, name: 'minecraft:stone' }], 'test');
    const sim = t as unknown as { send: (m: { type: string; scan?: unknown }) => void };
    const send = sim.send.bind(t);
    let dropped = false;
    sim.send = (m) => {
      if (m.type === 'observe' && m.scan && !dropped) {
        dropped = true;
        return;
      }
      send(m);
    };
    expect((await settle(server, server.fleet.issueCommand({ turtleIds: [id] }, 'geoScan', { radius: 4 }).id)).items[0].status).toBe('succeeded');
    expect(server.fleet.mapCell('sim', 'minecraft:overworld', { x: 2, y: 100, z: 0 })?.cell).toBe('solid');
    expect(server.fleet.recentEvents(50).some((e) => e.message.includes('not marking air'))).toBe(true);
    // A complete scan does.
    sim.send = send;
    await new Promise((r) => setTimeout(r, 60));
    expect((await settle(server, server.fleet.issueCommand({ turtleIds: [id] }, 'geoScan', { radius: 4 }).id)).items[0].status).toBe('succeeded');
    await waitFor(() => server!.fleet.mapCell('sim', 'minecraft:overworld', { x: 2, y: 100, z: 0 })?.cell === 'empty', 3000, 'air marked');
  });
});
