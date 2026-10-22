/**
 * Executes one tunnel job on one turtle by issuing atomic commands through the
 * turtle's normal queue. Everything it decides is derived from the turtle's reported
 * state and the observed map, so a run can be stopped at any step and started again
 * from the persisted checkpoint. Movement and traffic rules live in `Mover`.
 */
import { type Box, type Dir, type Heading, type TunnelParams, type TurtleState, type Vec3, FUEL_ITEMS, HEADING_VECTORS, isOreBlock, isTorchItem, oreMatches, sectionBox } from '@ccfleet/protocol';
import type { Fleet } from '../fleet';
import { type Station, eq, fmt, inBox, key, manhattan, sliceStations, tunnelLocal } from './geometry';
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

/** Placing torches needs the place op (agent 0.3.2). */
export function agentSupportsTorches(version: string): boolean {
  const m = /^(?:lua|sim)-(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const [maj, min, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return maj > 0 || min > 3 || (min === 3 && patch >= 2);
}

const MAX_RETRIES_PER_CELL = 24;
const DIR_TEXT: Record<Dir, string> = { front: 'in front of', up: 'above', down: 'below' };

export class JobRunner {
  /** Cells counted in cellsCleared that belong to slices not yet complete (persisted). */
  private counted: Set<string>;
  private lastRouteBroadcast = 0;
  /** Set once the turtle has stood on the dock; the dock is freed when it steps off. */
  private visitedDock = false;
  /** Cells holding a torch this job placed (persisted). */
  private torches: Set<string>;
  /** Blocks those torches hang on: never dug, or the torch drops (persisted). */
  private torchSupports: Set<string>;
  /** Spots left dark (no torch with us) and spots where placing failed, for spacing. */
  private darkSpots: Vec3[] = [];
  private failedSpots: Vec3[] = [];
  /** Said once per stretch without torches, so the log isn't flooded. */
  private warnedNoTorches = false;
  private m: Mover;
  readonly executor: string;

  constructor(
    private mgr: JobManager,
    private fleet: Fleet,
    private traffic: Traffic,
    private job: JobRec,
  ) {
    this.executor = `job:${job.view.id}`;
    this.counted = new Set(job.checkpoint.counted ?? []);
    this.torches = new Set(job.checkpoint.torches ?? []);
    this.torchSupports = new Set(job.checkpoint.torchSupports ?? []);
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
      // Inside the work area anything (except protected blocks); outside it only ore
      // blocks of a followed vein, within reach.
      canDig: (p, block) => this.inWork(p) || this.veinOre(p, block),
      extraBlocked: () => this.depotCells(),
      includeBox: () => this.workBox(),
      onDug: (p, block) => this.dug(p, block),
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
      const total = this.v.segments.reduce((n, s) => n + s.length, 0);
      await this.stockTorchesFirst();
      while (this.cp.slice < total) {
        this.mgr.setPhase(this.job, 'mining');
        await this.mineUnit(this.cp.slice);
        this.cp.slice++;
        this.v.progress.unitsDone = this.cp.slice;
        // Cells of finished slices are never counted again: drop them from the set.
        for (const k of this.counted) if ((this.unitOf(k) ?? 0) < this.cp.slice) this.counted.delete(k);
        this.cp.counted = [...this.counted];
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
    if (this.v.policy.torches?.enabled && !agentSupportsTorches(version)) {
      throw new JobError('agent_outdated', `The turtle runs agent ${version || 'unknown'}; placing torches needs 0.3.2 or newer. Run "install" on the turtle (no code needed), then resume.`);
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
    return this.v.segments.some((s) => !!tunnelLocal(s, p)) && !this.v.exclusions.some((b) => inBox(b, p)) && !this.torches.has(key(p));
  }

  private workBox(): Box {
    const boxes = this.v.segments.map(sectionBox);
    return {
      min: { x: Math.min(...boxes.map((b) => b.min.x)), y: Math.min(...boxes.map((b) => b.min.y)), z: Math.min(...boxes.map((b) => b.min.z)) },
      max: { x: Math.max(...boxes.map((b) => b.max.x)), y: Math.max(...boxes.map((b) => b.max.y)), z: Math.max(...boxes.map((b) => b.max.z)) },
    };
  }

  /** Is this a block of a followed ore, within reach of the work area? */
  private veinOre(p: Vec3, block: string | null): boolean {
    const v = this.v.policy.veins;
    if (!block || !v?.ores.length || !v.ores.some((o) => oreMatches(o, block))) return false;
    if (this.torchSupports.has(key(p))) return false;
    if (this.v.exclusions.some((b) => inBox(b, p))) return false;
    return this.v.segments.some((s) => {
      const b = sectionBox(s);
      const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x);
      const dy = Math.max(b.min.y - p.y, 0, p.y - b.max.y);
      const dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z);
      return Math.max(dx, dy, dz) <= v.reach;
    });
  }

  /** Count ores the turtle mined. */
  private dug(p: Vec3, block: string | undefined): void {
    if (!isOreBlock(block)) return;
    const finds = (this.v.progress.finds ??= {});
    finds[block!] = (finds[block!] ?? 0) + 1;
    if (!this.inWork(p)) this.v.progress.veinBlocks = (this.v.progress.veinBlocks ?? 0) + 1;
    this.mgr.broadcast(this.job);
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

  /** The slice (global unit) a cell of the work area belongs to. */
  private unitOf(k: string): number | undefined {
    const [x, y, z] = k.split(',').map(Number);
    let base = 0;
    for (const s of this.v.segments) {
      const l = tunnelLocal(s, { x, y, z });
      if (l) return base + l.d;
      base += s.length;
    }
    return undefined;
  }

  private entered(p: Vec3): void {
    const k = key(p);
    // Count each cell once, across depot trips, pauses and resumes: cells of finished
    // slices were counted when their slice was mined.
    if (this.inWork(p) && !this.counted.has(k) && (this.unitOf(k) ?? -1) >= this.cp.slice) {
      this.counted.add(k);
      this.cp.counted = [...this.counted];
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

  /** Unit u = slice of a section (sections in mining order). */
  private async mineUnit(u: number): Promise<void> {
    let d = u;
    let seg: TunnelParams | undefined;
    for (const s of this.v.segments) {
      if (d < s.length) {
        seg = s;
        break;
      }
      d -= s.length;
    }
    if (!seg) return;
    for (const st of sliceStations(seg, d)) {
      if (!this.inWork(st.pos)) continue;
      await this.m.moveTo(st.pos);
      for (const c of st.extra) if (this.inWork(c)) await this.clearVertical(c);
      if (this.v.policy.scanWalls) await this.scanWalls(seg, st);
      if (this.v.policy.veins?.ores.length) await this.followVeins();
      await this.placeTorch(st);
    }
  }

  // ------------------------------------------------------------------ torches

  /**
   * Light the work area: a torch on the floor cell under the turtle's walking row (dug
   * from this station), at least `spacing` blocks from every torch this job placed, and
   * only where that floor stays (a quarry's upper layers are dug away later).
   */
  private async placeTorch(st: Station): Promise<void> {
    const t = this.v.policy.torches;
    if (!t?.enabled) return;
    const cell = { ...st.pos, y: st.pos.y - 1 };
    const below = { ...cell, y: cell.y - 1 };
    if (!st.extra.some((c) => eq(c, cell)) || !this.inWork(cell) || this.inWork(below)) return;
    if (this.m.known(cell)?.cell === 'solid') return;
    // A torch stands on the floor: over a cave or a vein dug out below, wait for floor again.
    const floor = this.m.known(below);
    if (floor && floor.cell !== 'solid') return;
    const near = (p: Vec3, r: number) => Math.abs(p.x - cell.x) < r && Math.abs(p.z - cell.z) < r && Math.abs(p.y - cell.y) <= 3;
    if ([...this.torches].some((k) => near(parseKey(k), t.spacing)) || this.darkSpots.some((p) => near(p, t.spacing))) return;
    // It just failed close by (no floor, it turned out): give it a few blocks.
    if (this.failedSpots.some((p) => near(p, FAILED_TORCH_GAP))) return;
    const item = this.m.turtle().inventory.find((i) => isTorchItem(i.name));
    if (!item) {
      // Counted once per spot that should have had one, not once per block.
      this.darkSpots.push(cell);
      this.v.progress.torchesMissed = (this.v.progress.torchesMissed ?? 0) + 1;
      if (!this.warnedNoTorches) {
        this.warnedNoTorches = true;
        this.mgr.log('warn', `${this.v.name}: out of torches; leaving it dark until the next depot trip (put torches in the fuel chest)`, this.v.turtleId);
      }
      this.mgr.broadcast(this.job);
      return;
    }
    if (!eq(this.m.pos(), st.pos)) await this.m.moveTo(st.pos);
    const r = await this.m.step('place', { dir: 'down', slot: item.slot });
    await this.m.step('select', { slot: 1 });
    if (r.status !== 'succeeded') {
      this.failedSpots.push(cell);
      this.mgr.log('info', `${this.v.name}: couldn't place a torch at ${fmt(cell)} (${r.reason}); trying again a few blocks on`, this.v.turtleId);
      return;
    }
    // With no floor after all, CC hangs it on a side block instead. Keep it only if that
    // block stays; otherwise it would drop when the job digs there: take it back.
    const look = await this.m.step('inspectDown');
    const support = torchSupport(cell, look.data as { name?: string; state?: Record<string, unknown> } | undefined);
    if (!support || this.inWork(support)) {
      await this.m.step('digDown');
      this.failedSpots.push(cell);
      this.mgr.log('info', `${this.v.name}: no floor for a torch at ${fmt(cell)}, and its wall gets dug; trying again a few blocks on`, this.v.turtleId);
      return;
    }
    this.torches.add(key(cell));
    this.torchSupports.add(key(support));
    this.cp.torches = [...this.torches];
    this.cp.torchSupports = [...this.torchSupports];
    this.v.progress.torchesPlaced = (this.v.progress.torchesPlaced ?? 0) + 1;
    this.mgr.save(this.job);
    this.mgr.broadcast(this.job);
  }

  /** Torches the rest of the job needs (at most a stack): one per `spacing` of the sections left. */
  private torchesWanted(): number {
    const t = this.v.policy.torches;
    if (!t?.enabled) return 0;
    let n = 0;
    let base = 0;
    for (const s of this.v.segments) {
      const left = Math.max(0, Math.min(s.length, base + s.length - this.cp.slice));
      if (left > 0 && s.height >= 2) n += Math.ceil(left / t.spacing) * Math.ceil(s.width / t.spacing);
      base += s.length;
    }
    return Math.min(64, n);
  }

  private carriedTorches(): number {
    return this.m
      .turtle()
      .inventory.filter((i) => isTorchItem(i.name))
      .reduce((n, i) => n + i.count, 0);
  }

  /** At the start of a job that places torches: fetch them from the depot if the turtle has none. */
  private async stockTorchesFirst(): Promise<void> {
    if (this.cp.slice > 0 || this.v.progress.trips > 0 || this.torchesWanted() === 0 || this.carriedTorches() > 0) return;
    if (!this.depot.fuelDir) {
      this.mgr.log('warn', `${this.v.name}: torches are on, but the depot has no fuel chest to take them from and the turtle has none`, this.v.turtleId);
      return;
    }
    this.mgr.log('info', `${this.v.name}: fetching torches from the depot first`, this.v.turtleId);
    await this.service(false);
  }

  /**
   * Look at every outer face of this station's column (side walls on the first/last
   * column, end walls on the first/last slice, ceiling and floor), visiting each row
   * of the column, so the map shows what's around the work area and ores in it are seen.
   */
  private async scanWalls(seg: TunnelParams, st: Station): Promise<void> {
    const home = st.pos;
    const local = tunnelLocal(seg, home);
    if (!local) return;
    const sides: Heading[] = [];
    if (local.w === 0) sides.push(((seg.heading + 3) % 4) as Heading);
    if (local.w === seg.width - 1) sides.push(((seg.heading + 1) % 4) as Heading);
    if (local.d === 0) sides.push(((seg.heading + 2) % 4) as Heading);
    if (local.d === seg.length - 1) sides.push(seg.heading as Heading);
    const unseen = (c: Vec3) => !this.inWork(c) && !this.m.known(c);
    const beside = (c: Vec3, h: Heading) => ({ x: c.x + HEADING_VECTORS[h].x, y: c.y, z: c.z + HEADING_VECTORS[h].z });
    const above = (c: Vec3) => ({ ...c, y: c.y + 1 });
    const below = (c: Vec3) => ({ ...c, y: c.y - 1 });
    const needs = (c: Vec3) => unseen(above(c)) || unseen(below(c)) || sides.some((h) => unseen(beside(c, h)));
    // The station's row first, then the others nearest first (moving in looks up and down too).
    const rows = [home, ...st.extra.filter((c) => this.inWork(c)).sort((a, b) => Math.abs(a.y - home.y) - Math.abs(b.y - home.y))];
    let moved = false;
    for (const c of rows) {
      if (!needs(c)) continue;
      if (!eq(this.m.pos(), c)) {
        await this.m.moveTo(c);
        moved = true;
      }
      if (unseen(above(c))) await this.m.step('inspectUp');
      if (unseen(below(c))) await this.m.step('inspectDown');
      // Turn the shorter way first.
      const h = this.m.heading();
      const order = sides.filter((s) => unseen(beside(c, s))).sort((x, y) => turns(h, x) - turns(h, y));
      for (const side of order) {
        if (!unseen(beside(c, side))) continue;
        await this.m.face(side);
        await this.m.step('inspect');
      }
    }
    if (moved) await this.m.moveTo(home);
  }

  /**
   * Mine every known block of a followed ore within reach that the turtle can get to,
   * looking around at each one so the rest of the vein is found, then come back.
   */
  private async followVeins(): Promise<void> {
    const v = this.v.policy.veins;
    const home = this.m.pos();
    const homeHeading = this.m.heading();
    const skip = new Set<string>();
    let mined = 0;
    while (mined < v.maxBlocks) {
      const here = this.m.pos();
      const r = v.reach + 2;
      const rows = this.fleet.queryMap({ world: this.v.world, dimension: this.v.dimension, x0: here.x - r, x1: here.x + r, z0: here.z - r, z1: here.z + r, y0: here.y - r, y1: here.y + r }).blocks;
      const target = rows
        .filter((b) => b.cell === 'solid' && !this.inWork(b) && !skip.has(key(b)) && this.ownSighting(b) && this.veinOre(b, b.block))
        .sort((a, b) => manhattan(a, here) - manhattan(b, here))[0];
      if (!target) break;
      if (mined === 0) this.setNote(`following a vein of ${target.block}`);
      try {
        await this.m.moveTo(target);
      } catch (e) {
        if (e instanceof JobError && e.code === 'no_route') {
          skip.add(key(target));
          continue;
        }
        throw e;
      }
      mined++;
      await this.lookAround();
    }
    if (mined > 0) {
      this.setNote(undefined);
      await this.m.moveTo(home);
      await this.m.face(homeHeading);
    }
  }

  /** Seen by this job's turtle during this job (not by another turtle, or on an earlier job). */
  private ownSighting(b: { source?: string; observedAt: number }): boolean {
    return b.source === this.v.turtleId && b.observedAt >= this.v.createdAt;
  }

  /** Inspect the four sides we haven't seen yet (moving in already looked ahead, up and down). */
  private async lookAround(): Promise<void> {
    const pos = this.m.pos();
    for (let i = 0; i < 4; i++) {
      const h = ((this.m.heading() + [1, 3, 2, 0][i]) % 4) as Heading;
      const v = HEADING_VECTORS[h];
      const cell = { x: pos.x + v.x, y: pos.y, z: pos.z + v.z };
      if (this.m.known(cell)) continue;
      await this.m.face(h);
      await this.m.step('inspect');
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
      // Walk up close before asking for the dock, so whoever gets there first docks
      // first, and nobody waits at the far end of a long tunnel.
      const path = this.m.plan(depot.dock);
      if (path && path.length > APPROACH && !this.mgr.spotOf(depot.id, this.v.turtleId)) {
        this.mgr.setPhase(this.job, 'returning');
        await this.m.moveTo(path[path.length - 1 - APPROACH]);
        continue;
      }
      const holder = this.mgr.tryLockDock(depot.id, this.v.turtleId);
      if (!holder) break;
      this.mgr.setPhase(this.job, 'waiting');
      let spot = this.mgr.spotOf(depot.id, this.v.turtleId);
      if (!spot) {
        spot = this.mgr.claimSpot(depot.id, this.v.turtleId, this.m.pos()) ?? this.claimWaitCell(path);
        if (spot && !eq(spot, this.m.pos())) {
          this.setNote(`dock in use by ${holder}: going to wait at ${fmt(spot)}`);
          try {
            await this.m.moveTo(spot);
          } catch (e) {
            if (!(e instanceof JobError)) throw e;
            this.mgr.releaseSpot(depot.id, this.v.turtleId);
            spot = undefined;
          }
        }
      }
      this.setNote(`waiting for the dock (in use by ${holder})${spot ? ` at ${fmt(spot)}` : ''}`);
      // Don't block others while we wait.
      const waiter = this.traffic.waitingFor(this.v.turtleId)[0];
      if (waiter) {
        await this.m.yieldTo(waiter);
        this.mgr.releaseSpot(depot.id, this.v.turtleId);
      }
      await sleep(400);
    }
    this.mgr.releaseSpot(depot.id, this.v.turtleId);
    this.setNote(undefined);
    this.mgr.setPhase(this.job, 'returning');
    // A turtle nothing drives (parked by hand, or idle) on the dock won't move away by
    // itself: say so, instead of a puzzling "no route".
    const parked = this.traffic.holder(this.v.turtleId, depot.dock);
    if (parked && !parked.agent && !eq(this.m.pos(), depot.dock)) {
      throw new JobError('dock_blocked', `${parked.name} is standing on the dock at ${fmt(depot.dock)} and nothing is driving it. Move it off the dock, then resume.`);
    }
    this.mgr.setDockRoute(depot.id, this.v.turtleId, [this.m.pos(), ...(this.m.plan(depot.dock) ?? [])]);
    await this.m.moveTo(depot.dock);
    this.visitedDock = true;
  }

  /** After the last unload: a free waiting spot of the depot, else where the job started. */
  private async parkOffDock(): Promise<void> {
    const depot = this.depot;
    const occupied = new Set(this.fleet.turtlePositions(this.v.world, this.v.dimension, this.v.turtleId).map(key));
    const spots = depot.waiting
      .filter((s) => !occupied.has(key(s)) && !this.mgr.cellClaimed(depot.id, this.v.turtleId, s))
      .sort((a, b) => manhattan(a, depot.dock) - manhattan(b, depot.dock));
    for (const p of [...spots, this.v.segments[0].origin]) {
      try {
        await this.m.moveTo(p);
        return;
      } catch (e) {
        if (!(e instanceof JobError)) throw e;
      }
    }
    this.mgr.log('warn', `${this.v.name}: could not move off the dock after finishing; move the turtle before another job needs the dock`, this.v.turtleId);
  }

  /**
   * A place to wait near the dock when the depot has no free waiting spot: the cell of
   * our own route closest to the dock that the dock holder doesn't use, else the nearest
   * known-free cell off its route. Never next to the dock itself.
   */
  private claimWaitCell(path: Vec3[] | null): Vec3 | undefined {
    const depot = this.depot;
    const avoid = this.mgr.dockRoute(depot.id);
    const holder = this.mgr.dockHolder(depot.id);
    if (holder) for (const c of this.traffic.routeCells(holder)) avoid.add(c);
    avoid.add(key(depot.dock));
    const others = new Set(this.fleet.turtlePositions(this.v.world, this.v.dimension, this.v.turtleId).map(key));
    const blocked = new Set((this.depotCells() ?? []).map(key));
    const ok = (c: Vec3) =>
      manhattan(c, depot.dock) >= 2 && !avoid.has(key(c)) && !others.has(key(c)) && !blocked.has(key(c)) && !this.mgr.cellClaimed(depot.id, this.v.turtleId, c);
    const here = this.m.pos();
    const route = [here, ...(path ?? [])];
    for (let i = route.length - 1; i >= 0; i--) {
      if (ok(route[i]) && this.mgr.claimCell(depot.id, this.v.turtleId, route[i])) return route[i];
    }
    // Our way in is the holder's way too: find a free side cell near the dock.
    const r = 8;
    const d = depot.dock;
    const rows = this.fleet.queryMap({ world: this.v.world, dimension: this.v.dimension, x0: d.x - r, x1: d.x + r, z0: d.z - r, z1: d.z + r, y0: d.y - 4, y1: d.y + 4 }).blocks;
    const free = new Set(rows.filter((b) => b.cell === 'empty').map(key));
    free.add(key(here));
    const queue: Vec3[] = [d];
    const seen = new Set([key(d)]);
    while (queue.length) {
      const c = queue.shift()!;
      if (!eq(c, d) && ok(c) && this.mgr.claimCell(depot.id, this.v.turtleId, c)) return c;
      for (const v of NEIGHBOURS) {
        const n = { x: c.x + v.x, y: c.y + v.y, z: c.z + v.z };
        if (seen.has(key(n)) || !free.has(key(n))) continue;
        seen.add(key(n));
        queue.push(n);
      }
    }
    return undefined;
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
      // Never stay parked on the dock: a job started later, by another turtle, needs it.
      this.mgr.setPhase(this.job, 'traveling');
      await this.parkOffDock();
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

  /**
   * Take fuel (burned right away, up to `fuelTarget`) and torches (kept, up to
   * `torchesWanted`) from the fuel chest. A turtle can only take the chest's first stack,
   * so whatever comes out that isn't needed right now is kept aside and put back at the
   * end; anything that is neither fuel nor a torch is put back and reported.
   */
  private async visitFuelChest(dir: Dir, fuelTarget: number, torchesWanted: number): Promise<void> {
    const giveBack: { slot: number; count: number }[] = [];
    const putBack = async () => {
      for (const g of giveBack.splice(0)) {
        const r = await this.m.step('drop', { dir, slot: g.slot, count: g.count });
        if (r.status !== 'succeeded') this.mgr.log('warn', `${this.v.name}: couldn't put ${g.count} item(s) back in the fuel chest (${r.reason}); they'll be unloaded next trip`, this.v.turtleId);
      }
    };
    // Torches carried, not counting those set aside to go back.
    const kept = () => this.carriedTorches() - giveBack.filter((g) => isTorchItem(this.itemIn(g.slot))).reduce((n, g) => n + g.count, 0);
    for (let i = 0; i < 16; i++) {
      const st = this.m.turtle();
      const fuelShort = typeof st.fuel === 'number' && st.fuel < fuelTarget;
      const torchesShort = kept() < torchesWanted;
      if (!fuelShort && !torchesShort) break;
      // Topping up torches: into the stack we already carry, so they don't take a new slot each trip.
      const slot = (!fuelShort && this.torchSlotWithRoom()) || this.emptySlot();
      if (!slot) break;
      const count = fuelShort ? Math.min(64, Math.max(1, Math.ceil((fuelTarget - (st.fuel as number)) / 80))) : Math.min(64, torchesWanted - kept());
      const r = await this.m.step('suck', { dir, slot, count });
      if (r.code === 'no_inventory') throw new JobError('fuel_chest_missing', `No fuel chest ${DIR_TEXT[dir]} the dock. Place one or remove it from the depot settings, then resume.`);
      const data = r.data as { taken?: number; slots?: { slot: number; name: string; count: number }[] } | undefined;
      if (!data?.taken) break; // empty
      for (const s of data.slots ?? []) {
        if (isTorchItem(s.name)) {
          // Keep what the job still needs; the rest goes back (it may be the chest's first stack).
          const keep = Math.max(0, torchesWanted - (kept() - s.count));
          if (s.count > keep) giveBack.push({ slot: s.slot, count: s.count - keep });
          continue;
        }
        if (!fuelShort) {
          giveBack.push(s);
          continue;
        }
        await this.m.step('select', { slot: s.slot });
        // Only what was just taken: the slot may also hold the carried reserve.
        const burn = await this.m.step('refuel', { count: s.count });
        if (burn.status !== 'succeeded') {
          // Neither fuel nor a torch: put it (and anything set aside) back, verified, then tell the operator.
          giveBack.push(s);
          await putBack();
          throw new JobError('fuel_chest_contaminated', `The fuel chest contains ${s.name}, which is neither fuel nor a torch. Remove it, then resume.`);
        }
      }
    }
    await putBack();
    await this.m.step('select', { slot: 1 });
    if (torchesWanted > 0) {
      if (this.carriedTorches() > 0) this.warnedNoTorches = false;
      else this.mgr.log('warn', `${this.v.name}: no torches in the fuel chest; carrying on without lighting`, this.v.turtleId);
    }
  }

  private itemIn(slot: number): string | undefined {
    return this.m.turtle().inventory.find((i) => i.slot === slot)?.name;
  }

  private torchSlotWithRoom(): number | undefined {
    const reserved = new Set([this.v.policy.fuelSlot, ...this.v.policy.keepSlots].filter((s) => s > 0));
    return this.m.turtle().inventory.find((i) => isTorchItem(i.name) && i.count < 64 && !reserved.has(i.slot))?.slot;
  }

  /** First empty slot that isn't reserved for fuel or kept items. */
  private emptySlot(): number | undefined {
    const inv = this.m.turtle().inventory;
    const reserved = new Set([this.v.policy.fuelSlot, ...this.v.policy.keepSlots].filter((s) => s > 0));
    for (let s = 1; s <= 16; s++) if (!reserved.has(s) && !inv.some((i) => i.slot === s)) return s;
    return undefined;
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
      if (this.v.policy.torches?.enabled && isTorchItem(it.name)) continue;
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
    const depot = this.depot;
    let st = this.m.turtle();
    const limit = typeof st.fuelLimit === 'number' ? st.fuelLimit : Infinity;
    const target = Math.min(this.v.policy.refuelTarget, limit);

    // 1. The fuel chest, if the depot has one: fuel, and torches for the job.
    if (depot.fuelDir) await this.visitFuelChest(depot.fuelDir, typeof st.fuel === 'number' ? target : 0, final ? 0 : this.torchesWanted());
    st = this.m.turtle();
    if (st.fuel === 'unlimited') return;
    const resume = this.cp.resume?.pos ?? this.v.segments[0].origin;
    const need = final ? 0 : 2 * this.costBetween(depot.dock, resume) + this.v.policy.fuelReserve;

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

/** After a failed torch, no new attempt within this many blocks of it. */
const FAILED_TORCH_GAP = 3;

const FACING: Record<string, Vec3> = { north: { x: 0, y: 0, z: -1 }, south: { x: 0, y: 0, z: 1 }, west: { x: -1, y: 0, z: 0 }, east: { x: 1, y: 0, z: 0 } };

/**
 * The block a placed torch hangs on: the floor for a standing torch, the block behind a
 * wall torch (it faces away from it). Undefined if it isn't a torch at all.
 */
export function torchSupport(cell: Vec3, block: { name?: string; state?: Record<string, unknown> } | undefined): Vec3 | undefined {
  const name = block?.name ?? '';
  if (!name.endsWith('torch')) return undefined;
  if (!name.endsWith('wall_torch')) return { ...cell, y: cell.y - 1 };
  const f = FACING[String(block?.state?.facing ?? '')];
  return f ? { x: cell.x - f.x, y: cell.y, z: cell.z - f.z } : undefined;
}

function parseKey(k: string): Vec3 {
  const [x, y, z] = k.split(',').map(Number);
  return { x, y, z };
}

/** Quarter turns needed to face `to` from `from`. */
function turns(from: Heading, to: Heading): number {
  const d = (to - from + 4) % 4;
  return d === 3 ? 1 : d;
}

/** Steps from the dock at which a returning turtle stops to ask for it. */
const APPROACH = 6;

const NEIGHBOURS: Vec3[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
];
