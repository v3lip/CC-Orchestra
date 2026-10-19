/**
 * Moves one turtle through the world with atomic commands: path planning over observed
 * cells, digging only where the caller allows, traffic reservations, deadlock
 * resolution by stepping aside, gravel retries and re-planning. Used by jobs and by
 * go-to tasks.
 */
import { type Box, type Heading, type MapBlock, type Op, type TurtleState, type Vec3, DEFAULT_PROTECTED_BLOCKS, HEADING_VECTORS } from '@ccfleet/protocol';
import type { Fleet, StepResult } from '../fleet';
import { eq, fmt, key } from './geometry';
import { planPath, type NavContext } from './nav';
import type { Traffic } from './traffic';

/** The work was paused/cancelled or the turtle became unavailable: stop quietly. */
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

export interface MoverOptions {
  fleet: Fleet;
  traffic: Traffic;
  turtleId: string;
  world: string;
  dimension: string;
  executor: string;
  isActive(): boolean;
  stopReason(): string;
  /** May this cell be dug to get through? (Never for protected blocks.) */
  canDig(p: Vec3, block: string | null): boolean;
  /** Cells never to enter (e.g. depot chests). */
  extraBlocked?(): Vec3[];
  /** A region the planner should always include (e.g. the job volume). */
  includeBox?(): Box | undefined;
  /** Called before every move (jobs check inventory/fuel here). */
  beforeMove?(next: Vec3): Promise<void>;
  onRoute?(path: Vec3[]): void;
  onEntered?(p: Vec3): void;
  onUnbreakable?(p: Vec3): void;
  /** A block was dug (name as reported by the turtle, if known). */
  onDug?(p: Vec3, block: string | undefined): void;
  /** Live note for the operator while waiting in traffic (undefined = clear). */
  onWait?(note: string | undefined): void;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
}

const MAX_REPLANS = 30;
const MAX_RETRIES_PER_CELL = 24; // gravel/sand columns can refill a cell many times
/** How long to wait behind a turtle nobody is driving before routing around it. */
const STATIC_WAIT_MS = 3000;
/** How long to wait behind a moving turtle before trying another route. */
const AGENT_WAIT_MS = 30_000;
const POLL_MS = 200;
/** How long to keep retrying a command the turtle refuses as busy. */
const BUSY_WAIT_MS = 20_000;
/** How many cells ahead a turtle looks for an oncoming one. */
const LOOKAHEAD = 5;
/** Path cost of stepping on a cell an oncoming turtle is about to use. */
const AVOID_COST = 40;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isProtectedName(name: string | null | undefined): boolean {
  return !!name && DEFAULT_PROTECTED_BLOCKS.some((pat) => name.includes(pat));
}

export class Mover {
  readonly unpassable = new Set<string>();
  private yielding = false;

  constructor(private o: MoverOptions) {}

  // ------------------------------------------------------------------ state

  turtle(): TurtleState {
    const t = this.o.fleet.turtleState(this.o.turtleId);
    if (!t) throw new Interrupt('turtle removed');
    if (!t.online) throw new Interrupt('turtle went offline');
    if (!t.state) throw new JobError('no_state', 'No telemetry from the turtle yet.');
    return t.state;
  }

  pos(): Vec3 {
    const pose = this.turtle().pose;
    if (pose.position !== 'known' || !pose.pos) throw new JobError('pose_uncertain', 'Turtle position is not known. Use GPS fix or Calibrate, then resume.');
    return pose.pos;
  }

  heading(): Heading {
    const pose = this.turtle().pose;
    if (pose.headingConfidence !== 'known' || pose.heading === undefined) throw new JobError('pose_uncertain', 'Turtle heading is not known. Calibrate it, then resume.');
    return pose.heading as Heading;
  }

  checkActive(): void {
    if (!this.o.isActive()) throw new Interrupt(this.o.stopReason());
  }

  async step(op: Op, args: Record<string, unknown> = {}): Promise<StepResult> {
    this.checkActive();
    let r = await this.o.fleet.runStep(this.o.turtleId, op, args, this.o.executor);
    // "busy": the turtle is still finishing an earlier command (one whose result timed
    // out, say). Give it a moment instead of failing the job.
    for (let waited = 0; r.status === 'rejected' && r.code === 'busy' && waited < BUSY_WAIT_MS; waited += POLL_MS * 5) {
      await sleep(POLL_MS * 5);
      this.checkActive();
      r = await this.o.fleet.runStep(this.o.turtleId, op, args, this.o.executor);
    }
    if (r.status === 'undeliverable' || r.status === 'unknown') {
      // "unknown" also comes from a result timeout while the turtle is still connected.
      if (r.status === 'unknown' && this.o.fleet.turtleState(this.o.turtleId)?.online) {
        throw new Interrupt(`no answer from the turtle to ${op} in time (it is still connected); check it, then resume`);
      }
      throw new Interrupt('turtle went offline');
    }
    if (r.status === 'cancelled') throw new Interrupt(this.o.isActive() ? 'command cancelled' : this.o.stopReason());
    if (r.status === 'rejected' && r.code === 'held') throw new Interrupt('turtle was stopped');
    if (r.status === 'rejected' || r.status === 'expired') throw new JobError(r.code ?? 'rejected', `${op} was refused: ${r.reason ?? r.status}`);
    return r;
  }

  known(p: Vec3): MapBlock | undefined {
    return this.o.fleet.mapCell(this.o.world, this.o.dimension, p);
  }

  // ------------------------------------------------------------------ movement

  async face(h: Heading): Promise<void> {
    const diff = (h - this.heading() + 4) % 4;
    if (diff === 0) return;
    const ops: Op[] = diff === 1 ? ['turnRight'] : diff === 3 ? ['turnLeft'] : ['turnRight', 'turnRight'];
    for (const op of ops) {
      const r = await this.step(op);
      if (r.status !== 'succeeded') throw new JobError(r.code ?? 'failed', `${op} failed: ${r.reason}`);
    }
  }

  private navContext(from: Vec3, to: Vec3, avoid?: Set<string>): NavContext {
    const margin = 16;
    const min = { x: Math.min(from.x, to.x) - margin, y: Math.min(from.y, to.y) - 8, z: Math.min(from.z, to.z) - margin };
    const max = { x: Math.max(from.x, to.x) + margin, y: Math.max(from.y, to.y) + 8, z: Math.max(from.z, to.z) + margin };
    const box = this.o.includeBox?.();
    if (box) {
      // Include the work volume when it is between the two points.
      for (const a of ['x', 'y', 'z'] as const) {
        if (box.min[a] >= min[a] - margin && box.max[a] <= max[a] + margin) {
          min[a] = Math.min(min[a], box.min[a]);
          max[a] = Math.max(max[a], box.max[a]);
        }
      }
    }
    const rows = this.o.fleet.queryMap({ world: this.o.world, dimension: this.o.dimension, x0: min.x, x1: max.x, z0: min.z, z1: max.z, y0: min.y, y1: max.y, limit: 200_000 }).blocks;
    const cells = new Map(rows.map((b) => [key(b), b]));
    const blocked = new Set<string>(this.unpassable);
    const extraCost = new Map<string, number>();
    // Turtles nobody drives are walls. Turtles under traffic control will move on, so their
    // cells are just expensive; the per-step reservation settles who goes first.
    for (const t of this.o.fleet.listTurtles()) {
      if (t.id === this.o.turtleId || t.world !== this.o.world || t.dimension !== this.o.dimension) continue;
      const pose = t.state?.pose;
      const cellsOf = [...(pose?.pos ? [pose.pos] : []), ...(pose?.candidates ?? [])];
      const moving = this.o.traffic.isAgent(t.id) && t.connection !== 'offline';
      for (const c of cellsOf) moving ? extraCost.set(key(c), 12) : blocked.add(key(c));
    }
    for (const p of this.o.traffic.reservedBy(this.o.turtleId, this.o.world, this.o.dimension)) extraCost.set(key(p), 12);
    for (const p of this.o.extraBlocked?.() ?? []) blocked.add(key(p));
    for (const k of avoid ?? []) extraCost.set(k, Math.max(extraCost.get(k) ?? 0, AVOID_COST));
    return { cell: (p) => cells.get(key(p)), blocked, extraCost, canDig: (p, b) => this.canDig(p, b), bounds: { min, max } };
  }

  private canDig(p: Vec3, block: string | null): boolean {
    return !this.unpassable.has(key(p)) && !isProtectedName(block) && this.o.canDig(p, block);
  }

  /** The route moveTo would take from here right now (without the start cell), or null. */
  plan(goal: Vec3): Vec3[] | null {
    const here = this.pos();
    if (eq(here, goal)) return [];
    return planPath(this.navContext(here, goal), here, goal);
  }

  async moveTo(goal: Vec3): Promise<void> {
    const g = this.known(goal);
    if (g?.cell === 'solid' && isProtectedName(g.block)) {
      throw new JobError('protected', `Protected block ${g.block} at ${fmt(goal)} is in the way. Remove it or add an exclusion, then resume.`);
    }
    const cantGiveWay = new Set<string>();
    for (let attempt = 0; attempt < MAX_REPLANS; attempt++) {
      const here = this.pos();
      if (eq(here, goal)) return;
      const path = planPath(this.navContext(here, goal), here, goal);
      if (!path) {
        // A turtle may be parked on the goal or in a narrow spot: give traffic a moment.
        if (attempt < 3 && this.o.fleet.turtlePositions(this.o.world, this.o.dimension, this.o.turtleId).length) {
          await sleep(1500);
          continue;
        }
        throw new JobError('no_route', `No known safe route from ${fmt(here)} to ${fmt(goal)}. Drive the turtle closer or clear a path, then resume.`);
      }
      let route = path;
      this.o.traffic.setRoute(this.o.turtleId, route);
      this.o.onRoute?.([here, ...route]); // with the start cell, so "just crossed into" can be told
      let ok = true;
      for (let i = 0; i < route.length; i++) {
        // A more important turtle coming the other way: get out of its way before we meet.
        const way = this.yielding ? undefined : this.o.traffic.oncoming(this.o.turtleId, this.pos(), route.slice(i, i + LOOKAHEAD));
        if (way && !cantGiveWay.has(way.id)) {
          const alt = this.passPath(way.id, goal, route.length - i);
          if (alt) {
            this.o.log('info', `${this.o.traffic.name(this.o.turtleId)} takes a parallel path to pass ${way.name}`);
            route = alt;
            i = -1;
            this.o.traffic.setRoute(this.o.turtleId, route);
            this.o.onRoute?.([this.pos(), ...route]);
            continue;
          }
          if (await this.yieldTo(way.id)) {
            ok = false;
            break;
          }
          // Nowhere to go: carry on; meeting it, the deadlock rules decide.
          cantGiveWay.add(way.id);
        }
        if (!(await this.stepInto(route[i]))) {
          ok = false;
          break;
        }
      }
      if (ok) return;
    }
    throw new JobError('no_route', `Gave up reaching ${fmt(goal)} after ${MAX_REPLANS} re-plans.`);
  }

  /**
   * A route to `goal` that stays off `other`'s cell and route while they pass each other
   * (another row or column of the tunnel), if there is one that isn't much longer.
   */
  private passPath(other: string, goal: Vec3, remaining: number): Vec3[] | undefined {
    const here = this.pos();
    // The stretch between us: where it stands, and its route up to where we stand.
    const avoid = new Set<string>();
    const op = this.o.fleet.turtleState(other)?.state?.pose.pos;
    if (op) avoid.add(key(op));
    for (const c of this.o.traffic.route(other)) {
      if (c === key(here)) break;
      avoid.add(c);
    }
    const alt = planPath(this.navContext(here, goal, avoid), here, goal);
    if (!alt || alt.length > remaining + 8) return undefined;
    return alt.some((c) => avoid.has(key(c))) ? undefined : alt;
  }

  /**
   * Dig one adjacent cell. Returns false if it cannot be cleared (unbreakable). Either way
   * the map is up to date afterwards: the agent looks at the cell after digging (gravel
   * may have fallen in), and if there was nothing to dig we look, so a stale "solid"
   * doesn't stay.
   */
  async digAt(digOp: 'dig' | 'digUp' | 'digDown', p: Vec3): Promise<boolean> {
    const r = await this.step(digOp);
    if (r.status === 'succeeded') {
      this.o.onDug?.(p, (r.data as { block?: string } | undefined)?.block);
      return true;
    }
    if (r.code === 'nothing_to_dig') {
      await this.step(digOp === 'digUp' ? 'inspectUp' : digOp === 'digDown' ? 'inspectDown' : 'inspect');
      return true;
    }
    if (r.code === 'protected') throw new JobError('protected', `${r.reason} at ${fmt(p)} inside the job area. Remove it or add an exclusion, then resume.`);
    if (r.code === 'unbreakable') {
      this.unpassable.add(key(p));
      this.o.onUnbreakable?.(p);
      return false;
    }
    throw new JobError(r.code ?? 'dig_failed', `Dig at ${fmt(p)} failed: ${r.reason ?? r.status}`);
  }

  /** Move into an adjacent cell, digging it if allowed. False = re-plan. */
  async stepInto(next: Vec3): Promise<boolean> {
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
    if (!(await this.reserve(next))) return false;
    let moved = false;
    try {
      for (let i = 0; i < MAX_RETRIES_PER_CELL; i++) {
        const c = this.known(next);
        if (c?.cell === 'solid') {
          if (!this.canDig(next, c.block)) return false;
          if (!(await this.digAt(digOp, next))) return false;
          // Look again before moving: gravel or sand may have fallen into the gap.
          if (this.known(next)?.cell === 'solid') continue;
        }
        await this.o.beforeMove?.(next);
        const r = await this.step(moveOp);
        if (r.status === 'succeeded') {
          moved = true;
          this.o.onEntered?.(next);
          return true;
        }
        if (r.code === 'out_of_fuel') throw new JobError('out_of_fuel', 'The turtle ran out of fuel. Add fuel to it, then resume.');
        if (r.code !== 'obstructed') throw new JobError(r.code ?? 'move_failed', `${moveOp} failed: ${r.reason}`);
        // Obstructed: find out by what. If the map doesn't know, ask explicitly.
        const occupied = !!this.o.traffic.holder(this.o.turtleId, next);
        let after = this.known(next);
        if (!after && !occupied) {
          await this.step(dy > 0 ? 'inspectUp' : dy < 0 ? 'inspectDown' : 'inspect');
          after = this.known(next);
        }
        if (occupied || !after || after.cell !== 'solid') {
          // A turtle we didn't know about, or an entity: wait a little, then re-plan.
          if (i >= 4) return false;
          await sleep(1000);
          continue;
        }
        if (!this.canDig(next, after.block)) return false;
      }
      return false;
    } finally {
      this.o.traffic.release(this.o.turtleId, moved);
    }
  }

  /**
   * Wait until `next` is free and reserve it. Steps aside if this turtle is the one
   * chosen to break a deadlock. False = re-plan.
   */
  private async reserve(next: Vec3): Promise<boolean> {
    const me = this.o.turtleId;
    let waited = 0;
    try {
      for (;;) {
        this.checkActive();
        const h = this.o.traffic.tryReserve(me, next);
        if (!h) return true;
        this.o.traffic.setWaiting(me, h.id);
        this.o.onWait?.(`waiting for ${h.name} to clear ${fmt(next)}`);
        if (!h.agent) {
          if (waited >= STATIC_WAIT_MS) return false; // nobody is driving it: route around
        } else {
          const r = this.o.traffic.resolve(me);
          if (r === 'stuck') {
            throw new JobError('deadlock', `${this.o.traffic.name(me)} and ${h.name} block each other in a narrow passage and neither can step aside. Move one of them manually, then resume.`);
          }
          if (r === 'yield' && !this.yielding) {
            this.o.traffic.setWaiting(me, undefined);
            await this.yieldTo(h.id);
            return false;
          }
          if (waited >= AGENT_WAIT_MS || (this.yielding && waited >= 2000)) return false;
        }
        await sleep(POLL_MS);
        waited += POLL_MS;
      }
    } finally {
      this.o.traffic.setWaiting(me, undefined);
      this.o.onWait?.(undefined);
    }
  }

  /** Step aside out of `other`'s way, then give it a moment to pass. */
  async yieldTo(other: string): Promise<boolean> {
    const me = this.o.turtleId;
    const spot = this.findYieldCell(other);
    if (!spot) {
      this.o.traffic.markNoYield(me);
      return false;
    }
    this.o.log('info', `${this.o.traffic.name(me)} steps aside to ${fmt(spot)} to let ${this.o.traffic.name(other)} pass`);
    this.yielding = true;
    try {
      await this.moveTo(spot);
    } catch (e) {
      if (e instanceof JobError) {
        this.o.traffic.markNoYield(me);
        return false;
      }
      throw e;
    } finally {
      this.yielding = false;
    }
    // Let the other turtle get past (or give up after a while).
    const start = Date.now();
    const otherStart = this.o.fleet.turtleState(other)?.state?.pose.pos;
    while (Date.now() - start < 20_000) {
      this.checkActive();
      await sleep(POLL_MS);
      const p = this.o.fleet.turtleState(other)?.state?.pose.pos;
      const route = this.o.traffic.routeCells(other);
      if (!this.o.traffic.isAgent(other) || (p && otherStart && !eq(p, otherStart) && !route.has(key(this.pos())))) {
        if (Date.now() - start > 1000) return true;
      }
    }
    return true;
  }

  /** Nearest known-free cell (no digging) that is not on `other`'s route. */
  private findYieldCell(other: string): Vec3 | undefined {
    const here = this.pos();
    const avoid = this.o.traffic.routeCells(other);
    const op = this.o.fleet.turtleState(other)?.state?.pose.pos;
    if (op) avoid.add(key(op));
    const blocked = new Set<string>();
    for (const p of this.o.fleet.turtlePositions(this.o.world, this.o.dimension, this.o.turtleId)) blocked.add(key(p));
    for (const p of this.o.traffic.reservedBy(this.o.turtleId, this.o.world, this.o.dimension)) blocked.add(key(p));
    for (const p of this.o.extraBlocked?.() ?? []) blocked.add(key(p));
    const rows = this.o.fleet.queryMap({ world: this.o.world, dimension: this.o.dimension, x0: here.x - 16, x1: here.x + 16, z0: here.z - 16, z1: here.z + 16, y0: here.y - 8, y1: here.y + 8 }).blocks;
    const free = new Set(rows.filter((b) => b.cell !== 'solid').map((b) => key(b)));
    const queue: Vec3[] = [here];
    const seen = new Set([key(here)]);
    while (queue.length) {
      const c = queue.shift()!;
      if (!eq(c, here) && !avoid.has(key(c))) return c;
      for (const d of [
        { x: 1, y: 0, z: 0 },
        { x: -1, y: 0, z: 0 },
        { x: 0, y: 0, z: 1 },
        { x: 0, y: 0, z: -1 },
        { x: 0, y: 1, z: 0 },
        { x: 0, y: -1, z: 0 },
      ]) {
        const n = { x: c.x + d.x, y: c.y + d.y, z: c.z + d.z };
        const k = key(n);
        if (seen.has(k) || !free.has(k) || blocked.has(k) || Math.abs(n.x - here.x) > 16 || Math.abs(n.z - here.z) > 16) continue;
        seen.add(k);
        queue.push(n);
      }
    }
    return undefined;
  }
}

