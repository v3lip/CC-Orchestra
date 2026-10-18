/**
 * Jobs and depots: persistence, lifecycle, dock locks, and the hooks that make manual
 * control, stops and disconnects pause a job instead of fighting it.
 */
import {
  type DepotInput,
  type ChunkNeed,
  type DepotView,
  type EventView,
  type ForcedChunk,
  type Heading,
  type JobEstimate,
  type JobPhase,
  type JobStatus,
  type JobView,
  type StrategyInput,
  type TunnelParams,
  type TurtleView,
  type Vec3,
  CampaignInput as CampaignSchema,
  DepotInput as DepotSchema,
  JobInput as JobSchema,
  JobPolicy,
  hasChunkLoader,
  sectionBox,
  segmentsFor,
} from '@ccfleet/protocol';
import type { Db } from '../db';
import { ApiError, type Fleet } from '../fleet';
import { newId, now } from '../util';
import { boxesOverlap, chunkOf, eq, fmt, inBox, jobChunks, key, lanes, manhattan, splitTunnel } from './geometry';
import { JobRunner } from './runner';
import { Interrupt, JobError, Mover } from './mover';
import { Traffic } from './traffic';

export interface JobRec {
  view: JobView;
  checkpoint: {
    /** Next slice to mine. Slices before it are complete. */
    slice: number;
    /** Where to return to after a depot trip. */
    resume?: { pos: Vec3; heading: Heading };
    /** A depot trip is in progress ('finish' = final return, 'back' = unloaded, heading back). */
    servicing?: 'trip' | 'finish' | 'back';
  };
}

const ACTIVE: ReadonlySet<JobStatus> = new Set(['ready', 'running', 'pausing', 'paused']);

export class JobManager {
  private jobs = new Map<string, JobRec>();
  private depots = new Map<string, DepotView>();
  private runners = new Map<string, Promise<void>>();
  private dockLocks = new Map<string, string>();
  /** depotId -> (spot key -> turtle) */
  private spotClaims = new Map<string, Map<string, string>>();
  /** Cells the current dock holder came in on, so waiting turtles stay off them. */
  private dockRoutes = new Map<string, Set<string>>();
  /** Jobs paused because their turtle dropped, with auto-resume on: when it dropped. */
  private droppedAt = new Map<string, number>();
  /** Recent automatic resumes per job (for the 3-per-hour limit). */
  private autoResumes = new Map<string, number[]>();
  private tasks = new Map<string, { id: string; target: Vec3; status: 'running' | 'stopping'; note?: string; reason?: string }>();
  readonly traffic: Traffic;
  private pendingBroadcast = new Set<string>();
  private timer: NodeJS.Timeout;

  constructor(
    private db: Db,
    private fleet: Fleet,
  ) {
    this.traffic = new Traffic(fleet);
    this.load();
    fleet.hooks.operatorAction = (ids, kind) => {
      for (const id of ids) {
        this.stopTask(id, kind === 'command' ? 'manual control took over' : 'stopped by operator');
        const job = this.activeJobFor(id);
        if (job && (job.view.status === 'running' || job.view.status === 'pausing')) {
          this.pause(job.view.id, kind === 'command' ? 'manual control took over' : kind === 'stop' ? 'turtle stopped by operator' : 'commands cancelled');
        }
      }
    };
    fleet.hooks.disconnected = (id) => {
      this.stopTask(id, 'turtle went offline');
      const job = this.activeJobFor(id);
      if (job && (job.view.status === 'running' || job.view.status === 'pausing')) {
        this.pause(job.view.id, this.offlineReason(job));
        if (job.view.policy.autoResume) this.droppedAt.set(job.view.id, now());
      }
    };
    fleet.hooks.online = (id) => this.maybeAutoResume(id);
    fleet.hooks.removed = (id) => {
      const job = this.activeJobFor(id);
      if (job) this.cancel(job.view.id);
    };
    fleet.hooks.taskOf = (id) => {
      const t = this.tasks.get(id);
      return t && { kind: 'goto', target: t.target, note: t.note };
    };
    fleet.hooks.jobOf = (id) => {
      const j = this.activeJobFor(id);
      return j && { id: j.view.id, name: j.view.name, status: j.view.status, phase: j.view.phase };
    };
    fleet.hooks.extraInit = () => ({ jobs: this.listJobs(), depots: this.listDepots(), forcedChunks: this.listForced() });
    this.timer = setInterval(() => this.flush(), 200);
  }

  private closed = false;

  /** Shutdown: stop go-to tasks and running jobs after their current step. */
  close(): void {
    for (const id of this.tasks.keys()) this.stopTask(id, 'backend shutting down');
    for (const j of this.jobs.values()) {
      if (j.view.status === 'running') {
        j.view.status = 'pausing';
        j.view.pauseReason = 'backend restarted';
      }
    }
    clearInterval(this.timer);
    this.flush();
    this.closed = true;
  }

  log(level: EventView['level'], message: string, turtleId?: string): void {
    this.fleet.log(level, message, turtleId);
  }

  // ------------------------------------------------------------------ persistence

  private load(): void {
    for (const r of this.db.prepare('SELECT data_json FROM depots').all() as { data_json: string }[]) {
      const d = JSON.parse(r.data_json) as DepotView;
      this.depots.set(d.id, d);
    }
    for (const r of this.db.prepare('SELECT data_json, checkpoint_json FROM jobs').all() as { data_json: string; checkpoint_json: string }[]) {
      const rec: JobRec = { view: JSON.parse(r.data_json), checkpoint: JSON.parse(r.checkpoint_json) };
      if (rec.view.status === 'running' || rec.view.status === 'pausing') {
        rec.view.status = 'paused';
        rec.view.pauseReason = 'backend restarted';
      }
      rec.view.route = undefined;
      rec.view.segments ??= segmentsFor({ strategy: 'tunnel', params: rec.view.params as TunnelParams });
      this.jobs.set(rec.view.id, rec);
    }
  }

  save(job: JobRec): void {
    if (this.closed) return;
    job.view.updatedAt = now();
    this.db
      .prepare('INSERT INTO jobs (id, data_json, checkpoint_json, status, turtle_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, checkpoint_json=excluded.checkpoint_json, status=excluded.status, updated_at=excluded.updated_at')
      .run(job.view.id, JSON.stringify({ ...job.view, route: undefined }), JSON.stringify(job.checkpoint), job.view.status, job.view.turtleId, job.view.createdAt, job.view.updatedAt);
    this.broadcast(job);
  }

  broadcast(job: JobRec): void {
    this.pendingBroadcast.add(job.view.id);
  }

  private flush(): void {
    for (const id of this.pendingBroadcast) {
      const j = this.jobs.get(id);
      if (j) {
        this.fleet.broadcast({ type: 'job', job: j.view });
        this.fleet.touchTurtle(j.view.turtleId);
      }
    }
    this.pendingBroadcast.clear();
  }

  // ------------------------------------------------------------------ depots

  listDepots(): DepotView[] {
    return [...this.depots.values()].map((d) => ({ ...d, lockedBy: this.dockLocks.get(d.id) }));
  }

  getDepot(id: string): DepotView | undefined {
    return this.depots.get(id);
  }

  saveDepot(input: unknown, id?: string): DepotView {
    const parsed: DepotInput = DepotSchema.parse(input);
    if (parsed.fuelDir && parsed.fuelDir === parsed.unloadDir) throw new ApiError(400, 'the fuel chest must be on a different side than the unload chest');
    const existing = id ? this.depots.get(id) : undefined;
    if (id && !existing) throw new ApiError(404, 'unknown depot');
    const d: DepotView = { ...parsed, id: existing?.id ?? newId('d'), createdAt: existing?.createdAt ?? now() };
    this.depots.set(d.id, d);
    this.db
      .prepare('INSERT INTO depots (id, name, data_json, created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, data_json=excluded.data_json')
      .run(d.id, d.name, JSON.stringify(d), d.createdAt);
    this.fleet.broadcast({ type: 'depot', depot: { ...d, lockedBy: this.dockLocks.get(d.id) } });
    this.log('info', `Depot "${d.name}" ${existing ? 'updated' : 'created'} (dock ${d.dock.x} ${d.dock.y} ${d.dock.z})`);
    return d;
  }

  deleteDepot(id: string): void {
    if (!this.depots.has(id)) throw new ApiError(404, 'unknown depot');
    if ([...this.jobs.values()].some((j) => j.view.depotId === id && ACTIVE.has(j.view.status))) throw new ApiError(409, 'a job still uses this depot');
    this.depots.delete(id);
    this.db.prepare('DELETE FROM depots WHERE id=?').run(id);
    this.fleet.broadcast({ type: 'depot_removed', id });
  }

  /**
   * Take the dock if it is free (or already ours). Otherwise returns a label for the
   * holder. The dock is held from heading in until the turtle steps off it; a lock held
   * by an offline turtle stays, as it may still be standing there.
   */
  tryLockDock(depotId: string, turtleId: string): string | undefined {
    const holder = this.dockLocks.get(depotId);
    if (!holder || holder === turtleId) {
      if (!holder) {
        this.dockLocks.set(depotId, turtleId);
        this.broadcastDepot(depotId);
      }
      return undefined;
    }
    const t = this.fleet.getTurtle(holder);
    return `${t?.name ?? holder}${t && t.connection === 'offline' ? ', offline — it may still be in the way' : ''}`;
  }

  /** The waiting spot this turtle holds at a depot, if any. */
  spotOf(depotId: string, turtleId: string): Vec3 | undefined {
    for (const [k, t] of this.spotClaims.get(depotId) ?? []) {
      if (t === turtleId) {
        const [x, y, z] = k.split(',').map(Number);
        return { x, y, z };
      }
    }
    return undefined;
  }

  /** Claim the nearest free waiting spot (not claimed, nobody standing on it). */
  claimSpot(depotId: string, turtleId: string, from: Vec3): Vec3 | undefined {
    const d = this.depots.get(depotId);
    if (!d?.waiting.length) return undefined;
    const claims = this.spotClaims.get(depotId) ?? new Map<string, string>();
    this.spotClaims.set(depotId, claims);
    const occupied = new Set(this.fleet.turtlePositions(d.world, d.dimension, turtleId).map(key));
    const free = d.waiting.filter((s) => !claims.has(key(s)) && !occupied.has(key(s))).sort((a, b) => manhattan(a, from) - manhattan(b, from));
    if (!free.length) return undefined;
    claims.set(key(free[0]), turtleId);
    return free[0];
  }

  /** Claim a specific cell as this turtle's waiting place (when the depot has no free spot). */
  claimCell(depotId: string, turtleId: string, cell: Vec3): boolean {
    const claims = this.spotClaims.get(depotId) ?? new Map<string, string>();
    this.spotClaims.set(depotId, claims);
    const owner = claims.get(key(cell));
    if (owner && owner !== turtleId) return false;
    this.releaseSpot(depotId, turtleId);
    claims.set(key(cell), turtleId);
    return true;
  }

  /** Is this cell claimed as a waiting place by another turtle? */
  cellClaimed(depotId: string, turtleId: string, cell: Vec3): boolean {
    const owner = this.spotClaims.get(depotId)?.get(key(cell));
    return !!owner && owner !== turtleId;
  }

  /** The way the dock holder came in (and will most likely leave). */
  setDockRoute(depotId: string, turtleId: string, cells: Vec3[]): void {
    if (this.dockLocks.get(depotId) === turtleId) this.dockRoutes.set(depotId, new Set(cells.map(key)));
  }

  dockHolder(depotId: string): string | undefined {
    return this.dockLocks.get(depotId);
  }

  dockRoute(depotId: string): Set<string> {
    return new Set(this.dockRoutes.get(depotId) ?? []);
  }

  releaseSpot(depotId: string, turtleId: string): void {
    const claims = this.spotClaims.get(depotId);
    if (!claims) return;
    for (const [k, t] of claims) if (t === turtleId) claims.delete(k);
  }

  /** Does another unfinished job use this depot? */
  depotShared(depotId: string, exceptJobId: string): boolean {
    return [...this.jobs.values()].some((j) => j.view.id !== exceptJobId && j.view.depotId === depotId && ACTIVE.has(j.view.status));
  }

  releaseDock(depotId: string, turtleId: string): void {
    if (this.dockLocks.get(depotId) === turtleId) {
      this.dockLocks.delete(depotId);
      this.dockRoutes.delete(depotId);
      this.broadcastDepot(depotId);
    }
  }

  private broadcastDepot(id: string): void {
    const d = this.depots.get(id);
    if (d) this.fleet.broadcast({ type: 'depot', depot: { ...d, lockedBy: this.dockLocks.get(id) } });
  }

  // ------------------------------------------------------------------ force-loaded chunks

  listForced(): ForcedChunk[] {
    return (this.db.prepare('SELECT world, dimension, cx, cz, created_at FROM forced_chunks').all() as Record<string, unknown>[]).map((r) => ({
      world: r.world as string,
      dimension: r.dimension as string,
      cx: r.cx as number,
      cz: r.cz as number,
      createdAt: r.created_at as number,
    }));
  }

  setForced(world: string, dimension: string, cx: number, cz: number, forced: boolean): ForcedChunk[] {
    if (forced) this.db.prepare('INSERT OR IGNORE INTO forced_chunks (world, dimension, cx, cz, created_at) VALUES (?,?,?,?,?)').run(world, dimension, cx, cz, now());
    else this.db.prepare('DELETE FROM forced_chunks WHERE world=? AND dimension=? AND cx=? AND cz=?').run(world, dimension, cx, cz);
    const all = this.listForced();
    this.fleet.broadcast({ type: 'forced_chunks', chunks: all });
    return all;
  }

  isForced(world: string, dimension: string, cx: number, cz: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM forced_chunks WHERE world=? AND dimension=? AND cx=? AND cz=?').get(world, dimension, cx, cz);
  }

  /**
   * Why a job's turtle dropped. A turtle that goes offline as it steps into a chunk
   * nothing keeps loaded is the classic Chunk Controller failure: say so.
   */
  private offlineReason(job: JobRec): string {
    const t = this.fleet.getTurtle(job.view.turtleId);
    const pos = t?.state?.pose.pos;
    const route = job.view.route ?? [];
    if (!pos || route.length === 0) return 'turtle went offline';
    const i = route.findIndex((c) => eq(c, pos));
    // Either it was about to step across a border, or it had just stepped across one.
    const next = route[i + 1] ?? (i < 0 ? route[0] : undefined);
    const prev = i > 0 ? route[i - 1] : undefined;
    let a = chunkOf(pos);
    let b = next ? chunkOf(next) : a;
    if (a.cx === b.cx && a.cz === b.cz && prev) {
      b = a;
      a = chunkOf(prev);
    }
    if (a.cx === b.cx && a.cz === b.cz) return 'turtle went offline';
    if (this.isForced(job.view.world, job.view.dimension, b.cx, b.cz)) return `turtle went offline moving into chunk ${b.cx},${b.cz} (marked force-loaded)`;
    return `turtle went offline as it crossed from chunk ${a.cx},${a.cz} into chunk ${b.cx},${b.cz}`;
  }

  // ------------------------------------------------------------------ jobs

  listJobs(): JobView[] {
    return [...this.jobs.values()].map((j) => j.view).sort((a, b) => b.createdAt - a.createdAt);
  }

  getJob(id: string): JobView | undefined {
    return this.jobs.get(id)?.view;
  }

  activeJobFor(turtleId: string): JobRec | undefined {
    return [...this.jobs.values()].find((j) => j.view.turtleId === turtleId && ACTIVE.has(j.view.status));
  }

  estimate(input: unknown): { estimate: JobEstimate; warnings: string[]; chunks: ChunkNeed[] } {
    const j = JobSchema.parse(input);
    const depot = this.depots.get(j.depotId);
    if (!depot) throw new ApiError(400, 'unknown depot');
    const segs = segmentsFor(j);
    const policy = JobPolicy.parse(j.policy);
    let cells = 0;
    let mineMoves = 0;
    let turns = 0;
    for (const s of segs) {
      const nl = lanes(s.height).length;
      cells += s.width * s.height * s.length;
      mineMoves += s.length * (s.width * nl + 3 * Math.max(0, nl - 1));
      // Wall scans: at each column, up and back down through the other rows of the
      // lane (to see the ceiling, floor and side walls); turns and inspects at the edges.
      if (policy.scanWalls) {
        const rows = Math.min(3, s.height);
        mineMoves += s.length * nl * s.width * 2 * (rows - 1);
        turns += s.length * nl * Math.min(2, s.width) * rows * 3;
      }
    }
    const first = segs[0];
    const span = Math.max(...segs.map((s) => manhattan(s.origin, first.origin) + s.length));
    const toSite = manhattan(depot.dock, first.origin) + 4;
    const blocksPerTrip = 640;
    const trips = Math.max(1, Math.ceil(cells / blocksPerTrip));
    const moves = mineMoves + 2 * toSite + trips * 2 * (toSite + Math.ceil(span / 2));
    const seconds = Math.round((moves + cells + turns) * 0.45);
    const warnings: string[] = [];
    if (segs.some((s) => inBox(sectionBox(s), depot.dock))) warnings.push('The dock is inside the work area.');
    if (toSite > 64) warnings.push(`The work area starts ${toSite} blocks from the dock; long trips use a lot of fuel.`);
    if (policy.veins.ores.length) warnings.push(`Vein following (${policy.veins.ores.join(', ')}) adds time and fuel that isn't in this estimate.`);
    const turtle = this.fleet.getTurtle(j.turtleId);
    const chunks: ChunkNeed[] = jobChunks(segs, depot.dock).map((c) => ({ ...c, forced: this.isForced(depot.world, depot.dimension, c.cx, c.cz) }));
    if (turtle?.state && !hasChunkLoader(turtle.state.upgrades)) {
      warnings.push(`${turtle.name} has no Chunk Controller: it only keeps working while a player is near (its chunk must stay loaded).`);
    }

    if (turtle && (turtle.world !== depot.world || turtle.dimension !== depot.dimension)) warnings.push(`The turtle is in ${turtle.world}/${turtle.dimension}, the depot in ${depot.world}/${depot.dimension}.`);
    return {
      estimate: {
        moves,
        fuel: moves,
        seconds,
        trips,
        cells,
        note: `Estimate: assumes mostly solid rock, ~640 blocks per trip and no detours${policy.scanWalls ? '; includes wall scanning' : ''}. Real numbers vary.`,
      },
      warnings,
      chunks,
    };
  }

  createJob(input: unknown): JobView {
    const j = JobSchema.parse(input);
    this.validateNew([{ turtleId: j.turtleId, segments: segmentsFor(j), name: j.name }], j.depotId);
    return this.insertJob(input);
  }

  /**
   * Check a set of new tunnels before creating any: known depot and turtles, no turtle
   * with an unfinished job or used twice, no overlap with each other or unfinished jobs.
   */
  private validateNew(specs: { turtleId: string; segments: TunnelParams[]; name: string }[], depotId: string): void {
    const depot = this.depots.get(depotId);
    if (!depot) throw new ApiError(400, 'unknown depot');
    const seen = new Set<string>();
    specs.forEach((s, i) => {
      const turtle = this.fleet.getTurtle(s.turtleId);
      if (!turtle) throw new ApiError(400, 'unknown turtle');
      if (seen.has(s.turtleId)) throw new ApiError(400, `${turtle.name} is listed twice`);
      seen.add(s.turtleId);
      if (this.activeJobFor(s.turtleId)) throw new ApiError(409, `${turtle.name} already has an unfinished job`);
      if (this.tasks.has(s.turtleId)) throw new ApiError(409, `${turtle.name} is busy with a go-to task`);
      // Two jobs digging the same cells would fight over them (and their turtles would collide).
      const overlaps = (a: TunnelParams[], b: TunnelParams[]) => a.some((x) => b.some((y) => boxesOverlap(sectionBox(x), sectionBox(y))));
      for (const o of this.jobs.values()) {
        if (!ACTIVE.has(o.view.status) || o.view.world !== depot.world || o.view.dimension !== depot.dimension) continue;
        if (overlaps(s.segments, o.view.segments)) throw new ApiError(409, `${s.name}: the work area overlaps job "${o.view.name}". Move it or finish/cancel that job first.`);
      }
      specs.slice(i + 1).forEach((o) => {
        if (overlaps(s.segments, o.segments)) throw new ApiError(409, `${s.name} and ${o.name} would dig the same cells`);
      });
    });
  }

  private insertJob(input: unknown, extra: Pick<JobView, 'campaignId' | 'campaignName' | 'lane'> = {}): JobView {
    const j = JobSchema.parse(input);
    const depot = this.depots.get(j.depotId)!;
    const turtle = this.fleet.getTurtle(j.turtleId)!;
    const { estimate } = this.estimate(input);
    const segments = segmentsFor(j);
    const t = now();
    const rec: JobRec = {
      view: {
        id: newId('j'),
        name: j.name,
        strategy: j.strategy,
        params: j.params,
        segments,
        policy: JobPolicy.parse(j.policy),
        exclusions: j.exclusions,
        world: depot.world,
        dimension: depot.dimension,
        depotId: depot.id,
        turtleId: j.turtleId,
        ...extra,
        status: 'ready',
        phase: 'idle',
        progress: { unitsDone: 0, unitsTotal: segments.reduce((n, s) => n + s.length, 0), cellsCleared: 0, cellsSkipped: 0, trips: 0, itemsUnloaded: 0, finds: {}, veinBlocks: 0 },
        estimate,
        createdAt: t,
        updatedAt: t,
      },
      checkpoint: { slice: 0 },
    };
    this.jobs.set(rec.view.id, rec);
    this.save(rec);
    this.log('info', `Job "${rec.view.name}" created for ${turtle.name}`, turtle.id);
    return rec.view;
  }

  private mustGet(id: string): JobRec {
    const j = this.jobs.get(id);
    if (!j) throw new ApiError(404, 'unknown job');
    return j;
  }

  start(id: string): JobView {
    const job = this.mustGet(id);
    if (job.view.status !== 'ready' && job.view.status !== 'paused') throw new ApiError(409, `job is ${job.view.status}`);
    if (this.runners.has(id)) throw new ApiError(409, 'job is still stopping; try again in a moment');
    this.droppedAt.delete(id);
    job.view.status = 'running';
    job.view.pauseReason = undefined;
    job.view.note = undefined;
    job.view.error = undefined;
    job.view.startedAt ??= now();
    this.save(job);
    this.log('info', `Job "${job.view.name}" ${job.view.progress.unitsDone || job.checkpoint.servicing ? 'resumed' : 'started'}`, job.view.turtleId);
    const runner = new JobRunner(this, this.fleet, this.traffic, job);
    const p = runner.run().finally(() => this.runners.delete(id));
    this.runners.set(id, p);
    return job.view;
  }

  /** Pause after the current step. */
  pause(id: string, reason = 'paused by operator'): JobView {
    const job = this.mustGet(id);
    // Any pause that isn't the turtle dropping (operator, manual control) cancels auto-resume.
    if (!reason.startsWith('turtle went offline')) this.droppedAt.delete(id);
    if (job.view.status === 'running') {
      job.view.status = this.runners.has(id) ? 'pausing' : 'paused';
      job.view.pauseReason = reason;
      this.save(job);
      this.log('warn', `Job "${job.view.name}" pausing: ${reason}`, job.view.turtleId);
    } else if (job.view.status === 'ready') {
      throw new ApiError(409, 'job has not started');
    }
    return job.view;
  }

  cancel(id: string): JobView {
    const job = this.mustGet(id);
    this.droppedAt.delete(id);
    if (!ACTIVE.has(job.view.status)) throw new ApiError(409, `job is ${job.view.status}`);
    job.view.status = 'cancelled';
    job.view.phase = 'done';
    job.view.pauseReason = 'cancelled by operator';
    job.view.finishedAt = now();
    job.view.route = undefined;
    this.releaseDock(job.view.depotId, job.view.turtleId);
    this.releaseSpot(job.view.depotId, job.view.turtleId);
    this.save(job);
    this.log('warn', `Job "${job.view.name}" cancelled`, job.view.turtleId);
    return job.view;
  }

  deleteJob(id: string): void {
    const job = this.mustGet(id);
    if (job.view.status === 'running' || job.view.status === 'pausing') throw new ApiError(409, 'pause or cancel the job first');
    this.jobs.delete(id);
    this.db.prepare('DELETE FROM jobs WHERE id=?').run(id);
    this.fleet.broadcast({ type: 'job_removed', id });
    this.fleet.touchTurtle(job.view.turtleId);
  }

  // ------------------------------------------------------------------ automatic resume

  static readonly AUTO_RESUME_WINDOW_MS = 15 * 60_000;
  static readonly AUTO_RESUME_PER_HOUR = 3;

  /**
   * A turtle is back. If its job paused only because the turtle dropped and the job
   * opted in, resume it — within bounds, and only if the turtle knows where it is.
   */
  private maybeAutoResume(turtleId: string, attempt = 0): void {
    const job = this.activeJobFor(turtleId);
    if (!job) return;
    const id = job.view.id;
    const since = this.droppedAt.get(id);
    if (since === undefined || !job.view.policy.autoResume) return;
    if (job.view.status === 'pausing' || this.runners.has(id)) {
      // The old run is still winding down; try again shortly.
      if (attempt < 40) setTimeout(() => this.maybeAutoResume(turtleId, attempt + 1), 250);
      return;
    }
    if (job.view.status !== 'paused') return;
    const name = job.view.name;
    const t = now();
    this.droppedAt.delete(id);
    if (t - since > JobManager.AUTO_RESUME_WINDOW_MS) {
      this.log('warn', `Job "${name}" not resumed automatically: the turtle was gone for ${Math.round((t - since) / 60000)} min (limit 15)`, turtleId);
      return;
    }
    const recent = (this.autoResumes.get(id) ?? []).filter((x) => t - x < 3600_000);
    if (recent.length >= JobManager.AUTO_RESUME_PER_HOUR) {
      this.log('warn', `Job "${name}" not resumed automatically: it already did so ${recent.length} times this hour`, turtleId);
      return;
    }
    const st = this.fleet.getTurtle(turtleId)?.state;
    if (!st || st.hold || st.pose.position !== 'known' || st.pose.headingConfidence !== 'known') {
      this.log('warn', `Job "${name}" not resumed automatically: the turtle ${st?.hold ? 'is stopped' : 'is unsure of its position or heading'}`, turtleId);
      return;
    }
    try {
      this.start(id);
      this.autoResumes.set(id, [...recent, t]);
      this.log('info', `Job "${name}" resumed automatically after its turtle reconnected`, turtleId);
    } catch (e) {
      this.log('warn', `Job "${name}" not resumed automatically: ${(e as Error).message}`, turtleId);
    }
  }

  // ------------------------------------------------------------------ campaigns & group actions

  /** Create several jobs at once (all validated first). Optionally start them. */
  createCampaign(input: unknown): { campaignId: string; jobs: JobView[]; skipped: string[] } {
    const c = CampaignSchema.parse(input);
    const campaignId = newId('k');
    type Spec = { turtleId: string; strategy: StrategyInput; segments: TunnelParams[]; name: string; lane?: { index: number; count: number } };
    let specs: Spec[];
    let skipped: string[] = [];
    const nameOf = (id: string) => this.fleet.getTurtle(id)?.name ?? id;
    if (c.split) {
      const sp = c.split;
      const turtles = sp.turtleIds.map((id) => ({ id, pos: this.fleet.getTurtle(id)?.state?.pose.pos }));
      // Lanes split the width; for a quarry each lane keeps the full depth.
      const asTunnel: TunnelParams = sp.strategy === 'tunnel' ? sp.params : { origin: sp.params.origin, heading: sp.params.heading, width: sp.params.width, height: 1, length: sp.params.length };
      const r = splitTunnel(asTunnel, turtles);
      skipped = r.skipped.map(nameOf);
      specs = r.lanes.map((l) => {
        const strategy: StrategyInput =
          sp.strategy === 'tunnel' ? { strategy: 'tunnel', params: l.params } : { strategy: 'quarry', params: { ...sp.params, origin: l.params.origin, width: l.params.width } };
        return { turtleId: l.turtleId, strategy, segments: segmentsFor(strategy), name: `${c.name} · lane ${l.index + 1}/${r.lanes.length} · ${nameOf(l.turtleId)}`, lane: { index: l.index, count: r.lanes.length } };
      });
    } else {
      specs = c.jobs!.map((j) => {
        const strategy = { strategy: j.strategy, params: j.params } as StrategyInput;
        return { turtleId: j.turtleId, strategy, segments: segmentsFor(strategy), name: c.jobs!.length > 1 ? `${c.name} · ${nameOf(j.turtleId)}` : c.name };
      });
    }
    this.validateNew(specs, c.depotId);
    const jobs = specs.map((s) =>
      this.insertJob({ name: s.name, ...s.strategy, depotId: c.depotId, turtleId: s.turtleId, policy: c.policy }, { campaignId, campaignName: c.name, lane: s.lane }),
    );
    this.log('info', `Campaign "${c.name}": ${jobs.length} job(s)${skipped.length ? `; skipped ${skipped.join(', ')} (more turtles than columns)` : ''}`);
    if (c.start) for (const j of jobs) this.start(j.id);
    return { campaignId, jobs: jobs.map((j) => this.jobs.get(j.id)!.view), skipped };
  }

  /** Start/pause/cancel every job in a set; per-job results (some may not apply). */
  private applyAll(ids: string[], action: 'start' | 'pause' | 'cancel'): { jobId: string; ok: boolean; error?: string }[] {
    return ids.map((id) => {
      const j = this.jobs.get(id)!;
      try {
        if (action === 'start') {
          if (j.view.status !== 'ready' && j.view.status !== 'paused') return { jobId: id, ok: false, error: `job is ${j.view.status}` };
          this.start(id);
        } else if (action === 'pause') {
          if (j.view.status !== 'running') return { jobId: id, ok: false, error: `job is ${j.view.status}` };
          this.pause(id);
        } else {
          if (!ACTIVE.has(j.view.status)) return { jobId: id, ok: false, error: `job is ${j.view.status}` };
          this.cancel(id);
        }
        return { jobId: id, ok: true };
      } catch (e) {
        return { jobId: id, ok: false, error: (e as Error).message };
      }
    });
  }

  campaignAction(campaignId: string, action: 'start' | 'pause' | 'cancel') {
    const ids = [...this.jobs.values()].filter((j) => j.view.campaignId === campaignId).map((j) => j.view.id);
    if (!ids.length) throw new ApiError(404, 'unknown campaign');
    return this.applyAll(ids, action);
  }

  /** Act on the unfinished jobs of some turtles (e.g. a selection or a fleet group). */
  turtlesAction(turtleIds: string[], action: 'start' | 'pause' | 'cancel') {
    const ids = turtleIds.map((t) => this.activeJobFor(t)?.view.id).filter((x): x is string => !!x);
    return this.applyAll(ids, action);
  }

  // ------------------------------------------------------------------ go-to tasks

  /**
   * Drive a turtle to a cell through known space, following the traffic rules. Never
   * digs. Manual commands, stops and disconnects end it.
   */
  goto(turtleId: string, target: Vec3): void {
    const t = this.fleet.getTurtle(turtleId);
    if (!t) throw new ApiError(404, 'unknown turtle');
    if (t.connection === 'offline') throw new ApiError(409, `${t.name} is offline`);
    const job = this.activeJobFor(turtleId);
    if (job && (job.view.status === 'running' || job.view.status === 'pausing')) throw new ApiError(409, `${t.name} is running job "${job.view.name}"; pause it first`);
    if (this.tasks.has(turtleId)) throw new ApiError(409, `${t.name} is already on its way somewhere`);
    const task = { id: newId('g'), target, status: 'running' as 'running' | 'stopping', note: undefined as string | undefined, reason: undefined as string | undefined };
    this.tasks.set(turtleId, task);
    const touch = () => this.fleet.touchTurtle(turtleId);
    const mover = new Mover({
      fleet: this.fleet,
      traffic: this.traffic,
      turtleId,
      world: t.world,
      dimension: t.dimension,
      executor: `goto:${task.id}`,
      isActive: () => task.status === 'running',
      stopReason: () => task.reason ?? 'stopped',
      canDig: () => false,
      extraBlocked: () => this.allDepotChests(t.world, t.dimension),
      onWait: (note) => {
        task.note = note;
        touch();
      },
      log: (level, msg) => this.log(level, msg, turtleId),
    });
    this.traffic.join(turtleId, t.name, t.world, t.dimension, now());
    touch();
    this.log('info', `${t.name}: going to ${fmt(target)}`, turtleId);
    mover
      .moveTo(target)
      .then(() => this.log('info', `${t.name} arrived at ${fmt(target)}`, turtleId))
      .catch((e) => {
        if (e instanceof Interrupt) this.log('warn', `${t.name}: go-to ${fmt(target)} stopped (${e.message})`, turtleId);
        else this.log('error', `${t.name}: go-to ${fmt(target)} failed — ${(e as Error).message}`, turtleId);
      })
      .finally(() => {
        this.traffic.leave(turtleId);
        if (this.tasks.get(turtleId) === task) this.tasks.delete(turtleId);
        touch();
      });
  }

  stopTask(turtleId: string, reason: string): void {
    const task = this.tasks.get(turtleId);
    if (task && task.status === 'running') {
      task.status = 'stopping';
      task.reason = reason;
    }
  }

  /** Has a go-to task (tests). */
  taskRunning(turtleId: string): boolean {
    return this.tasks.has(turtleId);
  }

  private allDepotChests(world: string, dimension: string): Vec3[] {
    const out: Vec3[] = [];
    for (const d of this.depots.values()) {
      if (d.world !== world || d.dimension !== dimension) continue;
      for (const dir of [d.unloadDir, d.fuelDir]) {
        if (!dir) continue;
        if (dir === 'up') out.push({ ...d.dock, y: d.dock.y + 1 });
        else if (dir === 'down') out.push({ ...d.dock, y: d.dock.y - 1 });
        else out.push({ x: d.dock.x + [0, 1, 0, -1][d.dockHeading], y: d.dock.y, z: d.dock.z + [-1, 0, 1, 0][d.dockHeading] });
      }
    }
    return out;
  }

  /** Wait until a job's runner has exited (tests, shutdown). */
  async settled(id: string): Promise<void> {
    await this.runners.get(id);
  }

  // ------------------------------------------------------------------ runner callbacks

  setPhase(job: JobRec, phase: JobPhase): void {
    if (job.view.phase !== phase) {
      job.view.phase = phase;
      this.save(job);
    }
  }

  finished(job: JobRec): void {
    job.view.status = 'completed';
    job.view.phase = 'done';
    job.view.finishedAt = now();
    job.view.route = undefined;
    this.save(job);
    this.log('info', `Job "${job.view.name}" completed: ${job.view.progress.cellsCleared} cells, ${job.view.progress.trips} trip(s), ${job.view.progress.itemsUnloaded} items unloaded`, job.view.turtleId);
  }

  /** The runner stopped because of an interruption (pause, stop, offline...). */
  stopped(job: JobRec, reason: string): void {
    if (job.view.status === 'cancelled') return;
    job.view.status = 'paused';
    job.view.pauseReason ??= reason;
    job.view.route = undefined;
    this.save(job);
    this.log('warn', `Job "${job.view.name}" paused: ${job.view.pauseReason}`, job.view.turtleId);
  }

  /** The runner hit a problem the operator must fix. */
  failed(job: JobRec, code: string, message: string): void {
    if (job.view.status === 'cancelled') return;
    job.view.status = 'paused';
    job.view.pauseReason = 'needs attention';
    job.view.error = { code, message, at: now() };
    job.view.route = undefined;
    this.save(job);
    this.log('error', `Job "${job.view.name}" paused — ${message}`, job.view.turtleId);
  }
}

