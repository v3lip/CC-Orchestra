/**
 * Traffic control between turtles driven by the server (jobs and go-to tasks).
 *
 * - Before each move a turtle reserves the cell it is about to enter. A cell is taken
 *   if any turtle stands in it (including offline turtles and the candidate cells of
 *   turtles with an uncertain position) or another turtle has reserved it. Since a
 *   turtle may only enter a free, unreserved cell, two turtles can never swap places
 *   head-on or end up in the same cell.
 * - Turtles that wait record whom they wait for. A cycle (A waits for B, B waits for
 *   A) is a deadlock; the lowest-priority member able to step aside does so.
 * - Turtles not driven by the server (manual control, idle, offline) are fixed
 *   obstacles: others re-plan around them instead of waiting forever.
 */
import type { Vec3 } from '@ccfleet/protocol';
import type { Fleet } from '../fleet';
import { key } from './geometry';

interface Agent {
  id: string;
  name: string;
  world: string;
  dimension: string;
  /** Smaller = more important (e.g. earlier start time). */
  priority: number;
  reserved?: string;
  route: string[];
  waitingFor?: string;
  /** Tried to step aside and found nowhere to go. */
  noYield: boolean;
}

export type Holder = { id: string; agent: boolean; name: string };
export type Resolution = 'wait' | 'yield' | 'stuck';

const ROUTE_HORIZON = 32;

export class Traffic {
  private agents = new Map<string, Agent>();

  constructor(private fleet: Fleet) {}

  join(id: string, name: string, world: string, dimension: string, priority: number): void {
    this.agents.set(id, { id, name, world, dimension, priority, route: [], noYield: false });
  }

  leave(id: string): void {
    this.agents.delete(id);
    for (const a of this.agents.values()) if (a.waitingFor === id) a.waitingFor = undefined;
  }

  isAgent(id: string): boolean {
    return this.agents.has(id);
  }

  setRoute(id: string, cells: Vec3[]): void {
    const a = this.agents.get(id);
    if (a) a.route = cells.slice(0, ROUTE_HORIZON).map(key);
  }

  routeCells(id: string): Set<string> {
    return new Set(this.agents.get(id)?.route ?? []);
  }

  /** Who keeps `me` out of `cell`, if anyone. */
  holder(me: string, cell: Vec3): Holder | undefined {
    const a = this.agents.get(me);
    if (!a) return undefined;
    const k = key(cell);
    for (const t of this.fleet.listTurtles()) {
      if (t.id === me || t.world !== a.world || t.dimension !== a.dimension) continue;
      const pose = t.state?.pose;
      const cells = [...(pose?.pos ? [pose.pos] : []), ...(pose?.candidates ?? [])];
      if (cells.some((c) => key(c) === k)) return { id: t.id, agent: this.agents.has(t.id), name: t.name };
    }
    for (const o of this.agents.values()) {
      if (o.id !== me && o.world === a.world && o.dimension === a.dimension && o.reserved === k) return { id: o.id, agent: true, name: o.name };
    }
    return undefined;
  }

  /** Reserve `cell` for `me`. Returns the holder if it is taken. */
  tryReserve(me: string, cell: Vec3): Holder | undefined {
    const h = this.holder(me, cell);
    if (h) return h;
    const a = this.agents.get(me);
    if (a) a.reserved = key(cell);
    return undefined;
  }

  release(me: string, moved = false): void {
    const a = this.agents.get(me);
    if (!a) return;
    a.reserved = undefined;
    if (moved) a.noYield = false;
  }

  /** Cells reserved by other agents (for path planning). */
  reservedBy(others: string, world: string, dimension: string): Vec3[] {
    const out: Vec3[] = [];
    for (const a of this.agents.values()) {
      if (a.id === others || a.world !== world || a.dimension !== dimension || !a.reserved) continue;
      const [x, y, z] = a.reserved.split(',').map(Number);
      out.push({ x, y, z });
    }
    return out;
  }

  setWaiting(me: string, holder: string | undefined): void {
    const a = this.agents.get(me);
    if (a) a.waitingFor = holder;
  }

  /** Agents currently waiting for `me`. */
  waitingFor(me: string): string[] {
    return [...this.agents.values()].filter((a) => a.waitingFor === me).map((a) => a.id);
  }

  markNoYield(me: string): void {
    const a = this.agents.get(me);
    if (a) a.noYield = true;
  }

  /**
   * Follow the wait-for chain from `me`. If it loops back, it is a deadlock: the least
   * important member that can still step aside yields. 'stuck' = nobody can.
   */
  resolve(me: string): Resolution {
    const cycle: Agent[] = [];
    const seen = new Set<string>();
    let cur = this.agents.get(me);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      cycle.push(cur);
      cur = cur.waitingFor ? this.agents.get(cur.waitingFor) : undefined;
    }
    if (!cur || cur.id !== me) return 'wait'; // chain ends (or loops elsewhere): not our deadlock
    const able = cycle.filter((a) => !a.noYield);
    if (able.length === 0) return 'stuck';
    const victim = able.reduce((v, a) => (a.priority > v.priority || (a.priority === v.priority && a.id > v.id) ? a : v));
    return victim.id === me ? 'yield' : 'wait';
  }

  name(id: string): string {
    return this.agents.get(id)?.name ?? this.fleet.getTurtle(id)?.name ?? id;
  }
}
