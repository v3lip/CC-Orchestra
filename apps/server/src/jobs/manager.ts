/**
 * Jobs and depots: persistence, lifecycle, dock locks, and the hooks that make manual
 * control, stops and disconnects pause a job instead of fighting it.
 */
import {
  type DepotInput,
  type DepotView,
  type EventView,
  type Heading,
  type JobEstimate,
  type JobPhase,
  type JobStatus,
  type JobView,
  type Vec3,
  DepotInput as DepotSchema,
  JobInput as JobSchema,
  JobPolicy,
} from '@ccfleet/protocol';
import type { Db } from '../db';
import { ApiError, type Fleet } from '../fleet';
import { newId, now } from '../util';
import { boxesOverlap, lanes, manhattan, tunnelBox } from './geometry';
import { Interrupt, JobError, JobRunner } from './runner';

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
  private pendingBroadcast = new Set<string>();
  private timer: NodeJS.Timeout;

  constructor(
    private db: Db,
    private fleet: Fleet,
  ) {
    this.load();
    fleet.hooks.operatorAction = (ids, kind) => {
      for (const id of ids) {
        const job = this.activeJobFor(id);
        if (job && (job.view.status === 'running' || job.view.status === 'pausing')) {
          this.pause(job.view.id, kind === 'command' ? 'manual control took over' : kind === 'stop' ? 'turtle stopped by operator' : 'commands cancelled');
        }
      }
    };
    fleet.hooks.disconnected = (id) => {
      const job = this.activeJobFor(id);
      if (job && (job.view.status === 'running' || job.view.status === 'pausing')) this.pause(job.view.id, 'turtle went offline');
    };
    fleet.hooks.removed = (id) => {
      const job = this.activeJobFor(id);
      if (job) this.cancel(job.view.id);
    };
    fleet.hooks.jobOf = (id) => {
      const j = this.activeJobFor(id);
      return j && { id: j.view.id, name: j.view.name, status: j.view.status, phase: j.view.phase };
    };
    fleet.hooks.extraInit = () => ({ jobs: this.listJobs(), depots: this.listDepots() });
    this.timer = setInterval(() => this.flush(), 200);
  }

  close(): void {
    clearInterval(this.timer);
    this.flush();
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
      this.jobs.set(rec.view.id, rec);
    }
  }

  save(job: JobRec): void {
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
   * Serialise use of a depot's dock and its approach. Waits as long as needed (the job
   * shows as 'waiting'). A lock held by an offline turtle stays: it may still be in the way.
   */
  async acquireDock(depotId: string, turtleId: string, stillWanted: () => boolean, onWait?: (holderName: string) => void): Promise<void> {
    let announced: string | undefined;
    for (;;) {
      const holder = this.dockLocks.get(depotId);
      if (!holder || holder === turtleId) {
        this.dockLocks.set(depotId, turtleId);
        this.broadcastDepot(depotId);
        return;
      }
      if (!stillWanted()) throw new Interrupt('stopped while waiting for the dock');
      const t = this.fleet.getTurtle(holder);
      const label = `${t?.name ?? holder}${t && t.connection === 'offline' ? ', offline — it may still be in the way' : ''}`;
      if (label !== announced) {
        announced = label;
        onWait?.(label);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** Does another unfinished job use this depot? */
  depotShared(depotId: string, exceptJobId: string): boolean {
    return [...this.jobs.values()].some((j) => j.view.id !== exceptJobId && j.view.depotId === depotId && ACTIVE.has(j.view.status));
  }

  releaseDock(depotId: string, turtleId: string): void {
    if (this.dockLocks.get(depotId) === turtleId) {
      this.dockLocks.delete(depotId);
      this.broadcastDepot(depotId);
    }
  }

  private broadcastDepot(id: string): void {
    const d = this.depots.get(id);
    if (d) this.fleet.broadcast({ type: 'depot', depot: { ...d, lockedBy: this.dockLocks.get(id) } });
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

  estimate(input: unknown): { estimate: JobEstimate; warnings: string[] } {
    const j = JobSchema.parse(input);
    const depot = this.depots.get(j.depotId);
    if (!depot) throw new ApiError(400, 'unknown depot');
    const p = j.params;
    const nl = lanes(p.height).length;
    const cells = p.width * p.height * p.length;
    const toSite = manhattan(depot.dock, p.origin) + 4;
    const perSlice = p.width * nl + 3 * Math.max(0, nl - 1);
    const blocksPerTrip = 640;
    const trips = Math.max(1, Math.ceil(cells / blocksPerTrip));
    const moves = p.length * perSlice + 2 * toSite + trips * 2 * (toSite + Math.ceil(p.length / 2));
    const seconds = Math.round((moves + cells) * 0.45);
    const warnings: string[] = [];
    const box = tunnelBox(p);
    for (const c of [depot.dock]) {
      if (c.x >= box.min.x && c.x <= box.max.x && c.y >= box.min.y && c.y <= box.max.y && c.z >= box.min.z && c.z <= box.max.z) warnings.push('The dock is inside the tunnel volume.');
    }
    if (toSite > 64) warnings.push(`The tunnel starts ${toSite} blocks from the dock; long trips use a lot of fuel.`);
    const turtle = this.fleet.getTurtle(j.turtleId);
    if (turtle && (turtle.world !== depot.world || turtle.dimension !== depot.dimension)) warnings.push(`The turtle is in ${turtle.world}/${turtle.dimension}, the depot in ${depot.world}/${depot.dimension}.`);
    return {
      estimate: {
        moves,
        fuel: moves,
        seconds,
        trips,
        cells,
        note: 'Estimate: assumes mostly solid rock, ~640 blocks per trip and no detours. Real numbers vary.',
      },
      warnings,
    };
  }

  createJob(input: unknown): JobView {
    const j = JobSchema.parse(input);
    const depot = this.depots.get(j.depotId);
    if (!depot) throw new ApiError(400, 'unknown depot');
    const turtle = this.fleet.getTurtle(j.turtleId);
    if (!turtle) throw new ApiError(400, 'unknown turtle');
    if (this.activeJobFor(j.turtleId)) throw new ApiError(409, `${turtle.name} already has an unfinished job`);
    // Two jobs digging the same cells would fight over them (and their turtles would collide).
    const box = tunnelBox(j.params);
    for (const o of this.jobs.values()) {
      if (!ACTIVE.has(o.view.status) || o.view.world !== depot.world || o.view.dimension !== depot.dimension) continue;
      if (boxesOverlap(box, tunnelBox(o.view.params))) throw new ApiError(409, `This tunnel overlaps job "${o.view.name}". Move it or finish/cancel that job first.`);
    }
    const { estimate } = this.estimate(input);
    const t = now();
    const rec: JobRec = {
      view: {
        id: newId('j'),
        name: j.name,
        strategy: 'tunnel',
        params: j.params,
        policy: JobPolicy.parse(j.policy),
        exclusions: j.exclusions,
        world: depot.world,
        dimension: depot.dimension,
        depotId: depot.id,
        turtleId: j.turtleId,
        status: 'ready',
        phase: 'idle',
        progress: { unitsDone: 0, unitsTotal: j.params.length, cellsCleared: 0, cellsSkipped: 0, trips: 0, itemsUnloaded: 0 },
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
    job.view.status = 'running';
    job.view.pauseReason = undefined;
    job.view.note = undefined;
    job.view.error = undefined;
    job.view.startedAt ??= now();
    this.save(job);
    this.log('info', `Job "${job.view.name}" ${job.view.progress.unitsDone || job.checkpoint.servicing ? 'resumed' : 'started'}`, job.view.turtleId);
    const runner = new JobRunner(this, this.fleet, job);
    const p = runner.run().finally(() => this.runners.delete(id));
    this.runners.set(id, p);
    return job.view;
  }

  /** Pause after the current step. */
  pause(id: string, reason = 'paused by operator'): JobView {
    const job = this.mustGet(id);
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
    if (!ACTIVE.has(job.view.status)) throw new ApiError(409, `job is ${job.view.status}`);
    job.view.status = 'cancelled';
    job.view.phase = 'done';
    job.view.pauseReason = 'cancelled by operator';
    job.view.finishedAt = now();
    job.view.route = undefined;
    this.releaseDock(job.view.depotId, job.view.turtleId);
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

