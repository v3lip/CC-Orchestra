/**
 * Fleet: the authoritative in-memory model of all turtles, their connections,
 * command queues, stops and groups, backed by SQLite.
 *
 * Execution model: the server dispatches at most ONE command per turtle at a time
 * and waits for its result before sending the next. The agent independently
 * refuses commands while busy or held, so a bug on one side cannot cause two
 * concurrent executors.
 */
import {
  isOreBlock,
  type BatchItem,
  type BatchView,
  type BlockObservation,
  type CmdMsg,
  type CommandStatus,
  type Connection,
  type DisplayStatus,
  type EventView,
  type DepotView,
  type ForcedChunk,
  type GroupView,
  type JobView,
  GEO_SCAN_MAX_RADIUS,
  type MapBlock,
  type Op,
  type RecentResult,
  type ServerToTurtle,
  type StopReason,
  type Targets,
  type TurtleState,
  type TurtleView,
  type UiServerMsg,
  type Vec3,
  COMMAND_RESULT_TIMEOUT_MS,
  DEFAULT_PROTECTED_BLOCKS,
  DEFAULT_COMMAND_TTL_MS,
  FLUID_BLOCKS,
  HEARTBEAT_INTERVAL_MS,
  MAX_QUEUED_COMMANDS,
  OFFLINE_AFTER_MS,
  PHYSICAL_OPS,
  PROTOCOL_VERSION,
  STALE_AFTER_MS,
  TERMINAL_STATUSES,
  parseOpArgs,
} from '@ccfleet/protocol';
import type { Db } from './db';
import { tx } from './db';
import { runningCode } from './codeVersion';
import { digestEquals, newId, normalizeCode, now, pairingCode, randomToken, sha256 } from './util';

/** Commands and batches older than this are deleted (hourly). */
const KEEP_HISTORY_MS = 2 * 24 * 3600_000;
/** The activity log keeps this many entries. */
const KEEP_EVENTS = 20_000;
const PRUNE_EVERY_MS = 3600_000;

export interface TurtleConn {
  send(msg: ServerToTurtle): void;
  close(code?: number, reason?: string): void;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface CommandRec {
  id: string;
  batchId: string;
  turtleId: string;
  op: Op;
  args: Record<string, unknown>;
  executor: string;
  status: CommandStatus;
  code?: string;
  reason?: string;
  data?: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
  sentAt?: number;
}

interface TurtleRec {
  id: string;
  name: string;
  label?: string;
  computerId: number;
  world: string;
  dimension: string;
  simulated: boolean;
  agentVersion?: string;
  createdAt: number;
  lastSeen?: number;
  state?: TurtleState;
  pendingStop?: StopReason;
  conn?: TurtleConn;
  bootId?: string;
  lastHeartbeat: number;
  staleNotified: boolean;
  queue: CommandRec[];
  inflight?: CommandRec;
  /** Stop batch awaiting acknowledgement from this turtle. */
  stopWait?: { batchId: string; stopId: string; acked: boolean };
  releaseWait?: { batchId: string; stopId: string };
  saveTimer?: NodeJS.Timeout;
  /** Set on connect; cleared (and hooks.online called) on the first snapshot. */
  awaitingSnapshot?: boolean;
}

export interface StepResult {
  status: CommandStatus;
  code?: string;
  reason?: string;
  data?: Record<string, unknown>;
}

/** Hooks the job manager registers to keep jobs and manual control from overlapping. */
export interface FleetHooks {
  /** Manual commands, stops or cancels were issued to these turtles. */
  operatorAction?(turtleIds: string[], kind: 'command' | 'stop' | 'cancel'): void;
  disconnected?(turtleId: string): void;
  /** First full snapshot after a (re)connect: the turtle's state is current again. */
  online?(turtleId: string): void;
  removed?(turtleId: string): void;
  /** Job summary for a turtle's view. */
  jobOf?(turtleId: string): TurtleView['job'];
  /** One-off task (e.g. go-to) for a turtle's view. */
  taskOf?(turtleId: string): TurtleView['task'];
  extraInit?(): { jobs: JobView[]; depots: DepotView[]; forcedChunks: ForcedChunk[] };
}

export interface FleetOptions {
  staleMs?: number;
  offlineMs?: number;
  resultTimeoutMs?: number;
  tickMs?: number;
  heartbeatMs?: number;
}

export interface EnrollmentRequest {
  name?: string;
  world?: string;
  dimension?: string;
  groupId?: string;
  simulated?: boolean;
  ttlMinutes?: number;
}

const GROUP_COLORS = ['#22d3ee', '#a78bfa', '#f472b6', '#facc15', '#4ade80', '#fb923c', '#60a5fa', '#f87171'];
const MAX_RECENT_COMMANDS = 1000;
const MAX_BATCHES_IN_MEMORY = 50;

export class Fleet {
  private turtles = new Map<string, TurtleRec>();
  private groups = new Map<string, GroupView>();
  private batches = new Map<string, BatchView>();
  /** Recently finished commands, so late or duplicate results can be matched. */
  private recentCommands = new Map<string, CommandRec>();
  private listeners = new Set<(m: UiServerMsg) => void>();
  private dirtyTurtles = new Set<string>();
  private mapBuffer = new Map<string, MapBlock[]>();
  private timers: NodeJS.Timeout[] = [];
  private opts: Required<FleetOptions>;
  private stepWaiters = new Map<string, (r: StepResult) => void>();
  hooks: FleetHooks = {};

  constructor(
    private db: Db,
    opts: FleetOptions = {},
  ) {
    this.opts = {
      staleMs: opts.staleMs ?? STALE_AFTER_MS,
      offlineMs: opts.offlineMs ?? OFFLINE_AFTER_MS,
      resultTimeoutMs: opts.resultTimeoutMs ?? COMMAND_RESULT_TIMEOUT_MS,
      tickMs: opts.tickMs ?? 1000,
      heartbeatMs: opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS,
    };
    this.load();
    this.prune();
    this.timers.push(setInterval(() => this.tick(), this.opts.tickMs));
    this.timers.push(setInterval(() => this.flush(), 100));
    this.timers.push(setInterval(() => this.prune(), PRUNE_EVERY_MS));
  }

  /**
   * Drop old history: every atomic turtle action is a command row (~90k a day while
   * mining). Only recent commands are ever read back (late results, reconnects).
   */
  prune(t = now()): { commands: number; batches: number; events: number } {
    if (this.closed) return { commands: 0, batches: 0, events: 0 };
    const before = t - KEEP_HISTORY_MS;
    const commands = Number(this.db.prepare('DELETE FROM commands WHERE created_at < ?').run(before).changes);
    const batches = Number(this.db.prepare('DELETE FROM batches WHERE created_at < ?').run(before).changes);
    const events = Number(
      this.db.prepare('DELETE FROM events WHERE id <= (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?)').run(KEEP_EVENTS).changes,
    );
    return { commands, batches, events };
  }

  closed = false;

  close(): void {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    for (const rec of this.turtles.values()) {
      if (rec.saveTimer) clearTimeout(rec.saveTimer);
      this.saveState(rec);
      rec.conn?.close(1001, 'server shutting down');
    }
    this.flush();
  }

  // ------------------------------------------------------------ subscriptions

  subscribe(fn: (m: UiServerMsg) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  broadcast(m: UiServerMsg): void {
    for (const fn of this.listeners) fn(m);
  }

  private flush(): void {
    for (const id of this.dirtyTurtles) {
      const rec = this.turtles.get(id);
      if (rec) this.broadcast({ type: 'turtle', turtle: this.view(rec) });
    }
    this.dirtyTurtles.clear();
    for (const [key, blocks] of this.mapBuffer) {
      const [world, dimension] = key.split('\u0000');
      this.broadcast({ type: 'map', world, dimension, blocks });
    }
    this.mapBuffer.clear();
  }

  private touch(rec: TurtleRec): void {
    this.dirtyTurtles.add(rec.id);
  }

  /** Re-broadcast a turtle's view (e.g. after its job changed). */
  touchTurtle(id: string): void {
    this.dirtyTurtles.add(id);
  }

  initMessage(): UiServerMsg {
    return {
      type: 'init',
      turtles: [...this.turtles.values()].map((r) => this.view(r)),
      groups: [...this.groups.values()],
      batches: [...this.batches.values()].sort((a, b) => b.createdAt - a.createdAt),
      events: this.recentEvents(200),
      ...(this.hooks.extraInit?.() ?? { jobs: [], depots: [], forcedChunks: [] }),
      server: runningCode(),
    };
  }

  // ------------------------------------------------------------ loading / persistence

  private load(): void {
    const rows = this.db.prepare('SELECT * FROM turtles WHERE revoked_at IS NULL').all() as Record<string, unknown>[];
    for (const r of rows) {
      const rec: TurtleRec = {
        id: r.id as string,
        name: r.name as string,
        label: (r.label as string) ?? undefined,
        computerId: r.computer_id as number,
        world: r.world as string,
        dimension: r.dimension as string,
        simulated: !!r.simulated,
        agentVersion: (r.agent_version as string) ?? undefined,
        createdAt: r.created_at as number,
        lastSeen: (r.last_seen as number) ?? undefined,
        state: r.state_json ? (JSON.parse(r.state_json as string) as TurtleState) : undefined,
        pendingStop: (r.pending_stop as StopReason) ?? undefined,
        lastHeartbeat: 0,
        staleNotified: false,
        queue: [],
      };
      if (rec.state) rec.state.currentCommandId = undefined;
      this.turtles.set(rec.id, rec);
    }
    for (const g of this.db.prepare('SELECT * FROM groups ORDER BY name').all() as Record<string, unknown>[]) {
      this.groups.set(g.id as string, { id: g.id as string, name: g.name as string, color: g.color as string, memberIds: [] });
    }
    for (const m of this.db.prepare('SELECT * FROM group_members').all() as { group_id: string; turtle_id: string }[]) {
      this.groups.get(m.group_id)?.memberIds.push(m.turtle_id);
    }
    // Anything in flight when the server stopped has an unknown outcome.
    const t = now();
    this.db
      .prepare(`UPDATE commands SET status='unknown', reason='server restarted before a result arrived', updated_at=? WHERE status IN ('sent','running')`)
      .run(t);
    this.db.prepare(`UPDATE commands SET status='cancelled', reason='server restarted', updated_at=? WHERE status='queued'`).run(t);
    for (const b of this.db.prepare('SELECT * FROM batches ORDER BY created_at DESC LIMIT ?').all(MAX_BATCHES_IN_MEMORY) as Record<string, unknown>[]) {
      const items = JSON.parse(b.items_json as string) as BatchItem[];
      for (const it of items) {
        if (it.status === 'queued') it.status = 'cancelled';
        if (it.status === 'sent' || it.status === 'running') it.status = 'unknown';
      }
      this.batches.set(b.id as string, {
        id: b.id as string,
        kind: b.kind as BatchView['kind'],
        op: (b.op as string) ?? undefined,
        args: b.args_json ? JSON.parse(b.args_json as string) : undefined,
        label: b.label as string,
        createdAt: b.created_at as number,
        items,
      });
    }
  }

  private scheduleSave(rec: TurtleRec): void {
    if (rec.saveTimer) return;
    rec.saveTimer = setTimeout(() => {
      rec.saveTimer = undefined;
      this.saveState(rec);
    }, 1000);
  }

  private saveState(rec: TurtleRec): void {
    this.db
      .prepare('UPDATE turtles SET state_json=?, last_seen=?, pending_stop=?, label=?, agent_version=? WHERE id=?')
      .run(rec.state ? JSON.stringify(rec.state) : null, rec.lastSeen ?? null, rec.pendingStop ?? null, rec.label ?? null, rec.agentVersion ?? null, rec.id);
  }

  // ------------------------------------------------------------ events

  log(level: EventView['level'], message: string, turtleId?: string): void {
    if (this.closed) return;
    const ts = now();
    const r = this.db.prepare('INSERT INTO events (ts, level, turtle_id, message) VALUES (?,?,?,?)').run(ts, level, turtleId ?? null, message);
    this.broadcast({ type: 'event', event: { id: Number(r.lastInsertRowid), ts, level, turtleId, message } });
  }

  recentEvents(limit: number): EventView[] {
    const rows = this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      ts: r.ts as number,
      level: r.level as EventView['level'],
      turtleId: (r.turtle_id as string) ?? undefined,
      message: r.message as string,
    }));
  }

  // ------------------------------------------------------------ views

  connection(rec: TurtleRec): Connection {
    if (!rec.conn) return 'offline';
    return now() - rec.lastHeartbeat > this.opts.staleMs ? 'stale' : 'online';
  }

  view(rec: TurtleRec): TurtleView {
    const connection = this.connection(rec);
    const job = this.hooks.jobOf?.(rec.id);
    const task = this.hooks.taskOf?.(rec.id);
    let status: DisplayStatus = connection === 'online' ? (rec.state?.activity ?? 'idle') : connection;
    if (connection === 'online' && !rec.state?.hold && job?.status === 'running') {
      status = job.phase === 'returning' ? 'returning' : job.phase === 'unloading' || job.phase === 'refueling' ? 'unloading' : 'working';
    } else if (connection === 'online' && !rec.state?.hold && task) {
      status = 'working';
    }
    return {
      id: rec.id,
      name: rec.name,
      label: rec.label,
      computerId: rec.computerId,
      world: rec.world,
      dimension: rec.dimension,
      simulated: rec.simulated,
      agentVersion: rec.agentVersion,
      connection,
      status,
      state: rec.state,
      queueLength: rec.queue.length + (rec.inflight ? 1 : 0),
      pendingStop: !!rec.pendingStop,
      job,
      task,
      lastSeen: rec.lastSeen,
      groupIds: [...this.groups.values()].filter((g) => g.memberIds.includes(rec.id)).map((g) => g.id),
      createdAt: rec.createdAt,
    };
  }

  listTurtles(): TurtleView[] {
    return [...this.turtles.values()].map((r) => this.view(r));
  }

  getTurtle(id: string): TurtleView | undefined {
    const rec = this.turtles.get(id);
    return rec && this.view(rec);
  }

  listGroups(): GroupView[] {
    return [...this.groups.values()];
  }

  getBatch(id: string): BatchView | undefined {
    return this.batches.get(id);
  }

  // ------------------------------------------------------------ enrollment

  createEnrollment(req: EnrollmentRequest): { code: string; expiresAt: number } {
    if (req.groupId && !this.groups.has(req.groupId)) throw new ApiError(400, 'unknown group');
    const code = pairingCode();
    const t = now();
    const expiresAt = t + Math.min(Math.max(req.ttlMinutes ?? 15, 1), 24 * 60) * 60_000;
    this.db
      .prepare('INSERT INTO enrollments (code_hash, created_at, expires_at, name, world, dimension, group_id, simulated) VALUES (?,?,?,?,?,?,?,?)')
      .run(sha256(normalizeCode(code)), t, expiresAt, req.name ?? null, req.world ?? 'main', req.dimension ?? 'minecraft:overworld', req.groupId ?? null, req.simulated ? 1 : 0);
    this.log('info', `Pairing code created${req.name ? ` for "${req.name}"` : ''} (expires in ${Math.round((expiresAt - t) / 60000)} min)`);
    return { code, expiresAt };
  }

  /** Redeem a one-time pairing code. Returns the new turtle's credentials. */
  enroll(code: string, computerId: number, label: string | undefined, agent: { kind: 'lua' | 'sim'; version: string }): { turtleId: string; secret: string; name: string } {
    const hash = sha256(normalizeCode(code));
    const t = now();
    return tx(this.db, () => {
      const e = this.db.prepare('SELECT * FROM enrollments WHERE code_hash=?').get(hash) as Record<string, unknown> | undefined;
      if (!e) throw new ApiError(403, 'invalid pairing code');
      if (e.used_at) throw new ApiError(403, 'pairing code already used');
      if ((e.expires_at as number) < t) throw new ApiError(403, 'pairing code expired');
      const turtleId = newId('t');
      const secret = randomToken(24);
      const name = (e.name as string) || label || `Turtle ${computerId}`;
      const simulated = agent.kind === 'sim' || !!e.simulated;
      this.db.prepare('UPDATE enrollments SET used_at=?, used_by=? WHERE code_hash=?').run(t, turtleId, hash);
      this.db
        .prepare('INSERT INTO turtles (id, name, secret_hash, computer_id, label, world, dimension, simulated, agent_version, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(turtleId, name, sha256(secret), computerId, label ?? null, e.world as string, e.dimension as string, simulated ? 1 : 0, agent.version, t);
      const rec: TurtleRec = {
        id: turtleId,
        name,
        label,
        computerId,
        world: e.world as string,
        dimension: e.dimension as string,
        simulated,
        agentVersion: agent.version,
        createdAt: t,
        lastHeartbeat: 0,
        staleNotified: false,
        queue: [],
      };
      this.turtles.set(turtleId, rec);
      if (e.group_id && this.groups.has(e.group_id as string)) {
        this.db.prepare('INSERT OR IGNORE INTO group_members (group_id, turtle_id) VALUES (?,?)').run(e.group_id as string, turtleId);
        this.groups.get(e.group_id as string)!.memberIds.push(turtleId);
        this.broadcast({ type: 'groups', groups: this.listGroups() });
      }
      this.touch(rec);
      this.log('info', `${name} enrolled (computer #${computerId}${simulated ? ', simulated' : ''})`, turtleId);
      return { turtleId, secret, name };
    });
  }

  /** Check per-turtle credentials. */
  authenticate(turtleId: string, secret: string): boolean {
    const row = this.db.prepare('SELECT secret_hash FROM turtles WHERE id=? AND revoked_at IS NULL').get(turtleId) as { secret_hash: string } | undefined;
    return !!row && digestEquals(sha256(secret), row.secret_hash);
  }

  // ------------------------------------------------------------ connections

  /** Called after a successful hello. Returns false if the turtle is unknown. */
  connect(turtleId: string, conn: TurtleConn, hello: { label?: string; agent: { version: string }; bootId: string; recent: RecentResult[] }): boolean {
    const rec = this.turtles.get(turtleId);
    if (!rec) return false;
    if (rec.conn && rec.conn !== conn) {
      rec.conn.close(4000, 'superseded by a newer connection');
      this.disconnected(rec, 'superseded');
    }
    const rebooted = rec.bootId !== undefined && rec.bootId !== hello.bootId;
    rec.conn = conn;
    rec.awaitingSnapshot = true;
    rec.bootId = hello.bootId;
    rec.label = hello.label ?? rec.label;
    rec.agentVersion = hello.agent.version;
    rec.lastHeartbeat = now();
    rec.lastSeen = rec.lastHeartbeat;
    rec.staleNotified = false;
    const t = now();
    conn.send({
      v: PROTOCOL_VERSION,
      type: 'welcome',
      id: newId('m'),
      ts: t,
      turtleId: rec.id,
      name: rec.name,
      serverTime: t,
      heartbeatMs: this.opts.heartbeatMs,
      config: { scanOnMove: true, protectedBlocks: DEFAULT_PROTECTED_BLOCKS },
    });
    this.reconcileRecent(rec, hello.recent);
    this.log('info', `${rec.name} connected${rebooted ? ' (rebooted)' : ''}`, rec.id);
    if (rec.pendingStop) {
      const reason = rec.pendingStop;
      rec.pendingStop = undefined;
      this.sendStop(rec, reason, undefined);
      this.log('warn', `${rec.name}: delivered ${reason === 'estop' ? 'emergency stop' : 'pause'} requested while it was offline`, rec.id);
    }
    this.saveState(rec);
    this.touch(rec);
    return true;
  }

  /** Resolve `unknown` command outcomes using the agent's own persisted record. */
  private reconcileRecent(rec: TurtleRec, recent: RecentResult[]): void {
    const byId = new Map(recent.map((r) => [r.commandId, r.status]));
    const pending = this.db
      .prepare(`SELECT id FROM commands WHERE turtle_id=? AND status='unknown' ORDER BY created_at DESC LIMIT 32`)
      .all(rec.id) as { id: string }[];
    for (const { id } of pending) {
      const cmd = this.recentCommands.get(id) ?? this.loadCommand(id);
      if (!cmd) continue;
      const agentStatus = byId.get(id);
      if (agentStatus === 'succeeded' || agentStatus === 'failed' || agentStatus === 'cancelled' || agentStatus === 'rejected') {
        this.setCommandStatus(cmd, { status: agentStatus, reason: `${cmd.reason ?? ''} → resolved after reconnect`.trim() });
      } else if (agentStatus === 'running' || agentStatus === 'unknown') {
        this.setCommandStatus(cmd, { status: 'unknown', reason: 'turtle restarted mid-operation; check its position confidence' });
      } else if (agentStatus === undefined && recent.length < 16) {
        // The agent keeps its 16 most recent commands. If its list is not full and the
        // command is absent, it was never started.
        this.setCommandStatus(cmd, { status: 'cancelled', reason: 'never reached the turtle' });
      }
    }
  }

  private loadCommand(id: string): CommandRec | undefined {
    const r = this.db.prepare('SELECT * FROM commands WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id,
      batchId: r.batch_id as string,
      turtleId: r.turtle_id as string,
      op: r.op as Op,
      args: JSON.parse(r.args_json as string),
      executor: r.executor as string,
      status: r.status as CommandStatus,
      code: (r.code as string) ?? undefined,
      reason: (r.reason as string) ?? undefined,
      createdAt: r.created_at as number,
      expiresAt: 0,
    };
  }

  disconnect(turtleId: string, conn: TurtleConn, why: string): void {
    const rec = this.turtles.get(turtleId);
    if (this.closed || !rec || rec.conn !== conn) return;
    this.disconnected(rec, why);
  }

  private disconnected(rec: TurtleRec, why: string): void {
    rec.conn = undefined;
    rec.lastSeen = now();
    if (rec.inflight) {
      // We cannot know whether the turtle finished it. Never assume.
      this.setCommandStatus(rec.inflight, { status: 'unknown', reason: 'connection lost before the result arrived' });
      rec.inflight = undefined;
    }
    for (const cmd of rec.queue.splice(0)) this.setCommandStatus(cmd, { status: 'cancelled', reason: 'connection lost; queued commands are not replayed' });
    if (rec.stopWait) {
      this.updateItem(rec.stopWait.batchId, rec.id, { status: rec.stopWait.acked ? 'acknowledged' : 'unreachable', reason: 'connection lost' });
      rec.stopWait = undefined;
    }
    if (rec.releaseWait) {
      this.updateItem(rec.releaseWait.batchId, rec.id, { status: 'unreachable', reason: 'connection lost before the turtle confirmed; it is still holding' });
      rec.releaseWait = undefined;
    }
    if (rec.state) rec.state.currentCommandId = undefined;
    this.saveState(rec);
    this.log('warn', `${rec.name} disconnected (${why}); last known position is still treated as occupied`, rec.id);
    this.touch(rec);
    this.hooks.disconnected?.(rec.id);
  }

  private tick(): void {
    const t = now();
    for (const rec of this.turtles.values()) {
      if (!rec.conn) continue;
      const silent = t - rec.lastHeartbeat;
      if (silent > this.opts.offlineMs) {
        const conn = rec.conn;
        this.disconnected(rec, `no heartbeat for ${Math.round(silent / 1000)}s`);
        conn.close(4001, 'heartbeat timeout');
        continue;
      }
      if (silent > this.opts.staleMs && !rec.staleNotified) {
        rec.staleNotified = true;
        this.log('warn', `${rec.name} is stale (no heartbeat for ${Math.round(silent / 1000)}s)`, rec.id);
        this.touch(rec);
      }
      if (rec.inflight?.sentAt && t - rec.inflight.sentAt > this.opts.resultTimeoutMs) {
        this.setCommandStatus(rec.inflight, { status: 'unknown', reason: 'no result within timeout' });
        rec.inflight = undefined;
        this.pump(rec);
      }
    }
  }

  // ------------------------------------------------------------ turtle messages

  heartbeat(turtleId: string): void {
    const rec = this.turtles.get(turtleId);
    if (!rec) return;
    rec.lastHeartbeat = now();
    rec.lastSeen = rec.lastHeartbeat;
    if (rec.staleNotified) {
      rec.staleNotified = false;
      this.log('info', `${rec.name} recovered from stale`, rec.id);
    }
    this.touch(rec);
  }

  applyState(turtleId: string, patch: Partial<TurtleState>, full = false): void {
    const rec = this.turtles.get(turtleId);
    if (!rec) return;
    const prevPos = rec.state?.pose.pos;
    if (full || !rec.state) {
      if (!full && !patch.pose) return; // telemetry before snapshot: ignore
      rec.state = { ...(rec.state ?? {}), ...patch } as TurtleState;
      if (full) {
        // Snapshot is authoritative: absent optional fields really are absent.
        for (const k of ['hold', 'currentCommandId', 'lastError'] as const) if (!(k in patch)) delete rec.state[k];
      }
    } else {
      rec.state = { ...rec.state, ...patch };
    }
    const pose = rec.state.pose;
    if (pose.position === 'known' && pose.pos && (!prevPos || prevPos.x !== pose.pos.x || prevPos.y !== pose.pos.y || prevPos.z !== pose.pos.z)) {
      this.markTraversed(rec, pose.pos.x, pose.pos.y, pose.pos.z);
    }
    if (rec.stopWait?.acked && rec.state.hold && !rec.state.currentCommandId && !rec.inflight) {
      this.updateItem(rec.stopWait.batchId, rec.id, { status: 'stopped', reason: 'holding; no operation in progress' });
      rec.stopWait = undefined;
    }
    this.scheduleSave(rec);
    this.touch(rec);
    if (full && rec.awaitingSnapshot) {
      rec.awaitingSnapshot = false;
      this.hooks.online?.(rec.id);
    }
  }

  ack(turtleId: string, commandId: string, status: 'accepted' | 'rejected' | 'duplicate', code?: string, reason?: string): void {
    const rec = this.turtles.get(turtleId);
    const cmd = rec?.inflight?.id === commandId ? rec.inflight : undefined;
    if (!rec || !cmd) return;
    if (status === 'accepted') this.setCommandStatus(cmd, { status: 'running' });
    else if (status === 'rejected') {
      this.setCommandStatus(cmd, { status: 'rejected', code, reason });
      rec.inflight = undefined;
      this.pump(rec);
    }
  }

  result(turtleId: string, r: { commandId: string; status: 'succeeded' | 'failed' | 'cancelled'; code?: string; reason?: string; data?: Record<string, unknown>; duplicate?: boolean; state?: Partial<TurtleState> }): void {
    const rec = this.turtles.get(turtleId);
    if (!rec) return;
    if (r.state) this.applyState(turtleId, r.state);
    const cmd = rec.inflight?.id === r.commandId ? rec.inflight : this.recentCommands.get(r.commandId);
    if (!cmd || cmd.turtleId !== turtleId) return;
    if (TERMINAL_STATUSES.has(cmd.status) && cmd.status !== 'unknown') return; // duplicate result: already recorded
    this.setCommandStatus(cmd, {
      status: r.status,
      code: r.code,
      reason: cmd.status === 'unknown' ? `${r.reason ?? ''} (arrived late)`.trim() : r.reason,
      data: r.data,
    });
    if (r.status === 'failed') this.log('warn', `${rec.name}: ${cmd.op} failed — ${r.reason ?? r.code ?? 'unknown reason'}`, rec.id);
    if (cmd.op === 'geoScan' && r.status === 'succeeded') this.markScannedAir(rec, r.data, cmd.sentAt ?? cmd.createdAt);
    if (rec.inflight === cmd) rec.inflight = undefined;
    if (rec.stopWait?.acked) {
      this.updateItem(rec.stopWait.batchId, rec.id, { status: 'stopped', reason: `stopped after ${cmd.op} finished` });
      rec.stopWait = undefined;
    }
    this.pump(rec);
  }

  stopAck(turtleId: string, stopId: string, finishing?: string): void {
    const rec = this.turtles.get(turtleId);
    if (!rec?.stopWait || rec.stopWait.stopId !== stopId) return;
    if (finishing || rec.inflight) {
      rec.stopWait.acked = true;
      this.updateItem(rec.stopWait.batchId, rec.id, { status: 'acknowledged', reason: 'will stop when the current atomic operation finishes' });
    } else {
      this.updateItem(rec.stopWait.batchId, rec.id, { status: 'stopped', reason: 'acknowledged; was idle' });
      rec.stopWait = undefined;
    }
  }

  released(turtleId: string, stopId: string): void {
    const rec = this.turtles.get(turtleId);
    if (!rec?.releaseWait || rec.releaseWait.stopId !== stopId) return;
    this.updateItem(rec.releaseWait.batchId, rec.id, { status: 'released', reason: 'resumed' });
    rec.releaseWait = undefined;
  }

  // ------------------------------------------------------------ targets

  resolveTargets(targets: Targets): string[] {
    const ids = new Set<string>();
    if (targets.all) for (const id of this.turtles.keys()) ids.add(id);
    for (const gid of targets.groupIds ?? []) {
      const g = this.groups.get(gid);
      if (!g) throw new ApiError(400, `unknown group ${gid}`);
      g.memberIds.forEach((m) => ids.add(m));
    }
    for (const tid of targets.turtleIds ?? []) {
      if (!this.turtles.has(tid)) throw new ApiError(400, `unknown turtle ${tid}`);
      ids.add(tid);
    }
    return [...ids];
  }

  // ------------------------------------------------------------ batches

  private createBatch(kind: BatchView['kind'], label: string, items: BatchItem[], op?: string, args?: Record<string, unknown>): BatchView {
    const batch: BatchView = { id: newId('b'), kind, op, args, label, createdAt: now(), items };
    this.batches.set(batch.id, batch);
    if (this.batches.size > MAX_BATCHES_IN_MEMORY) {
      const oldest = [...this.batches.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      this.batches.delete(oldest.id);
    }
    this.db
      .prepare('INSERT INTO batches (id, kind, op, args_json, label, created_at, items_json) VALUES (?,?,?,?,?,?,?)')
      .run(batch.id, kind, op ?? null, args ? JSON.stringify(args) : null, label, batch.createdAt, JSON.stringify(items));
    this.broadcast({ type: 'batch', batch });
    return batch;
  }

  private updateItem(batchId: string, turtleId: string, patch: Partial<BatchItem>): void {
    const batch = this.batches.get(batchId);
    const item = batch?.items.find((i) => i.turtleId === turtleId);
    if (!batch || !item) return;
    Object.assign(item, patch, { updatedAt: now() });
    this.db.prepare('UPDATE batches SET items_json=? WHERE id=?').run(JSON.stringify(batch.items), batchId);
    this.broadcast({ type: 'batch', batch });
  }

  private setCommandStatus(cmd: CommandRec, patch: { status: CommandStatus; code?: string; reason?: string; data?: Record<string, unknown> }): void {
    Object.assign(cmd, patch);
    if (TERMINAL_STATUSES.has(cmd.status)) {
      const waiter = this.stepWaiters.get(cmd.id);
      if (waiter) {
        this.stepWaiters.delete(cmd.id);
        waiter({ status: cmd.status, code: cmd.code, reason: cmd.reason, data: cmd.data });
      }
      this.recentCommands.set(cmd.id, cmd);
      if (this.recentCommands.size > MAX_RECENT_COMMANDS) this.recentCommands.delete(this.recentCommands.keys().next().value!);
    }
    this.db
      .prepare('UPDATE commands SET status=?, code=?, reason=?, result_json=?, updated_at=? WHERE id=?')
      .run(cmd.status, cmd.code ?? null, cmd.reason ?? null, cmd.data ? JSON.stringify(cmd.data) : null, now(), cmd.id);
    this.updateItem(cmd.batchId, cmd.turtleId, { status: cmd.status, code: cmd.code, reason: cmd.reason, data: cmd.data });
    const rec = this.turtles.get(cmd.turtleId);
    if (rec) this.touch(rec);
  }

  // ------------------------------------------------------------ commands

  issueCommand(targets: Targets, op: string, rawArgs: unknown, opts: { executor?: string; ttlMs?: number } = {}): BatchView {
    const parsed = parseOpArgs(op, rawArgs);
    if (!parsed.ok) throw new ApiError(400, parsed.error);
    const ids = this.resolveTargets(targets);
    if (ids.length === 0) throw new ApiError(400, 'no turtles targeted');
    if ((op === 'calibrate' || op === 'setLabel') && ids.length > 1) throw new ApiError(400, `${op} applies to exactly one turtle`);
    // Manual control takes over: any job on these turtles pauses after its current step.
    this.hooks.operatorAction?.(ids, 'command');
    const t = now();
    const ttl = Math.min(Math.max(opts.ttlMs ?? DEFAULT_COMMAND_TTL_MS, 1000), 10 * 60_000);
    const executor = opts.executor ?? 'manual';
    const items: BatchItem[] = [];
    const created: CommandRec[] = [];
    const batchId = newId('b');
    for (const tid of ids) {
      const rec = this.turtles.get(tid)!;
      const item: BatchItem = { turtleId: tid, status: 'queued', updatedAt: t };
      items.push(item);
      if (!rec.conn) {
        Object.assign(item, { status: 'undeliverable', reason: 'offline — not delivered' });
        continue;
      }
      if (PHYSICAL_OPS.has(op as Op) && rec.state?.hold) {
        Object.assign(item, { status: 'rejected', code: 'held', reason: `${rec.state.hold.reason === 'estop' ? 'emergency-stopped' : 'paused'}; resume it first` });
        continue;
      }
      if (rec.queue.length >= MAX_QUEUED_COMMANDS) {
        Object.assign(item, { status: 'rejected', code: 'busy', reason: 'command queue full' });
        continue;
      }
      const cmd: CommandRec = { id: newId('c'), batchId, turtleId: tid, op: op as Op, args: parsed.args, executor, status: 'queued', createdAt: t, expiresAt: t + ttl };
      item.commandId = cmd.id;
      created.push(cmd);
    }
    // Insert the batch and its commands before dispatching anything.
    const batch: BatchView = { id: batchId, kind: 'command', op, args: parsed.args, label: describeOp(op, parsed.args), createdAt: t, items };
    tx(this.db, () => {
      this.db
        .prepare('INSERT INTO batches (id, kind, op, args_json, label, created_at, items_json) VALUES (?,?,?,?,?,?,?)')
        .run(batch.id, batch.kind, op, JSON.stringify(parsed.args), batch.label, t, JSON.stringify(items));
      const ins = this.db.prepare('INSERT INTO commands (id, batch_id, turtle_id, op, args_json, executor, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
      for (const c of created) ins.run(c.id, batchId, c.turtleId, c.op, JSON.stringify(c.args), executor, 'queued', t, t);
    });
    this.batches.set(batch.id, batch);
    this.broadcast({ type: 'batch', batch });
    for (const c of created) {
      const rec = this.turtles.get(c.turtleId)!;
      rec.queue.push(c);
      this.pump(rec);
    }
    return batch;
  }

  private pump(rec: TurtleRec): void {
    while (!rec.inflight && rec.conn && rec.queue.length > 0) {
      const cmd = rec.queue.shift()!;
      if (now() > cmd.expiresAt) {
        this.setCommandStatus(cmd, { status: 'expired', reason: 'expired while queued' });
        continue;
      }
      const msg: CmdMsg = {
        v: PROTOCOL_VERSION,
        type: 'cmd',
        id: newId('m'),
        ts: now(),
        commandId: cmd.id,
        op: cmd.op,
        args: cmd.args,
        expiresAt: cmd.expiresAt,
        executor: cmd.executor,
      };
      rec.inflight = cmd;
      cmd.sentAt = now();
      this.setCommandStatus(cmd, { status: 'sent' });
      rec.conn.send(msg);
    }
    this.touch(rec);
  }

  /** Test hook: deliver an already-sent command a second time, as a flaky network might. */
  redeliver(commandId: string): void {
    const cmd = [...this.turtles.values()].map((r) => r.inflight).find((c) => c?.id === commandId) ?? this.recentCommands.get(commandId);
    const rec = cmd && this.turtles.get(cmd.turtleId);
    if (!cmd || !rec?.conn) throw new Error('cannot redeliver');
    rec.conn.send({ v: PROTOCOL_VERSION, type: 'cmd', id: newId('m'), ts: now(), commandId: cmd.id, op: cmd.op, args: cmd.args, expiresAt: cmd.expiresAt, executor: cmd.executor });
  }

  /**
   * Run one command for a job and wait for its outcome. Not shown as a UI batch.
   * Resolves (never rejects) with the terminal status.
   */
  runStep(turtleId: string, op: Op, args: Record<string, unknown>, executor: string): Promise<StepResult> {
    const rec = this.turtles.get(turtleId);
    if (this.closed) return Promise.resolve({ status: 'undeliverable', reason: 'backend shutting down' });
    if (!rec) return Promise.resolve({ status: 'rejected', code: 'invalid', reason: 'unknown turtle' });
    if (!rec.conn) return Promise.resolve({ status: 'undeliverable', reason: 'turtle offline' });
    if (PHYSICAL_OPS.has(op) && rec.state?.hold) return Promise.resolve({ status: 'rejected', code: 'held', reason: 'turtle is held' });
    const parsed = parseOpArgs(op, args);
    if (!parsed.ok) return Promise.resolve({ status: 'rejected', code: 'invalid', reason: parsed.error });
    const t = now();
    const cmd: CommandRec = { id: newId('c'), batchId: '', turtleId, op, args: parsed.args, executor, status: 'queued', createdAt: t, expiresAt: t + DEFAULT_COMMAND_TTL_MS };
    this.db
      .prepare('INSERT INTO commands (id, batch_id, turtle_id, op, args_json, executor, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(cmd.id, null, turtleId, op, JSON.stringify(cmd.args), executor, 'queued', t, t);
    const p = new Promise<StepResult>((resolve) => this.stepWaiters.set(cmd.id, resolve));
    rec.queue.push(cmd);
    this.pump(rec);
    return p;
  }

  turtleState(id: string): { state?: TurtleState; online: boolean; world: string; dimension: string; name: string } | undefined {
    const rec = this.turtles.get(id);
    return rec && { state: rec.state, online: !!rec.conn, world: rec.world, dimension: rec.dimension, name: rec.name };
  }

  /** Last known positions of all turtles in a world (offline ones included: they may still be there). */
  turtlePositions(world: string, dimension: string, exceptId?: string): Vec3[] {
    const out: Vec3[] = [];
    for (const r of this.turtles.values()) {
      if (r.id === exceptId || r.world !== world || r.dimension !== dimension) continue;
      const pose = r.state?.pose;
      if (pose?.pos) out.push(pose.pos);
      for (const c of pose?.candidates ?? []) out.push(c);
    }
    return out;
  }

  mapCell(world: string, dimension: string, p: Vec3): MapBlock | undefined {
    if (this.closed) return undefined;
    const r = this.db
      .prepare('SELECT block, cell, observed_at, source FROM map_blocks WHERE world=? AND dimension=? AND x=? AND z=? AND y=?')
      .get(world, dimension, p.x, p.z, p.y) as Record<string, unknown> | undefined;
    return r && { ...p, block: (r.block as string) ?? null, cell: r.cell as MapBlock['cell'], observedAt: r.observed_at as number, source: (r.source as string) ?? undefined };
  }

  // ------------------------------------------------------------ stop / resume / cancel

  private sendStop(rec: TurtleRec, reason: StopReason, batchId: string | undefined): string {
    const stopId = newId('s');
    for (const cmd of rec.queue.splice(0)) this.setCommandStatus(cmd, { status: 'cancelled', reason: reason === 'estop' ? 'emergency stop' : 'paused' });
    if (batchId) rec.stopWait = { batchId, stopId, acked: false };
    rec.conn!.send({ v: PROTOCOL_VERSION, type: 'stop', id: newId('m'), ts: now(), stopId, reason });
    return stopId;
  }

  /** Emergency stop or pause. Turtles stop after their current atomic operation. */
  stop(targets: Targets, reason: StopReason): BatchView {
    const ids = this.resolveTargets(targets);
    if (ids.length === 0) throw new ApiError(400, 'no turtles targeted');
    const t = now();
    const items: BatchItem[] = ids.map((turtleId) => ({ turtleId, status: 'sent', updatedAt: t }));
    const label = reason === 'estop' ? 'EMERGENCY STOP' : 'Pause';
    this.hooks.operatorAction?.(ids, 'stop');
    const batch = this.createBatch('stop', label, items, reason);
    for (const item of items) {
      const rec = this.turtles.get(item.turtleId)!;
      if (!rec.conn) {
        rec.pendingStop = reason;
        this.saveState(rec);
        this.updateItem(batch.id, rec.id, { status: 'unreachable', reason: 'offline — NOT delivered; will be sent when it reconnects' });
        this.touch(rec);
        continue;
      }
      this.sendStop(rec, reason, batch.id);
    }
    this.log(reason === 'estop' ? 'error' : 'warn', `${label} sent to ${ids.length} turtle(s)`);
    return batch;
  }

  resume(targets: Targets): BatchView {
    const ids = this.resolveTargets(targets);
    if (ids.length === 0) throw new ApiError(400, 'no turtles targeted');
    const t = now();
    const items: BatchItem[] = ids.map((turtleId) => ({ turtleId, status: 'sent', updatedAt: t }));
    const batch = this.createBatch('release', 'Resume', items);
    for (const item of items) {
      const rec = this.turtles.get(item.turtleId)!;
      const hadPending = !!rec.pendingStop;
      rec.pendingStop = undefined;
      if (!rec.conn) {
        this.saveState(rec);
        this.updateItem(batch.id, rec.id, {
          status: 'unreachable',
          reason: hadPending ? 'offline — pending stop cleared, but any hold on the turtle stays until resumed online' : 'offline — not delivered',
        });
        this.touch(rec);
        continue;
      }
      const hold = rec.state?.hold;
      if (!hold) {
        this.updateItem(batch.id, rec.id, { status: 'released', reason: 'was not paused' });
        continue;
      }
      rec.releaseWait = { batchId: batch.id, stopId: hold.stopId };
      rec.conn.send({ v: PROTOCOL_VERSION, type: 'release', id: newId('m'), ts: now(), stopId: hold.stopId });
    }
    return batch;
  }

  cancel(targets: Targets): BatchView {
    const ids = this.resolveTargets(targets);
    if (ids.length === 0) throw new ApiError(400, 'no turtles targeted');
    const t = now();
    const items: BatchItem[] = ids.map((turtleId) => ({ turtleId, status: 'cancelled', updatedAt: t }));
    this.hooks.operatorAction?.(ids, 'cancel');
    const batch = this.createBatch('cancel', 'Cancel commands', items);
    for (const item of items) {
      const rec = this.turtles.get(item.turtleId)!;
      const queued = rec.queue.splice(0);
      for (const cmd of queued) this.setCommandStatus(cmd, { status: 'cancelled', reason: 'cancelled by operator' });
      const parts = [`${queued.length} queued cancelled`];
      if (rec.inflight && rec.conn) {
        rec.conn.send({ v: PROTOCOL_VERSION, type: 'cancel', id: newId('m'), ts: now(), commandId: rec.inflight.id });
        parts.push(`in-flight ${rec.inflight.op} cancelled if not yet started (atomic operations finish)`);
      }
      this.updateItem(batch.id, rec.id, { status: 'cancelled', reason: parts.join('; ') });
      this.touch(rec);
    }
    return batch;
  }

  // ------------------------------------------------------------ turtles / groups admin

  updateTurtle(id: string, patch: { name?: string; world?: string; dimension?: string }): TurtleView {
    const rec = this.turtles.get(id);
    if (!rec) throw new ApiError(404, 'unknown turtle');
    if (patch.name !== undefined) rec.name = patch.name;
    if (patch.world !== undefined) rec.world = patch.world;
    if (patch.dimension !== undefined) rec.dimension = patch.dimension;
    this.db.prepare('UPDATE turtles SET name=?, world=?, dimension=? WHERE id=?').run(rec.name, rec.world, rec.dimension, id);
    this.touch(rec);
    return this.view(rec);
  }

  removeTurtle(id: string): void {
    const rec = this.turtles.get(id);
    if (!rec) throw new ApiError(404, 'unknown turtle');
    rec.conn?.close(4003, 'credentials revoked');
    rec.conn = undefined;
    this.turtles.delete(id);
    this.db.prepare('UPDATE turtles SET revoked_at=? WHERE id=?').run(now(), id);
    this.db.prepare('DELETE FROM group_members WHERE turtle_id=?').run(id);
    for (const g of this.groups.values()) g.memberIds = g.memberIds.filter((m) => m !== id);
    this.broadcast({ type: 'turtle_removed', id });
    this.hooks.removed?.(id);
    this.broadcast({ type: 'groups', groups: this.listGroups() });
    this.log('warn', `${rec.name} removed; its credentials are revoked`);
  }

  createGroup(name: string, memberIds: string[] = [], color?: string): GroupView {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 40) throw new ApiError(400, 'group name must be 1-40 characters');
    if ([...this.groups.values()].some((g) => g.name.toLowerCase() === trimmed.toLowerCase())) throw new ApiError(409, 'a group with that name exists');
    const g: GroupView = { id: newId('g'), name: trimmed, color: color ?? GROUP_COLORS[this.groups.size % GROUP_COLORS.length], memberIds: [] };
    this.db.prepare('INSERT INTO groups (id, name, color, created_at) VALUES (?,?,?,?)').run(g.id, g.name, g.color, now());
    this.groups.set(g.id, g);
    this.setGroupMembers(g.id, memberIds);
    this.log('info', `Group "${g.name}" created with ${g.memberIds.length} turtle(s)`);
    return g;
  }

  updateGroup(id: string, patch: { name?: string; color?: string }): GroupView {
    const g = this.groups.get(id);
    if (!g) throw new ApiError(404, 'unknown group');
    if (patch.name !== undefined) {
      const n = patch.name.trim();
      if (!n || n.length > 40) throw new ApiError(400, 'group name must be 1-40 characters');
      if ([...this.groups.values()].some((o) => o.id !== id && o.name.toLowerCase() === n.toLowerCase())) throw new ApiError(409, 'a group with that name exists');
      g.name = n;
    }
    if (patch.color !== undefined) g.color = patch.color;
    this.db.prepare('UPDATE groups SET name=?, color=? WHERE id=?').run(g.name, g.color, id);
    this.broadcast({ type: 'groups', groups: this.listGroups() });
    return g;
  }

  setGroupMembers(id: string, memberIds: string[]): GroupView {
    const g = this.groups.get(id);
    if (!g) throw new ApiError(404, 'unknown group');
    const valid = [...new Set(memberIds)].filter((m) => this.turtles.has(m));
    const before = new Set(g.memberIds);
    tx(this.db, () => {
      this.db.prepare('DELETE FROM group_members WHERE group_id=?').run(id);
      const ins = this.db.prepare('INSERT INTO group_members (group_id, turtle_id) VALUES (?,?)');
      for (const m of valid) ins.run(id, m);
    });
    g.memberIds = valid;
    for (const m of new Set([...before, ...valid])) {
      const rec = this.turtles.get(m);
      if (rec) this.touch(rec);
    }
    this.broadcast({ type: 'groups', groups: this.listGroups() });
    return g;
  }

  deleteGroup(id: string): void {
    const g = this.groups.get(id);
    if (!g) throw new ApiError(404, 'unknown group');
    this.db.prepare('DELETE FROM groups WHERE id=?').run(id);
    this.groups.delete(id);
    for (const m of g.memberIds) {
      const rec = this.turtles.get(m);
      if (rec) this.touch(rec);
    }
    this.broadcast({ type: 'groups', groups: this.listGroups() });
    this.log('info', `Group "${g.name}" deleted`);
  }

  // ------------------------------------------------------------ map

  private bufferMap(world: string, dimension: string, blocks: MapBlock[]): void {
    const key = `${world}\u0000${dimension}`;
    const buf = this.mapBuffer.get(key) ?? [];
    buf.push(...blocks);
    this.mapBuffer.set(key, buf);
  }

  private markTraversed(rec: TurtleRec, x: number, y: number, z: number): void {
    const t = now();
    // A turtle can stand in water or lava; keep a known fluid as fluid.
    const r = this.db
      .prepare(
        `INSERT INTO map_blocks (world, dimension, x, z, y, block, cell, state_json, observed_at, source)
         VALUES (?,?,?,?,?,NULL,'empty',NULL,?,?)
         ON CONFLICT(world, dimension, x, z, y) DO UPDATE SET block=NULL, cell='empty', state_json=NULL, observed_at=excluded.observed_at, source=excluded.source
         WHERE map_blocks.cell != 'fluid'`,
      )
      .run(rec.world, rec.dimension, x, z, y, t, rec.id);
    if (r.changes > 0) this.bufferMap(rec.world, rec.dimension, [{ x, y, z, block: null, cell: 'empty', observedAt: t, source: rec.id }]);
  }

  /**
   * Record blocks a turtle observed. Only cells adjacent to its known position are
   * accepted, or within `scanRadius` for a Geo Scanner scan.
   */
  observe(turtleId: string, blocks: BlockObservation[], scanRadius?: number): { accepted: number; rejected: number } {
    const rec = this.turtles.get(turtleId);
    const pose = rec?.state?.pose;
    if (!rec || !pose?.pos || pose.position !== 'known') return { accepted: 0, rejected: blocks.length };
    const t = now();
    const out: MapBlock[] = [];
    const up = this.db.prepare(
      `INSERT INTO map_blocks (world, dimension, x, z, y, block, cell, state_json, observed_at, source) VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(world, dimension, x, z, y) DO UPDATE SET block=excluded.block, cell=excluded.cell, state_json=excluded.state_json, observed_at=excluded.observed_at, source=excluded.source`,
    );
    let rejected = 0;
    tx(this.db, () => {
      for (const b of blocks) {
        const d = Math.max(Math.abs(b.x - pose.pos!.x), Math.abs(b.y - pose.pos!.y), Math.abs(b.z - pose.pos!.z));
        if (d > Math.min(scanRadius ?? 1, GEO_SCAN_MAX_RADIUS)) {
          rejected++;
          continue;
        }
        const cell = !b.name ? 'empty' : FLUID_BLOCKS.has(b.name) ? 'fluid' : 'solid';
        up.run(rec.world, rec.dimension, b.x, b.z, b.y, b.name ?? null, cell, b.state ? JSON.stringify(b.state) : null, t, rec.id);
        out.push({ x: b.x, y: b.y, z: b.z, block: b.name ?? null, cell, observedAt: t, source: rec.id });
      }
    });
    if (out.length) this.bufferMap(rec.world, rec.dimension, out);
    return { accepted: out.length, rejected };
  }

  /**
   * After a Geo Scanner scan: it reports every block except air in its cube, so each cell
   * of the cube it didn't report is known empty. Only when all of the scan's blocks were
   * accepted (else real blocks would be wiped) and the turtle is where it scanned from.
   */
  private markScannedAir(rec: TurtleRec, data: Record<string, unknown> | undefined, since: number): void {
    const center = data?.center as Vec3 | undefined;
    const radius = Number(data?.radius);
    const count = Number(data?.count);
    const pos = rec.state?.pose.pos;
    if (!center || !pos || rec.state?.pose.position !== 'known' || !Number.isInteger(radius) || radius < 1 || radius > GEO_SCAN_MAX_RADIUS) return;
    if (center.x !== pos.x || center.y !== pos.y || center.z !== pos.z) return;
    const cube = this.queryMap({ world: rec.world, dimension: rec.dimension, x0: center.x - radius, x1: center.x + radius, z0: center.z - radius, z1: center.z + radius, y0: center.y - radius, y1: center.y + radius, limit: 200_000 });
    const reported = new Set(cube.blocks.filter((b) => b.source === rec.id && b.observedAt >= since && b.cell !== 'empty').map((b) => `${b.x},${b.y},${b.z}`));
    if (reported.size < count) {
      this.log('warn', `${rec.name}: Geo Scanner reported ${count} blocks but ${reported.size} were recorded; not marking air from this scan`, rec.id);
      return;
    }
    const t = now();
    const up = this.db.prepare(
      `INSERT INTO map_blocks (world, dimension, x, z, y, block, cell, state_json, observed_at, source) VALUES (?,?,?,?,?,NULL,'empty',NULL,?,?)
       ON CONFLICT(world, dimension, x, z, y) DO UPDATE SET block=NULL, cell='empty', state_json=NULL, observed_at=excluded.observed_at, source=excluded.source`,
    );
    const known = new Map(cube.blocks.map((b) => [`${b.x},${b.y},${b.z}`, b]));
    const out: MapBlock[] = [];
    tx(this.db, () => {
      for (let x = center.x - radius; x <= center.x + radius; x++)
        for (let y = center.y - radius; y <= center.y + radius; y++)
          for (let z = center.z - radius; z <= center.z + radius; z++) {
            const k = `${x},${y},${z}`;
            if (reported.has(k)) continue;
            const b = known.get(k);
            if (b?.cell === 'empty' && b.observedAt >= since) continue; // already seen empty just now
            up.run(rec.world, rec.dimension, x, z, y, t, rec.id);
            out.push({ x, y, z, block: null, cell: 'empty', observedAt: t, source: rec.id });
          }
    });
    if (out.length) this.bufferMap(rec.world, rec.dimension, out);
  }

  /**
   * Record observations from a source other than a turtle's own inspection (tests now;
   * scanner adapters later). No adjacency check: the caller vouches for the data.
   */
  importObservations(world: string, dimension: string, blocks: BlockObservation[], source: string): void {
    const t = now();
    const up = this.db.prepare(
      `INSERT INTO map_blocks (world, dimension, x, z, y, block, cell, state_json, observed_at, source) VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(world, dimension, x, z, y) DO UPDATE SET block=excluded.block, cell=excluded.cell, state_json=excluded.state_json, observed_at=excluded.observed_at, source=excluded.source`,
    );
    const out: MapBlock[] = [];
    tx(this.db, () => {
      for (const b of blocks) {
        const cell = !b.name ? 'empty' : FLUID_BLOCKS.has(b.name) ? 'fluid' : 'solid';
        up.run(world, dimension, b.x, b.z, b.y, b.name ?? null, cell, b.state ? JSON.stringify(b.state) : null, t, source);
        out.push({ x: b.x, y: b.y, z: b.z, block: b.name ?? null, cell, observedAt: t, source });
      }
    });
    if (out.length) this.bufferMap(world, dimension, out);
  }

  queryMap(q: { world: string; dimension: string; x0: number; x1: number; z0: number; z1: number; y0: number; y1: number; limit?: number }): { blocks: MapBlock[]; truncated: boolean } {
    if (this.closed) return { blocks: [], truncated: false };
    const limit = Math.min(q.limit ?? 100_000, 200_000);
    const rows = this.db
      .prepare(
        `SELECT x, y, z, block, cell, observed_at, source FROM map_blocks
         WHERE world=? AND dimension=? AND x BETWEEN ? AND ? AND z BETWEEN ? AND ? AND y BETWEEN ? AND ? LIMIT ?`,
      )
      .all(q.world, q.dimension, q.x0, q.x1, q.z0, q.z1, q.y0, q.y1, limit + 1) as Record<string, unknown>[];
    const truncated = rows.length > limit;
    return {
      truncated,
      blocks: rows.slice(0, limit).map((r) => ({
        x: r.x as number,
        y: r.y as number,
        z: r.z as number,
        block: (r.block as string) ?? null,
        cell: r.cell as MapBlock['cell'],
        observedAt: r.observed_at as number,
        source: (r.source as string) ?? undefined,
      })),
    };
  }

  /** Ore blocks seen and still in place (not mined), anywhere in a world. */
  findOres(world: string, dimension: string, limit = 5000): MapBlock[] {
    if (this.closed) return [];
    const rows = this.db
      .prepare(
        `SELECT x, y, z, block, cell, observed_at, source FROM map_blocks
         WHERE world=? AND dimension=? AND cell='solid' AND (block LIKE '%ore%' OR block LIKE '%ancient_debris%') LIMIT ?`,
      )
      .all(world, dimension, limit * 4) as Record<string, unknown>[];
    return rows
      .filter((r) => isOreBlock(r.block as string))
      .slice(0, limit)
      .map((r) => ({ x: r.x as number, y: r.y as number, z: r.z as number, block: r.block as string, cell: 'solid' as const, observedAt: r.observed_at as number, source: (r.source as string) ?? undefined }));
  }

  /** Move everything of one world/instance to another name (turtles and map). */
  renameWorld(from: string, to: string): void {
    this.flush();
    tx(this.db, () => {
      this.db.prepare('UPDATE turtles SET world=? WHERE world=?').run(to, from);
      this.db.prepare('UPDATE map_blocks SET world=? WHERE world=?').run(to, from);
      this.db.prepare('UPDATE enrollments SET world=? WHERE world=? AND used_at IS NULL').run(to, from);
    });
    for (const rec of this.turtles.values()) {
      if (rec.world !== from) continue;
      rec.world = to;
      this.touch(rec);
    }
  }

  /** Delete a world/instance's map and unpair its turtles (credentials revoked). */
  deleteWorld(world: string): void {
    this.flush();
    for (const rec of [...this.turtles.values()]) if (rec.world === world) this.removeTurtle(rec.id);
    this.db.prepare('DELETE FROM map_blocks WHERE world=?').run(world);
    this.db.prepare('DELETE FROM enrollments WHERE world=? AND used_at IS NULL').run(world);
  }

  worlds(): { world: string; dimension: string }[] {
    const set = new Map<string, { world: string; dimension: string }>();
    for (const r of this.turtles.values()) set.set(`${r.world}|${r.dimension}`, { world: r.world, dimension: r.dimension });
    const rows = this.db.prepare('SELECT DISTINCT world, dimension FROM map_blocks').all() as { world: string; dimension: string }[];
    for (const r of rows) set.set(`${r.world}|${r.dimension}`, r);
    return [...set.values()];
  }
}

export function describeOp(op: string, args: Record<string, unknown>): string {
  switch (op) {
    case 'select':
      return `Select slot ${args.slot}`;
    case 'refuel':
      return args.count !== undefined ? `Refuel (${args.count})` : 'Refuel';
    case 'calibrate':
      return `Calibrate ${args.x} ${args.y} ${args.z} facing ${['N', 'E', 'S', 'W'][args.heading as number]}`;
    case 'setLabel':
      return `Set label "${args.label}"`;
    default:
      return op.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
  }
}
