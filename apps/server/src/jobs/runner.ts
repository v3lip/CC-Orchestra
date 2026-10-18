/**
 * Executes one tunnel job on one turtle by issuing atomic commands through the
 * turtle's normal queue. Everything it decides is derived from the turtle's reported
 * state and the observed map, so a run can be stopped at any step and started again
 * from the persisted checkpoint.
 */
import { type Dir, type Heading, type MapBlock, type Op, type TurtleState, type Vec3, FUEL_ITEMS, HEADING_VECTORS, DEFAULT_PROTECTED_BLOCKS } from '@ccfleet/protocol';
import type { Fleet, StepResult } from '../fleet';
import { eq, fmt, inBox, key, manhattan, sliceStations, tunnelBox, tunnelLocal } from './geometry';
import { planPath, type NavContext } from './nav';
import type { JobManager, JobRec } from './manager';

/** Jobs rely on the verified drop/suck/inventoryInfo ops and the dig guard added in agent 0.3.0. */
export function agentSupportsJobs(version: string): boolean {
  const m = /^(?:lua|sim)-(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > 0 || min >= 3;
}

/** The job was paused/cancelled or the turtle became unavailable: stop quietly. */
export class Interrupt extends Error {}
/** Something needs the operator: pause with an actionable message. */
export class JobError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_REPLANS = 30;
const MAX_RETRIES_PER_CELL = 24; // gravel/sand columns can refill a cell many times
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DIR_TEXT: Record<Dir, string> = { front: 'in front of', up: 'above', down: 'below' };

export class JobRunner {
  private unpassable = new Set<string>();
  private cleared = new Set<string>();
  private lastRouteBroadcast = 0;
  readonly executor: string;

  constructor(
    private mgr: JobManager,
    private fleet: Fleet,
    private job: JobRec,
  ) {
    this.executor = `job:${job.view.id}`;
  }

  private get v() {
    return this.job.view;
  }
  private get cp() {
    return this.job.checkpoint;
  }
  private get depot() {
    const d = this.mgr.getDepot(this.v.depotId);
    if (!d) throw new JobError('no_depot', 'The depot for this job was deleted.');
    return d;
  }

  async run(): Promise<void> {
    try {
      this.ensureReady();
      this.mgr.setPhase(this.job, 'traveling');
      if (this.cp.servicing) await this.service(this.cp.servicing === 'finish');
      while (this.cp.slice < this.v.params.length) {
        this.mgr.setPhase(this.job, 'mining');
        await this.mineSlice(this.cp.slice);
        this.cp.slice++;
        this.v.progress.unitsDone = this.cp.slice;
        this.mgr.save(this.job);
      }
      if (this.v.policy.returnHomeWhenDone) await this.service(true);
      this.mgr.finished(this.job);
    } catch (e) {
      if (e instanceof Interrupt) this.mgr.stopped(this.job, e.message);
      else if (e instanceof JobError) this.mgr.failed(this.job, e.code, e.message);
      else this.mgr.failed(this.job, 'internal', (e as Error).message ?? String(e));
    } finally {
      this.mgr.releaseDock(this.v.depotId, this.v.turtleId);
    }
  }

  // ------------------------------------------------------------------ state helpers

  private turtle(): TurtleState {
    const t = this.fleet.turtleState(this.v.turtleId);
    if (!t) throw new Interrupt('turtle removed');
    if (!t.online) throw new Interrupt('turtle went offline');
    if (!t.state) throw new JobError('no_state', 'No telemetry from the turtle yet.');
    return t.state;
  }

  private pos(): Vec3 {
    const pose = this.turtle().pose;
    if (pose.position !== 'known' || !pose.pos) throw new JobError('pose_uncertain', 'Turtle position is not known. Use GPS fix or Calibrate, then resume.');
    return pose.pos;
  }

  private heading(): Heading {
    const pose = this.turtle().pose;
    if (pose.headingConfidence !== 'known' || pose.heading === undefined) throw new JobError('pose_uncertain', 'Turtle heading is not known. Calibrate it, then resume.');
    return pose.heading as Heading;
  }

  private ensureReady(): void {
    const t = this.fleet.turtleState(this.v.turtleId);
    if (!t) throw new JobError('no_turtle', 'The assigned turtle no longer exists.');
    if (!t.online) throw new JobError('offline', 'The turtle is offline.');
    if (t.world !== this.v.world || t.dimension !== this.v.dimension) {
      throw new JobError('wrong_world', `The turtle is registered in ${t.world}/${t.dimension}, the depot in ${this.v.world}/${this.v.dimension}.`);
    }
    if (t.state?.hold) throw new JobError('held', 'The turtle is paused or e-stopped. Press Resume on the turtle first.');
    const version = this.fleet.getTurtle(this.v.turtleId)?.agentVersion ?? '';
    if (!agentSupportsJobs(version)) {
      throw new JobError('agent_outdated', `The turtle runs agent ${version || 'unknown'}; jobs need 0.3.0 or newer (verified unloading, dig protection). Run "install" on the turtle (no code needed), then resume.`);
    }
    this.pos();
    this.heading();
  }

  private async step(op: Op, args: Record<string, unknown> = {}): Promise<StepResult> {
    if (this.v.status !== 'running') throw new Interrupt(this.v.pauseReason ?? 'paused');
    const r = await this.fleet.runStep(this.v.turtleId, op, args, this.executor);
    if (r.status === 'undeliverable' || r.status === 'unknown') throw new Interrupt('turtle went offline');
    if (r.status === 'cancelled') throw new Interrupt(this.v.pauseReason ?? 'command cancelled');
    if (r.status === 'rejected' && r.code === 'held') throw new Interrupt('turtle was stopped');
    if (r.status === 'rejected' || r.status === 'expired') throw new JobError(r.code ?? 'rejected', `${op} was refused: ${r.reason ?? r.status}`);
    return r;
  }

  private known(p: Vec3): MapBlock | undefined {
    return this.fleet.mapCell(this.v.world, this.v.dimension, p);
  }

  private inWork(p: Vec3): boolean {
    return !!tunnelLocal(this.v.params, p) && !this.v.exclusions.some((b) => inBox(b, p));
  }

  private isProtectedName(name: string | null | undefined): boolean {
    return !!name && DEFAULT_PROTECTED_BLOCKS.some((pat) => name.includes(pat));
  }

  private canDig(p: Vec3, block: string | null): boolean {
    return this.inWork(p) && !this.unpassable.has(key(p)) && !this.isProtectedName(block);
  }

  private depotCells(): Vec3[] {
    const d = this.depot;
    const at = (dir?: Dir) => {
      if (!dir) return undefined;
      if (dir === 'up') return { ...d.dock, y: d.dock.y + 1 };
      if (dir === 'down') return { ...d.dock, y: d.dock.y - 1 };
      const h = HEADING_VECTORS[d.dockHeading];
      return { x: d.dock.x + h.x, y: d.dock.y, z: d.dock.z + h.z };
    };
    return [at(d.unloadDir), at(d.fuelDir)].filter((c): c is Vec3 => !!c);
  }

  // ------------------------------------------------------------------ movement

  private async face(h: Heading): Promise<void> {
    const diff = (h - this.heading() + 4) % 4;
    if (diff === 0) return;
    const ops: Op[] = diff === 1 ? ['turnRight'] : diff === 3 ? ['turnLeft'] : ['turnRight', 'turnRight'];
    for (const op of ops) {
      const r = await this.step(op);
      if (r.status !== 'succeeded') throw new JobError(r.code ?? 'failed', `${op} failed: ${r.reason}`);
    }
  }

  private navContext(from: Vec3, to: Vec3): NavContext {
    const margin = 16;
    const box = tunnelBox(this.v.params);
    const min = { x: Math.min(from.x, to.x) - margin, y: Math.min(from.y, to.y) - 8, z: Math.min(from.z, to.z) - margin };
    const max = { x: Math.max(from.x, to.x) + margin, y: Math.max(from.y, to.y) + 8, z: Math.max(from.z, to.z) + margin };
    // Include the tunnel itself when it is between the two points.
    for (const a of ['x', 'y', 'z'] as const) {
      if (box.min[a] >= min[a] - margin && box.max[a] <= max[a] + margin) {
        min[a] = Math.min(min[a], box.min[a]);
        max[a] = Math.max(max[a], box.max[a]);
      }
    }
    const rows = this.fleet.queryMap({ world: this.v.world, dimension: this.v.dimension, x0: min.x, x1: max.x, z0: min.z, z1: max.z, y0: min.y, y1: max.y, limit: 200_000 }).blocks;
    const cells = new Map(rows.map((b) => [key(b), b]));
    const blocked = new Set<string>(this.unpassable);
    for (const p of this.fleet.turtlePositions(this.v.world, this.v.dimension, this.v.turtleId)) blocked.add(key(p));
    for (const p of this.depotCells()) blocked.add(key(p));
    return { cell: (p) => cells.get(key(p)), blocked, canDig: (p, b) => this.canDig(p, b), bounds: { min, max } };
  }

  async moveTo(goal: Vec3): Promise<void> {
    const g = this.known(goal);
    if (g?.cell === 'solid' && this.isProtectedName(g.block)) {
      throw new JobError('protected', `Protected block ${g.block} at ${fmt(goal)} is in the way. Remove it or add an exclusion, then resume.`);
    }
    for (let attempt = 0; attempt < MAX_REPLANS; attempt++) {
      const here = this.pos();
      if (eq(here, goal)) return;
      const path = planPath(this.navContext(here, goal), here, goal);
      if (!path) {
        throw new JobError('no_route', `No known safe route from ${fmt(here)} to ${fmt(goal)}. Drive the turtle closer or clear a path, then resume.`);
      }
      this.publishRoute(path);
      let ok = true;
      for (const next of path) {
        if (!(await this.stepInto(next))) {
          ok = false;
          break;
        }
      }
      if (ok) return;
    }
    throw new JobError('no_route', `Gave up reaching ${fmt(goal)} after ${MAX_REPLANS} re-plans.`);
  }

  private publishRoute(path: Vec3[]): void {
    this.v.route = path.slice(0, 64);
    const t = Date.now();
    if (t - this.lastRouteBroadcast > 500) {
      this.lastRouteBroadcast = t;
      this.mgr.broadcast(this.job);
    }
  }

  private markCleared(p: Vec3): void {
    if (this.inWork(p) && !this.cleared.has(key(p))) {
      this.cleared.add(key(p));
      this.v.progress.cellsCleared++;
    }
  }

  /** Dig one adjacent cell. Returns false if it cannot be cleared (unbreakable). */
  private async digAt(digOp: 'dig' | 'digUp' | 'digDown', p: Vec3): Promise<boolean> {
    const r = await this.step(digOp);
    if (r.status === 'succeeded' || r.code === 'nothing_to_dig') return true;
    if (r.code === 'protected') throw new JobError('protected', `${r.reason} at ${fmt(p)} inside the job area. Remove it or add an exclusion, then resume.`);
    if (r.code === 'unbreakable') {
      this.unpassable.add(key(p));
      this.v.progress.cellsSkipped++;
      this.mgr.log('warn', `${this.v.name}: unbreakable block at ${fmt(p)}; skipping it`);
      return false;
    }
    throw new JobError(r.code ?? 'dig_failed', `Dig at ${fmt(p)} failed: ${r.reason ?? r.status}`);
  }

  /** Move into an adjacent cell, digging it if this job is allowed to. False = re-plan. */
  private async stepInto(next: Vec3): Promise<boolean> {
    const here = this.pos();
    const dy = next.y - here.y;
    let moveOp: Op;
    let digOp: 'dig' | 'digUp' | 'digDown';
    if (dy !== 0) {
      moveOp = dy > 0 ? 'up' : 'down';
      digOp = dy > 0 ? 'digUp' : 'digDown';
    } else {
      const h = HEADING_VECTORS.findIndex((v) => v.x === next.x - here.x && v.z === next.z - here.z);
      if (h < 0) throw new Error(`non-adjacent step ${fmt(here)} -> ${fmt(next)}`);
      await this.face(h as Heading);
      moveOp = 'forward';
      digOp = 'dig';
    }
    for (let i = 0; i < MAX_RETRIES_PER_CELL; i++) {
      const c = this.known(next);
      if (c?.cell === 'solid') {
        if (!this.canDig(next, c.block)) return false;
        if (!(await this.digAt(digOp, next))) return false;
      }
      await this.serviceIfNeeded(next);
      const r = await this.step(moveOp);
      if (r.status === 'succeeded') {
        this.markCleared(next);
        return true;
      }
      if (r.code === 'out_of_fuel') throw new JobError('out_of_fuel', 'The turtle ran out of fuel. Add fuel to it, then resume.');
      if (r.code !== 'obstructed') throw new JobError(r.code ?? 'move_failed', `${moveOp} failed: ${r.reason}`);
      // Obstructed: the agent inspected that direction, so the map now says why.
      const occupied = this.fleet.turtlePositions(this.v.world, this.v.dimension, this.v.turtleId).some((p) => eq(p, next));
      const after = this.known(next);
      if (occupied || !after || after.cell !== 'solid') {
        // Another turtle or an entity: wait a little, then try another route.
        if (i >= 4) return false;
        await sleep(1000);
        continue;
      }
      if (!this.canDig(next, after.block)) return false;
    }
    return false;
  }

  /** Clear a cell directly above or below the turtle. */
  private async clearVertical(p: Vec3): Promise<void> {
    const here = this.pos();
    const digOp = p.y > here.y ? 'digUp' : 'digDown';
    for (let i = 0; i < MAX_RETRIES_PER_CELL; i++) {
      const c = this.known(p);
      if (c && c.cell !== 'solid') {
        this.markCleared(p);
        return;
      }
      if (c && !this.canDig(p, c.block)) {
        if (this.isProtectedName(c.block)) throw new JobError('protected', `Protected block ${c.block} at ${fmt(p)} inside the job area. Remove it or add an exclusion, then resume.`);
        return; // excluded or unbreakable: leave it
      }
      if (!(await this.digAt(digOp, p))) return;
      await this.serviceIfNeeded();
      // The agent re-inspects after digging; gravel may have refilled the cell.
    }
    throw new JobError('stuck', `Cell ${fmt(p)} keeps refilling (falling blocks?). Check it, then resume.`);
  }

  // ------------------------------------------------------------------ mining

  private async mineSlice(d: number): Promise<void> {
    for (const st of sliceStations(this.v.params, d)) {
      if (!this.inWork(st.pos)) continue;
      await this.moveTo(st.pos);
      for (const c of st.extra) if (this.inWork(c)) await this.clearVertical(c);
    }
  }

  // ------------------------------------------------------------------ service trips

  private freeSlots(st: TurtleState): number {
    const reserved = new Set([this.v.policy.fuelSlot, ...this.v.policy.keepSlots].filter((s) => s > 0));
    let free = 0;
    for (let s = 1; s <= 16; s++) if (!reserved.has(s) && !st.inventory.some((i) => i.slot === s)) free++;
    return free;
  }

  private costBetween(a: Vec3, b: Vec3): number {
    // Estimate: routes follow known space, rarely a straight line.
    return Math.ceil(manhattan(a, b) * 1.25) + 10;
  }

  /** Burn fuel carried in the fuel slot until `target` (true if the level rose). */
  private async burnCarriedFuel(target: number): Promise<boolean> {
    const st = this.turtle();
    const slot = this.v.policy.fuelSlot;
    if (st.fuel === 'unlimited' || slot === 0) return false;
    const item = st.inventory.find((i) => i.slot === slot);
    if (!item || !FUEL_ITEMS.has(item.name) || st.fuel >= target) return false;
    const before = st.fuel;
    await this.step('select', { slot });
    const n = Math.min(item.count, Math.max(1, Math.ceil((target - st.fuel) / 80)));
    await this.step('refuel', { count: n });
    await this.step('select', { slot: 1 });
    const after = this.turtle().fuel;
    return typeof after === 'number' && after > before;
  }

  /**
   * Check inventory and fuel; go to the depot if needed. `next` is the cell the turtle
   * is about to enter (resume there afterwards).
   */
  private async serviceIfNeeded(_next?: Vec3): Promise<void> {
    if (this.cp.servicing || this.v.phase === 'returning' || this.v.phase === 'unloading' || this.v.phase === 'refueling') return;
    let st = this.turtle();
    const reason = this.freeSlots(st) <= this.v.policy.minFreeSlots ? 'inventory' : undefined;
    let fuelLow = false;
    if (typeof st.fuel === 'number') {
      const need = this.costBetween(this.pos(), this.depot.dock) + this.v.policy.fuelReserve;
      if (st.fuel < need) {
        await this.burnCarriedFuel(need + 200);
        st = this.turtle();
        fuelLow = typeof st.fuel === 'number' && st.fuel < need;
      }
    }
    if (!reason && !fuelLow) return;
    this.mgr.log('info', `${this.v.name}: returning to the depot (${reason === 'inventory' ? 'inventory nearly full' : 'fuel low'})`);
    await this.service(false);
  }

  private async service(final: boolean): Promise<void> {
    if (!this.cp.resume && !final) this.cp.resume = { pos: this.pos(), heading: this.heading() };
    this.cp.servicing = final ? 'finish' : 'trip';
    this.mgr.save(this.job);

    const depot = this.depot;
    this.mgr.setPhase(this.job, 'returning');
    await this.moveTo(depot.dock);
    await this.mgr.acquireDock(depot.id, this.v.turtleId, () => this.v.status === 'running');
    await this.face(depot.dockHeading as Heading);

    this.mgr.setPhase(this.job, 'unloading');
    await this.unload();
    this.mgr.setPhase(this.job, 'refueling');
    await this.refuel(final);
    this.mgr.releaseDock(depot.id, this.v.turtleId);

    this.v.progress.trips++;
    this.cp.servicing = undefined;
    this.mgr.save(this.job);
    if (final) {
      this.mgr.setPhase(this.job, 'done');
      return;
    }
    if (this.cp.resume) {
      this.mgr.setPhase(this.job, 'traveling');
      await this.moveTo(this.cp.resume.pos);
      await this.face(this.cp.resume.heading as Heading);
      this.cp.resume = undefined;
      this.mgr.save(this.job);
    }
    this.mgr.setPhase(this.job, 'mining');
  }

  private async unload(): Promise<void> {
    const dir = this.depot.unloadDir;
    const where = `${DIR_TEXT[dir]} the dock at ${fmt(this.depot.dock)}`;
    const info = await this.step('inventoryInfo', { dir });
    if (info.status !== 'succeeded') {
      throw new JobError('chest_missing', `No chest ${where}. Place one there (nothing was dropped), then resume.`);
    }
    const { fuelSlot, keepSlots } = this.v.policy;
    const items = [...this.turtle().inventory].sort((a, b) => a.slot - b.slot);
    for (const it of items) {
      if (keepSlots.includes(it.slot)) continue;
      if (it.slot === fuelSlot && FUEL_ITEMS.has(it.name)) continue;
      const r = await this.step('drop', { dir, slot: it.slot });
      if (r.code === 'no_inventory') throw new JobError('chest_missing', `The chest ${where} disappeared while unloading. Nothing was dropped into the world. Replace it, then resume.`);
      if (r.code === 'inventory_full') throw new JobError('chest_full', `The chest ${where} is full. Empty it, then resume.`);
      if (r.status !== 'succeeded') throw new JobError(r.code ?? 'unload_failed', `Unloading slot ${it.slot} failed: ${r.reason}`);
      const data = r.data as { dropped?: number; partial?: boolean; verified?: boolean } | undefined;
      this.v.progress.itemsUnloaded += data?.dropped ?? 0;
      if (data?.verified === false) this.mgr.log('warn', `${this.v.name}: chest count did not match after unloading slot ${it.slot} (a hopper draining it?)`);
      if (data?.partial) throw new JobError('chest_full', `The chest ${where} filled up while unloading. Empty it, then resume.`);
    }
    await this.step('select', { slot: 1 });
  }

  private async refuel(final: boolean): Promise<void> {
    let st = this.turtle();
    if (st.fuel === 'unlimited') return;
    const limit = typeof st.fuelLimit === 'number' ? st.fuelLimit : Infinity;
    const target = Math.min(this.v.policy.refuelTarget, limit);
    const depot = this.depot;
    const resume = this.cp.resume?.pos ?? this.v.params.origin;
    const need = final ? 0 : 2 * this.costBetween(depot.dock, resume) + this.v.policy.fuelReserve;

    // 1. Top up from the fuel chest, if the depot has one.
    if (typeof st.fuel === 'number' && st.fuel < target && depot.fuelDir) {
      const slot = this.v.policy.fuelSlot || 1;
      for (let i = 0; i < 6; i++) {
        st = this.turtle();
        if (typeof st.fuel !== 'number' || st.fuel >= target) break;
        const want = Math.min(64, Math.max(1, Math.ceil((target - st.fuel) / 80)));
        const r = await this.step('suck', { dir: depot.fuelDir, slot, count: want });
        if (r.code === 'no_inventory') throw new JobError('fuel_chest_missing', `No fuel chest ${DIR_TEXT[depot.fuelDir]} the dock. Place one or remove it from the depot settings, then resume.`);
        const data = r.data as { taken?: number; slots?: { slot: number; name: string; count: number }[] } | undefined;
        if (!data?.taken) break; // empty
        for (const s of data.slots ?? []) {
          await this.step('select', { slot: s.slot });
          const burn = await this.step('refuel');
          if (burn.status !== 'succeeded') {
            // Not fuel: put it back where it came from (verified), then tell the operator.
            await this.step('drop', { dir: depot.fuelDir, slot: s.slot });
            throw new JobError('fuel_chest_contaminated', `The fuel chest contains ${s.name}, which is not fuel. Remove it, then resume.`);
          }
        }
      }
      await this.step('select', { slot: 1 });
    }

    // 2. Only burn the carried reserve if that is the only way to continue.
    st = this.turtle();
    if (typeof st.fuel === 'number' && st.fuel < need) await this.burnCarriedFuel(need + 200);

    st = this.turtle();
    if (typeof st.fuel === 'number' && st.fuel < need) {
      const where = this.v.policy.fuelSlot ? `slot ${this.v.policy.fuelSlot}` : 'the turtle';
      throw new JobError('insufficient_fuel', `Fuel ${st.fuel} is below the estimated ${need} needed to continue. Put fuel in ${where}${depot.fuelDir ? ' or the fuel chest' : ''}, then resume.`);
    }
  }
}
