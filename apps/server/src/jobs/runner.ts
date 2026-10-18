/**
 * Executes one tunnel job on one turtle by issuing atomic commands through the
 * turtle's normal queue. Everything it decides is derived from the turtle's reported
 * state and the observed map, so a run can be stopped at any step and started again
 * from the persisted checkpoint. Movement and traffic rules live in `Mover`.
 */
import { type Dir, type Heading, type TurtleState, type Vec3, FUEL_ITEMS, HEADING_VECTORS } from '@ccfleet/protocol';
import type { Fleet } from '../fleet';
import { eq, fmt, inBox, key, manhattan, sliceStations, tunnelBox, tunnelLocal } from './geometry';
import { Interrupt, JobError, Mover, isProtectedName, sleep } from './mover';
import type { Traffic } from './traffic';
import type { JobManager, JobRec } from './manager';

export { Interrupt, JobError };

/** Jobs rely on the verified drop/suck/inventoryInfo ops and the dig guard added in agent 0.3.0. */
export function agentSupportsJobs(version: string): boolean {
  const m = /^(?:lua|sim)-(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > 0 || min >= 3;
}

const MAX_RETRIES_PER_CELL = 24;
const DIR_TEXT: Record<Dir, string> = { front: 'in front of', up: 'above', down: 'below' };

export class JobRunner {
  private cleared = new Set<string>();
  private lastRouteBroadcast = 0;
  /** Set once the turtle has stood on the dock; the dock is freed when it steps off. */
  private visitedDock = false;
  private m: Mover;
  readonly executor: string;

  constructor(
    private mgr: JobManager,
    private fleet: Fleet,
    private traffic: Traffic,
    private job: JobRec,
  ) {
    this.executor = `job:${job.view.id}`;
    const v = job.view;
    this.m = new Mover({
      fleet,
      traffic,
      turtleId: v.turtleId,
      world: v.world,
      dimension: v.dimension,
      executor: this.executor,
      isActive: () => this.v.status === 'running',
      stopReason: () => this.v.pauseReason ?? 'paused',
      canDig: (p) => this.inWork(p),
      extraBlocked: () => this.depotCells(),
      includeBox: () => tunnelBox(this.v.params),
      beforeMove: () => this.serviceIfNeeded(),
      onRoute: (path) => this.publishRoute(path),
      onEntered: (p) => this.entered(p),
      onUnbreakable: (p) => {
        this.v.progress.cellsSkipped++;
        this.mgr.log('warn', `${this.v.name}: unbreakable block at ${fmt(p)}; skipping it`);
      },
      onWait: (note) => this.setNote(note),
      log: (level, msg) => this.mgr.log(level, msg, this.v.turtleId),
    });
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
    this.traffic.join(this.v.turtleId, this.fleet.getTurtle(this.v.turtleId)?.name ?? this.v.name, this.v.world, this.v.dimension, this.v.startedAt ?? Date.now());
    try {
      this.ensureReady();
      this.mgr.setPhase(this.job, 'traveling');
      if (this.cp.servicing === 'back') await this.returnToWork();
      else if (this.cp.servicing) await this.service(this.cp.servicing === 'finish');
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
      this.traffic.leave(this.v.turtleId);
      this.setNote(undefined);
      // Paused mid-trip the turtle may still be on the dock or a waiting spot: keep them
      // until it moves on (resuming finishes the trip).
      if (!this.cp.servicing) {
        this.mgr.releaseDock(this.v.depotId, this.v.turtleId);
        this.mgr.releaseSpot(this.v.depotId, this.v.turtleId);
      }
    }
  }

  // ------------------------------------------------------------------ helpers

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
    this.m.pos();
    this.m.heading();
  }

  private setNote(note: string | undefined): void {
    if (this.v.note !== note) {
      this.v.note = note;
      this.mgr.broadcast(this.job);
    }
  }

  private inWork(p: Vec3): boolean {
    return !!tunnelLocal(this.v.params, p) && !this.v.exclusions.some((b) => inBox(b, p));
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

  private publishRoute(path: Vec3[]): void {
    this.v.route = path.slice(0, 64);
    const t = Date.now();
    if (t - this.lastRouteBroadcast > 500) {
      this.lastRouteBroadcast = t;
      this.mgr.broadcast(this.job);
    }
  }

  private entered(p: Vec3): void {
    if (this.inWork(p) && !this.cleared.has(key(p))) {
      this.cleared.add(key(p));
      this.v.progress.cellsCleared++;
    }
    const dock = this.mgr.getDepot(this.v.depotId)?.dock;
    if (dock && eq(p, dock)) this.visitedDock = true;
    else if (this.visitedDock) {
      // Stepped off the dock: the next turtle may come in.
      this.visitedDock = false;
      this.mgr.releaseDock(this.v.depotId, this.v.turtleId);
    }
  }

  /** Clear a cell directly above or below the turtle. */
  private async clearVertical(p: Vec3): Promise<void> {
    const here = this.m.pos();
    const digOp = p.y > here.y ? 'digUp' : 'digDown';
    for (let i = 0; i < MAX_RETRIES_PER_CELL; i++) {
      const c = this.m.known(p);
      if (c && c.cell !== 'solid') {
        this.entered(p);
        return;
      }
      if (c && (isProtectedName(c.block) || !this.inWork(p) || this.m.unpassable.has(key(p)))) {
        if (isProtectedName(c.block)) throw new JobError('protected', `Protected block ${c.block} at ${fmt(p)} inside the job area. Remove it or add an exclusion, then resume.`);
        return; // excluded or unbreakable: leave it
      }
      if (!(await this.m.digAt(digOp, p))) return;
      await this.serviceIfNeeded();
      // The agent re-inspects after digging; gravel may have refilled the cell.
    }
    throw new JobError('stuck', `Cell ${fmt(p)} keeps refilling (falling blocks?). Check it, then resume.`);
  }

  // ------------------------------------------------------------------ mining

  private async mineSlice(d: number): Promise<void> {
    for (const st of sliceStations(this.v.params, d)) {
      if (!this.inWork(st.pos)) continue;
      await this.m.moveTo(st.pos);
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
    const st = this.m.turtle();
    const slot = this.v.policy.fuelSlot;
    if (st.fuel === 'unlimited' || slot === 0) return false;
    const item = st.inventory.find((i) => i.slot === slot);
    if (!item || !FUEL_ITEMS.has(item.name) || st.fuel >= target) return false;
    const before = st.fuel;
    await this.m.step('select', { slot });
    const n = Math.min(item.count, Math.max(1, Math.ceil((target - st.fuel) / 80)));
    await this.m.step('refuel', { count: n });
    await this.m.step('select', { slot: 1 });
    const after = this.m.turtle().fuel;
    return typeof after === 'number' && after > before;
  }

  /** Check inventory and fuel; go to the depot if needed (then come back here). */
  private async serviceIfNeeded(): Promise<void> {
    if (this.cp.servicing) return;
    let st = this.m.turtle();
    const reason = this.freeSlots(st) <= this.v.policy.minFreeSlots ? 'inventory' : undefined;
    let fuelLow = false;
    if (typeof st.fuel === 'number') {
      const need = this.costBetween(this.m.pos(), this.depot.dock) + this.v.policy.fuelReserve;
      if (st.fuel < need) {
        await this.burnCarriedFuel(need + 200);
        st = this.m.turtle();
        fuelLow = typeof st.fuel === 'number' && st.fuel < need;
      }
    }
    if (!reason && !fuelLow) return;
    this.mgr.log('info', `${this.v.name}: returning to the depot (${reason === 'inventory' ? 'inventory nearly full' : 'fuel low'})`, this.v.turtleId);
    await this.service(false);
  }

  /**
   * Get onto the dock. If another turtle has it, wait on a free waiting spot (or where
   * we are), stepping aside if we are in someone's way, until it is our turn.
   */
  private async goToDock(): Promise<void> {
    const depot = this.depot;
    for (;;) {
      this.m.checkActive();
      const holder = this.mgr.tryLockDock(depot.id, this.v.turtleId);
      if (!holder) break;
      this.mgr.setPhase(this.job, 'waiting');
      let spot = this.mgr.spotOf(depot.id, this.v.turtleId);
      if (!spot) {
        spot = this.mgr.claimSpot(depot.id, this.v.turtleId, this.m.pos());
        if (spot) {
          this.setNote(`dock in use by ${holder}: going to waiting spot ${fmt(spot)}`);
          await this.m.moveTo(spot);
        }
      }
      this.setNote(`waiting for the dock (in use by ${holder})${spot ? ` at spot ${fmt(spot)}` : ''}`);
      // Don't block others while we wait.
      const waiter = this.traffic.waitingFor(this.v.turtleId)[0];
      if (waiter) await this.m.yieldTo(waiter);
      await sleep(400);
    }
    this.mgr.releaseSpot(depot.id, this.v.turtleId);
    this.setNote(undefined);
    this.mgr.setPhase(this.job, 'returning');
    await this.m.moveTo(depot.dock);
    this.visitedDock = true;
  }

  private async service(final: boolean): Promise<void> {
    if (!this.cp.resume && !final) this.cp.resume = { pos: this.m.pos(), heading: this.m.heading() };
    this.cp.servicing = final ? 'finish' : 'trip';
    this.mgr.save(this.job);

    const depot = this.depot;
    this.mgr.setPhase(this.job, 'returning');
    await this.goToDock();
    await this.m.face(depot.dockHeading as Heading);

    this.mgr.setPhase(this.job, 'unloading');
    await this.unload();
    this.mgr.setPhase(this.job, 'refueling');
    await this.refuel(final);
    this.v.progress.trips++;

    if (final) {
      // Don't stay parked on a dock other jobs still need: wait in our own tunnel.
      if (this.mgr.depotShared(depot.id, this.v.id)) {
        this.mgr.setPhase(this.job, 'traveling');
        await this.m.moveTo(this.v.params.origin);
      }
      this.cp.servicing = undefined;
      this.mgr.save(this.job);
      this.mgr.releaseDock(depot.id, this.v.turtleId);
      this.mgr.setPhase(this.job, 'done');
      return;
    }
    this.cp.servicing = 'back';
    this.mgr.save(this.job);
    await this.returnToWork();
  }

  /** Second half of a trip: back to the saved position. The dock is freed on the way out. */
  private async returnToWork(): Promise<void> {
    const dock = this.mgr.getDepot(this.v.depotId)?.dock;
    if (dock && eq(this.m.pos(), dock)) this.visitedDock = true;
    if (this.cp.resume) {
      this.mgr.setPhase(this.job, 'traveling');
      await this.m.moveTo(this.cp.resume.pos);
      await this.m.face(this.cp.resume.heading as Heading);
      this.cp.resume = undefined;
    }
    this.cp.servicing = undefined;
    this.mgr.save(this.job);
    this.mgr.releaseDock(this.v.depotId, this.v.turtleId);
    this.mgr.setPhase(this.job, 'mining');
  }

  private async unload(): Promise<void> {
    const dir = this.depot.unloadDir;
    const where = `${DIR_TEXT[dir]} the dock at ${fmt(this.depot.dock)}`;
    const info = await this.m.step('inventoryInfo', { dir });
    if (info.status !== 'succeeded') {
      throw new JobError('chest_missing', `No chest ${where}. Place one there (nothing was dropped), then resume.`);
    }
    const { fuelSlot, keepSlots } = this.v.policy;
    const items = [...this.m.turtle().inventory].sort((a, b) => a.slot - b.slot);
    for (const it of items) {
      if (keepSlots.includes(it.slot)) continue;
      if (it.slot === fuelSlot && FUEL_ITEMS.has(it.name)) continue;
      const r = await this.m.step('drop', { dir, slot: it.slot });
      if (r.code === 'no_inventory') throw new JobError('chest_missing', `The chest ${where} disappeared while unloading. Nothing was dropped into the world. Replace it, then resume.`);
      if (r.code === 'inventory_full') throw new JobError('chest_full', `The chest ${where} is full. Empty it, then resume.`);
      if (r.status !== 'succeeded') throw new JobError(r.code ?? 'unload_failed', `Unloading slot ${it.slot} failed: ${r.reason}`);
      const data = r.data as { dropped?: number; partial?: boolean; verified?: boolean } | undefined;
      this.v.progress.itemsUnloaded += data?.dropped ?? 0;
      if (data?.verified === false) this.mgr.log('warn', `${this.v.name}: chest count did not match after unloading slot ${it.slot} (a hopper draining it?)`, this.v.turtleId);
      if (data?.partial) throw new JobError('chest_full', `The chest ${where} filled up while unloading. Empty it, then resume.`);
    }
    await this.m.step('select', { slot: 1 });
  }

  private async refuel(final: boolean): Promise<void> {
    let st = this.m.turtle();
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
        st = this.m.turtle();
        if (typeof st.fuel !== 'number' || st.fuel >= target) break;
        const want = Math.min(64, Math.max(1, Math.ceil((target - st.fuel) / 80)));
        const r = await this.m.step('suck', { dir: depot.fuelDir, slot, count: want });
        if (r.code === 'no_inventory') throw new JobError('fuel_chest_missing', `No fuel chest ${DIR_TEXT[depot.fuelDir]} the dock. Place one or remove it from the depot settings, then resume.`);
        const data = r.data as { taken?: number; slots?: { slot: number; name: string; count: number }[] } | undefined;
        if (!data?.taken) break; // empty
        for (const s of data.slots ?? []) {
          await this.m.step('select', { slot: s.slot });
          const burn = await this.m.step('refuel');
          if (burn.status !== 'succeeded') {
            // Not fuel: put it back where it came from (verified), then tell the operator.
            await this.m.step('drop', { dir: depot.fuelDir, slot: s.slot });
            throw new JobError('fuel_chest_contaminated', `The fuel chest contains ${s.name}, which is not fuel. Remove it, then resume.`);
          }
        }
      }
      await this.m.step('select', { slot: 1 });
    }

    // 2. Only burn the carried reserve if that is the only way to continue.
    st = this.m.turtle();
    if (typeof st.fuel === 'number' && st.fuel < need) await this.burnCarriedFuel(need + 200);

    st = this.m.turtle();
    if (typeof st.fuel === 'number' && st.fuel < need) {
      const where = this.v.policy.fuelSlot ? `slot ${this.v.policy.fuelSlot}` : 'the turtle';
      throw new JobError('insufficient_fuel', `Fuel ${st.fuel} is below the estimated ${need} needed to continue. Put fuel in ${where}${depot.fuelDir ? ' or the fuel chest' : ''}, then resume.`);
    }
  }
}
