/**
 * A simulated turtle agent. It speaks exactly the protocol the Lua agent speaks and
 * follows the same rules:
 *   - one command at a time; refuse while busy or held
 *   - persist a movement journal BEFORE moving, and the result AFTER
 *   - on boot, reconcile an interrupted move using the fuel level as evidence
 *   - remember recent command IDs so a re-delivered command is not run twice
 *   - after a lost connection, finish the current atomic op and then do nothing
 *
 * The physical turtle (TurtleBody, owned by the SimWorld) is separate from the agent's
 * memory, so a simulated reboot can lose memory while the body keeps its real position.
 */
import WebSocket from 'ws';
import {
  type BlockObservation,
  type Heading,
  type Hold,
  type Item,
  type Op,
  type Pose,
  type RecentResult,
  type ServerToTurtle,
  type TurtleState,
  type Vec3,
  type Activity,
  type ErrorCode,
  MAX_RECENT_RESULTS,
  MOVE_OPS,
  PHYSICAL_OPS,
  PROTOCOL_VERSION,
  TURN_OPS,
  addVec,
  classifyReason,
  parseOpArgs,
  stepFor,
  turned,
} from '@ccfleet/protocol';
import { SimWorld, type TurtleBody, type SimItem } from './world';

export const SIM_AGENT_VERSION = 'sim-0.1.0';

export interface Journal {
  commandId: string;
  op: Op;
  from: Vec3;
  to?: Vec3;
  fromHeading?: Heading;
  fuelBefore: number | 'unlimited';
}

export interface AgentMemory {
  creds?: { turtleId: string; secret: string };
  pose: Pose;
  journal?: Journal;
  recent: (RecentResult & { code?: string; reason?: string })[];
  hold?: Hold;
}

export interface MemoryStore {
  load(): AgentMemory | undefined;
  save(m: AgentMemory): void;
}

export class InMemoryStore implements MemoryStore {
  private data?: string;
  load() {
    return this.data ? (JSON.parse(this.data) as AgentMemory) : undefined;
  }
  save(m: AgentMemory) {
    this.data = JSON.stringify(m);
  }
}

export interface SimTurtleOptions {
  world: SimWorld;
  body: TurtleBody;
  store: MemoryStore;
  serverUrl: string; // ws://host:port/ws/turtle
  computerId: number;
  label?: string;
  enrollCode?: string;
  /** Duration of a move/turn/dig in ms. A real turtle takes ~400 ms (8 ticks). */
  opMs?: number;
  /** Known starting pose (as if the operator calibrated it). */
  initialPose?: Pose;
  gps?: boolean;
  onLog?: (msg: string) => void;
  onCredentials?: (creds: { turtleId: string; secret: string }) => void;
}

/** Test hooks for failure injection. */
export interface FaultHooks {
  /** Called after a physical move succeeded but before it is persisted. Return true to "crash" there. */
  crashAfterPhysicalMove?: (op: Op) => boolean;
  /** Return true to drop the connection after an ack is sent and before the result. */
  dropBeforeResult?: (op: Op) => boolean;
}

class Crash extends Error {}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const unknownPose = (): Pose => ({ position: 'unknown', headingConfidence: 'unknown', source: 'none' });

export class SimTurtle {
  readonly world: SimWorld;
  readonly body: TurtleBody;
  readonly faults: FaultHooks = {};
  mem!: AgentMemory;
  activity: Activity = 'idle';
  lastError?: { code: string; message: string; at: number };
  name?: string;

  private ws?: WebSocket;
  private running = false;
  private connected = false;
  private busy?: { commandId: string; cancelled: boolean };
  /** Incremented on every (simulated) reboot to abandon in-flight work. */
  private generation = 0;
  private clockOffset = 0;
  private heartbeatTimer?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private backoff = 1000;
  private hbSeq = 0;
  private msgSeq = 0;
  private bootId = '';
  private scanOnMove = true;
  private opMs: number;

  constructor(private opts: SimTurtleOptions) {
    this.world = opts.world;
    this.body = opts.body;
    this.opMs = opts.opMs ?? 400;
    this.world.addOccupant(this.body);
    this.boot();
  }

  get computerId(): number {
    return this.opts.computerId;
  }

  get turtleId(): string | undefined {
    return this.mem.creds?.turtleId;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private log(m: string) {
    this.opts.onLog?.(`[sim #${this.opts.computerId}] ${m}`);
  }

  // ------------------------------------------------------------------ boot / persistence

  /** Load memory and reconcile anything interrupted by a reboot. */
  private boot(): void {
    this.generation++;
    this.busy = undefined;
    this.bootId = `${this.opts.computerId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.mem = this.opts.store.load() ?? { pose: this.opts.initialPose ?? unknownPose(), recent: [] };
    this.activity = this.mem.hold ? 'paused' : 'idle';
    const j = this.mem.journal;
    if (j) {
      this.reconcileJournal(j);
      this.mem.journal = undefined;
    }
    for (const r of this.mem.recent) if (r.status === 'running') r.status = 'unknown';
    this.persist();
  }

  private reconcileJournal(j: Journal): void {
    const fuel = this.body.fuel;
    const setRecent = (status: RecentResult['status'], reason: string) => {
      const r = this.mem.recent.find((x) => x.commandId === j.commandId);
      if (r) Object.assign(r, { status, reason });
    };
    if (MOVE_OPS.has(j.op)) {
      if (typeof fuel === 'number' && typeof j.fuelBefore === 'number') {
        if (fuel === j.fuelBefore - 1) {
          this.mem.pose = { ...this.mem.pose, pos: j.to, position: 'known', source: 'tracked', candidates: undefined };
          setRecent('succeeded', 'move completed before reboot (fuel decreased by 1)');
          this.log(`reboot: ${j.op} had completed (fuel evidence)`);
          return;
        }
        if (fuel === j.fuelBefore) {
          this.mem.pose = { ...this.mem.pose, pos: j.from, position: 'known', candidates: undefined };
          setRecent('cancelled', 'move did not happen before reboot (fuel unchanged)');
          this.log(`reboot: ${j.op} had not happened (fuel evidence)`);
          return;
        }
      }
      // Unlimited fuel or inconsistent evidence: do not guess.
      this.mem.pose = { ...this.mem.pose, pos: j.from, position: 'uncertain', candidates: j.to ? [j.from, j.to] : [j.from] };
      setRecent('unknown', 'rebooted during a move; position must be reconciled');
      this.log(`reboot: ${j.op} outcome unknown; position uncertain`);
    } else if (TURN_OPS.has(j.op)) {
      // Turning uses no fuel, so there is no evidence either way.
      this.mem.pose = { ...this.mem.pose, headingConfidence: 'uncertain' };
      setRecent('unknown', 'rebooted during a turn; heading must be recalibrated');
      this.log('reboot: heading uncertain');
    }
  }

  private persist(): void {
    this.opts.store.save(this.mem);
  }

  // ------------------------------------------------------------------ connection

  start(): void {
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.reconnectTimer);
    this.teardown();
    this.ws?.close();
  }

  /** Simulate a crash/reboot: memory reloads from the store, the body stays where it is. */
  reboot(): void {
    const wasRunning = this.running;
    this.stop();
    this.boot();
    if (wasRunning) this.start();
  }

  /** Drop the network link without rebooting (e.g. server restart, chunk unload, wifi blip). */
  dropConnection(): void {
    this.ws?.terminate();
  }

  private teardown(): void {
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.watchdog);
    this.connected = false;
  }

  private connect(): void {
    if (!this.running) return;
    const ws = new WebSocket(this.opts.serverUrl);
    this.ws = ws;
    ws.on('open', () => {
      if (this.mem.creds) this.sendHello();
      else if (this.opts.enrollCode) {
        this.send({ type: 'enroll', code: this.opts.enrollCode, computerId: this.opts.computerId, label: this.opts.label, agent: { kind: 'sim', version: SIM_AGENT_VERSION } });
      } else {
        this.log('no credentials and no pairing code; cannot connect');
        this.running = false;
        ws.close();
      }
    });
    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.teardown();
      if (this.running) this.scheduleReconnect();
    });
    ws.on('error', () => {
      /* close follows */
    });
  }

  private scheduleReconnect(): void {
    const delay = this.backoff * (0.75 + Math.random() * 0.5);
    this.backoff = Math.min(this.backoff * 2, 30_000);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private kickWatchdog(): void {
    clearTimeout(this.watchdog);
    // No traffic for 3 heartbeats: assume the link is dead.
    this.watchdog = setTimeout(() => this.ws?.terminate(), 20_000);
  }

  private send(body: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id: `${this.opts.computerId}-${++this.msgSeq}`, ts: Date.now(), ...body }));
  }

  private sendHello(): void {
    this.send({
      type: 'hello',
      turtleId: this.mem.creds!.turtleId,
      secret: this.mem.creds!.secret,
      computerId: this.opts.computerId,
      label: this.opts.label,
      agent: { kind: 'sim', version: SIM_AGENT_VERSION },
      bootId: this.bootId,
      recent: this.mem.recent.map(({ commandId, status }) => ({ commandId, status })),
    });
  }

  state(): TurtleState {
    const inventory: Item[] = [];
    this.body.slots.forEach((s, i) => s && inventory.push({ slot: i + 1, name: s.name, count: s.count }));
    return {
      pose: this.mem.pose,
      fuel: this.body.fuel,
      fuelLimit: this.body.fuelLimit,
      selectedSlot: this.body.selected,
      inventory,
      activity: this.activity,
      hold: this.mem.hold,
      currentCommandId: this.busy?.commandId,
      lastError: this.lastError,
    };
  }

  private sendSnapshot(): void {
    this.send({ type: 'snapshot', state: this.state() });
  }

  private onMessage(raw: string): void {
    let msg: ServerToTurtle;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.v !== PROTOCOL_VERSION) return;
    this.kickWatchdog();
    switch (msg.type) {
      case 'enrolled':
        this.mem.creds = { turtleId: msg.turtleId, secret: msg.secret };
        this.name = msg.name;
        this.persist();
        this.opts.onCredentials?.(this.mem.creds);
        this.sendHello();
        break;
      case 'welcome':
        this.connected = true;
        this.backoff = 1000;
        this.name = msg.name;
        this.clockOffset = msg.serverTime - Date.now();
        this.scanOnMove = msg.config.scanOnMove;
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => this.send({ type: 'hb', seq: ++this.hbSeq, fuel: this.body.fuel }), msg.heartbeatMs);
        this.sendSnapshot();
        break;
      case 'denied':
        this.log(`server denied: ${msg.reason}`);
        if (msg.reason.includes('credentials') || msg.reason.includes('pairing')) this.running = false;
        break;
      case 'cmd':
        void this.onCommand(msg);
        break;
      case 'cancel':
        if (this.busy?.commandId === msg.commandId) this.busy.cancelled = true;
        break;
      case 'stop':
        this.mem.hold = { stopId: msg.stopId, reason: msg.reason };
        this.persist();
        this.send({ type: 'stop_ack', stopId: msg.stopId, ...(this.busy ? { finishing: this.busy.commandId } : {}) });
        if (!this.busy) {
          this.activity = 'paused';
          this.sendSnapshot();
        }
        break;
      case 'release':
        if (this.mem.hold) {
          this.mem.hold = undefined;
          this.persist();
          if (!this.busy) this.activity = 'idle';
        }
        this.send({ type: 'released', stopId: msg.stopId });
        this.sendSnapshot();
        break;
      case 'hb_ack':
        break;
    }
  }

  private remember(commandId: string, status: RecentResult['status'], code?: string, reason?: string): void {
    const existing = this.mem.recent.find((r) => r.commandId === commandId);
    if (existing) Object.assign(existing, { status, code, reason });
    else {
      this.mem.recent.push({ commandId, status, code, reason });
      while (this.mem.recent.length > MAX_RECENT_RESULTS) this.mem.recent.shift();
    }
  }

  private async onCommand(msg: Extract<ServerToTurtle, { type: 'cmd' }>): Promise<void> {
    const seen = this.mem.recent.find((r) => r.commandId === msg.commandId);
    if (seen) {
      // Duplicate delivery: never execute twice.
      if (seen.status === 'running') this.send({ type: 'ack', commandId: msg.commandId, status: 'duplicate' });
      else if (seen.status === 'succeeded' || seen.status === 'failed' || seen.status === 'cancelled') {
        this.send({ type: 'result', commandId: msg.commandId, status: seen.status, code: seen.code, reason: seen.reason, duplicate: true });
      } else this.send({ type: 'ack', commandId: msg.commandId, status: 'rejected', code: 'invalid', reason: `already seen (${seen.status})` });
      return;
    }
    const reject = (code: ErrorCode, reason: string, remember = true) => {
      if (remember) {
        this.remember(msg.commandId, 'rejected', code, reason);
        this.persist();
      }
      this.send({ type: 'ack', commandId: msg.commandId, status: 'rejected', code, reason });
    };
    if (this.busy) return reject('busy', 'another command is running', false);
    if (Date.now() + this.clockOffset > msg.expiresAt) return reject('expired', 'command expired before it started');
    if (this.mem.hold && PHYSICAL_OPS.has(msg.op)) return reject('held', `held (${this.mem.hold.reason})`);
    const parsed = parseOpArgs(msg.op, msg.args);
    if (!parsed.ok) return reject('invalid', parsed.error);

    const gen = this.generation;
    this.busy = { commandId: msg.commandId, cancelled: false };
    this.remember(msg.commandId, 'running');
    this.persist();
    this.send({ type: 'ack', commandId: msg.commandId, status: 'accepted' });
    if (this.faults.dropBeforeResult?.(msg.op)) {
      this.ws?.terminate();
    }
    this.activity = 'working';

    let outcome: { ok: boolean; code?: ErrorCode; reason?: string; data?: Record<string, unknown> };
    try {
      await sleep(0); // allow an immediate cancel to arrive
      if (this.busy?.cancelled) outcome = { ok: false, code: 'failed', reason: 'cancelled' };
      else outcome = await this.execute(msg.commandId, msg.op, parsed.args, gen);
    } catch (e) {
      if (e instanceof Crash) {
        // Injected crash: the computer restarts. A crash caused by reboot() itself is already handled.
        if (gen === this.generation) this.reboot();
        return;
      }
      outcome = { ok: false, code: 'internal', reason: (e as Error).message };
    }
    if (gen !== this.generation) return;
    const cancelled = !outcome.ok && outcome.reason === 'cancelled';
    const status = outcome.ok ? 'succeeded' : cancelled ? 'cancelled' : 'failed';
    this.remember(msg.commandId, status, outcome.code, outcome.reason);
    this.busy = undefined;
    this.activity = this.mem.hold ? 'paused' : outcome.code === 'obstructed' ? 'blocked' : 'idle';
    if (!outcome.ok && !cancelled) this.lastError = { code: outcome.code ?? 'failed', message: outcome.reason ?? 'failed', at: Date.now() };
    this.persist();
    this.sendSnapshot();
    this.send({ type: 'result', commandId: msg.commandId, status, code: outcome.code, reason: outcome.reason, data: outcome.data });
  }

  // ------------------------------------------------------------------ operations

  private async physical(gen: number, ms = this.opMs): Promise<void> {
    await sleep(ms);
    if (gen !== this.generation) throw new Crash();
  }

  private async execute(commandId: string, op: Op, args: Record<string, unknown>, gen: number): Promise<{ ok: boolean; code?: ErrorCode; reason?: string; data?: Record<string, unknown> }> {
    const b = this.body;
    if (MOVE_OPS.has(op)) {
      if (b.fuel !== 'unlimited' && b.fuel <= 0) return { ok: false, code: 'out_of_fuel', reason: 'Out of fuel' };
      const pose = this.mem.pose;
      const step = stepFor(op, b.heading)!; // physics uses the true heading
      const beliefStep = pose.heading !== undefined ? stepFor(op, pose.heading as Heading) : undefined;
      const believedTo = pose.pos && beliefStep ? addVec(pose.pos, beliefStep) : undefined;
      this.mem.journal = { commandId, op, from: pose.pos ?? b.pos, to: believedTo, fuelBefore: b.fuel };
      this.persist();
      await this.physical(gen);
      const to = addVec(b.pos, step);
      if (to.y > 255) return this.clearJournal({ ok: false, code: 'failed', reason: 'Too high to move' });
      if (to.y < 0) return this.clearJournal({ ok: false, code: 'failed', reason: 'Too low to move' });
      if (!this.world.passable(to)) return this.clearJournal({ ok: false, code: 'obstructed', reason: 'Movement obstructed' });
      this.world.moveOccupant(b, to);
      if (b.fuel !== 'unlimited') b.fuel -= 1;
      if (this.faults.crashAfterPhysicalMove?.(op)) {
        throw new Crash();
      }
      const knownHeading = pose.headingConfidence === 'known';
      if (believedTo && pose.position === 'known' && (knownHeading || op === 'up' || op === 'down')) {
        this.mem.pose = { ...pose, pos: believedTo, source: pose.source === 'none' ? 'tracked' : pose.source };
      } else if (pose.pos) {
        this.mem.pose = { ...pose, position: 'uncertain' };
      }
      this.mem.journal = undefined;
      this.persist();
      this.sendSnapshot(); // the server checks observations against the latest pose
      if (this.scanOnMove) await this.scan(gen, ['front', 'up', 'down']);
      return { ok: true };
    }
    if (TURN_OPS.has(op)) {
      const pose = this.mem.pose;
      this.mem.journal = { commandId, op, from: pose.pos ?? b.pos, fromHeading: pose.heading as Heading | undefined, fuelBefore: b.fuel };
      this.persist();
      await this.physical(gen);
      b.heading = turned(b.heading, op as 'turnLeft' | 'turnRight');
      if (pose.heading !== undefined) this.mem.pose = { ...pose, heading: turned(pose.heading as Heading, op as 'turnLeft' | 'turnRight') };
      this.mem.journal = undefined;
      this.persist();
      this.sendSnapshot();
      if (this.scanOnMove) await this.scan(gen, ['front']);
      return { ok: true };
    }
    switch (op) {
      case 'dig':
      case 'digUp':
      case 'digDown': {
        const dir = op === 'dig' ? 'front' : op === 'digUp' ? 'up' : 'down';
        await this.physical(gen);
        const p = this.adjacent(dir, true);
        const block = this.world.get(p.x, p.y, p.z);
        if (!block || this.world.isFluid(block)) return { ok: false, code: 'nothing_to_dig', reason: 'Nothing to dig here' };
        if (SimWorld.isUnbreakable(block)) return { ok: false, code: 'unbreakable', reason: 'Unbreakable block detected' };
        const drop = this.world.breakBlock(p);
        if (drop) this.addItem(drop);
        await this.scan(gen, [dir]);
        return { ok: true, data: { block: block.name } };
      }
      case 'inspect':
      case 'inspectUp':
      case 'inspectDown': {
        const dir = op === 'inspect' ? 'front' : op === 'inspectUp' ? 'up' : 'down';
        const obs = await this.scan(gen, [dir]);
        const block = this.world.get(...xyz(this.adjacent(dir, true)));
        return { ok: true, data: block ? { name: block.name, state: block.state ?? {} } : { name: null, observed: obs.length > 0 } };
      }
      case 'select':
        b.selected = args.slot as number;
        return { ok: true };
      case 'refuel': {
        const slot = b.slots[b.selected - 1];
        const value = slot ? SimWorld.fuelValue(slot.name) : 0;
        if (!slot || value === 0) return { ok: false, code: 'failed', reason: 'Items not combustible' };
        if (b.fuel === 'unlimited' || b.fuelLimit === 'unlimited') return { ok: true };
        const want = (args.count as number | undefined) ?? slot.count;
        let used = 0;
        while (used < want && used < slot.count && b.fuel + value <= b.fuelLimit) {
          b.fuel += value;
          used++;
        }
        if (want === 0) return { ok: true, data: { fuel: b.fuel } };
        slot.count -= used;
        if (slot.count === 0) b.slots[b.selected - 1] = null;
        if (used === 0) return { ok: false, code: 'failed', reason: 'Fuel limit reached' };
        return { ok: true, data: { fuel: b.fuel, used } };
      }
      case 'calibrate': {
        const pos = { x: args.x as number, y: args.y as number, z: args.z as number };
        this.mem.pose = { pos, heading: args.heading as Heading, position: 'known', headingConfidence: 'known', source: 'manual' };
        this.persist();
        return { ok: true };
      }
      case 'gpsLocate': {
        await this.physical(gen, 100);
        if (!this.opts.gps) return { ok: false, code: 'no_gps', reason: 'Could not determine position (no GPS hosts in range)' };
        const pos = { ...b.pos };
        const before = this.mem.pose;
        const agrees = before.pos && before.pos.x === pos.x && before.pos.y === pos.y && before.pos.z === pos.z;
        // GPS fixes position only. Heading stays whatever it was.
        this.mem.pose = { ...before, pos, position: 'known', source: 'gps', candidates: undefined };
        this.persist();
        return { ok: true, data: { ...pos, agreedWithTracking: !!agrees } };
      }
      case 'setLabel':
        this.opts.label = args.label as string;
        return { ok: true };
      default:
        return { ok: false, code: 'invalid', reason: `unsupported op ${op}` };
    }
  }

  private clearJournal<T>(r: T): T {
    this.mem.journal = undefined;
    this.persist();
    return r;
  }

  /** Cell next to the turtle. `truth` = physical cell; otherwise the agent's belief. */
  private adjacent(dir: 'front' | 'up' | 'down', truth: boolean): Vec3 {
    const pos = truth ? this.body.pos : this.mem.pose.pos!;
    const heading = truth ? this.body.heading : (this.mem.pose.heading as Heading);
    if (dir === 'up') return { ...pos, y: pos.y + 1 };
    if (dir === 'down') return { ...pos, y: pos.y - 1 };
    return addVec(pos, stepFor('forward', heading)!);
  }

  /** Inspect directions and report observations (only when the agent knows its pose). */
  private async scan(gen: number, dirs: ('front' | 'up' | 'down')[]): Promise<BlockObservation[]> {
    const out: BlockObservation[] = [];
    const pose = this.mem.pose;
    const canReport = pose.position === 'known' && pose.pos && (pose.headingConfidence === 'known' || dirs.every((d) => d !== 'front'));
    for (const dir of dirs) {
      await this.physical(gen, Math.max(1, this.opMs / 8)); // inspect takes about a tick
      if (!canReport) continue;
      const truth = this.adjacent(dir, true);
      const believed = this.adjacent(dir, false);
      const block = this.world.get(truth.x, truth.y, truth.z);
      const occupant = this.world.occupants.get(`${truth.x},${truth.y},${truth.z}`);
      if (occupant) continue; // another turtle: CC reports it as a block, but it moves; do not map it
      out.push({ ...believed, ...(block ? { name: block.name, ...(block.state ? { state: block.state } : {}) } : {}) });
    }
    if (out.length) this.send({ type: 'observe', blocks: out });
    return out;
  }

  /** Put an item in the inventory like a turtle does: selected slot first, then wrap around. */
  private addItem(item: SimItem): void {
    const slots = this.body.slots;
    let left = item.count;
    const order = Array.from({ length: 16 }, (_, i) => (this.body.selected - 1 + i) % 16);
    for (const i of order) {
      const s = slots[i];
      if (s && s.name === item.name && s.count < 64) {
        const n = Math.min(64 - s.count, left);
        s.count += n;
        left -= n;
        if (!left) return;
      }
    }
    for (const i of order) {
      if (!slots[i]) {
        slots[i] = { name: item.name, count: left };
        return;
      }
    }
    this.world.spilled += left; // no room: the item drops into the world
  }
}

function xyz(p: Vec3): [number, number, number] {
  return [p.x, p.y, p.z];
}
