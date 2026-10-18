/**
 * A* over what the fleet has actually observed. Costs:
 *   known empty 1 · fluid 1.5 · unknown 3 (may turn out solid: the runner re-plans)
 *   solid that this job may dig: 3 · solid it may not dig, other turtles, depot chests: impassable
 * Search is bounded to a box around start and goal and a node budget.
 */
import type { MapBlock, Vec3 } from '@ccfleet/protocol';
import { key, manhattan } from './geometry';

export interface NavContext {
  cell(p: Vec3): MapBlock | undefined;
  /** Cells that must never be entered. */
  blocked: Set<string>;
  canDig(p: Vec3, block: string | null): boolean;
  bounds: { min: Vec3; max: Vec3 };
}

const NEIGHBOURS: Vec3[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
];

export function stepCost(ctx: NavContext, p: Vec3): number {
  if (ctx.blocked.has(key(p))) return Infinity;
  const c = ctx.cell(p);
  if (!c) return 3;
  if (c.cell === 'empty') return 1;
  if (c.cell === 'fluid') return 1.5;
  return ctx.canDig(p, c.block) ? 3 : Infinity;
}

class Heap {
  private a: { k: string; f: number }[] = [];
  push(k: string, f: number) {
    const a = this.a;
    a.push({ k, f });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): string | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top.k;
  }
  get size() {
    return this.a.length;
  }
}

/** Path from start to goal (excluding start, including goal), or null. */
export function planPath(ctx: NavContext, start: Vec3, goal: Vec3, maxNodes = 200_000): Vec3[] | null {
  if (stepCost(ctx, goal) === Infinity) return null;
  const startK = key(start);
  const goalK = key(goal);
  const g = new Map<string, number>([[startK, 0]]);
  const from = new Map<string, string>();
  const pos = new Map<string, Vec3>([[startK, start]]);
  const open = new Heap();
  open.push(startK, manhattan(start, goal));
  const closed = new Set<string>();
  const b = ctx.bounds;
  let expanded = 0;
  while (open.size) {
    const k = open.pop()!;
    if (k === goalK) {
      const path: Vec3[] = [];
      for (let c: string | undefined = k; c && c !== startK; c = from.get(c)) path.push(pos.get(c)!);
      return path.reverse();
    }
    if (closed.has(k)) continue;
    closed.add(k);
    if (++expanded > maxNodes) return null;
    const p = pos.get(k)!;
    for (const n of NEIGHBOURS) {
      const q = { x: p.x + n.x, y: p.y + n.y, z: p.z + n.z };
      if (q.x < b.min.x || q.x > b.max.x || q.y < b.min.y || q.y > b.max.y || q.z < b.min.z || q.z > b.max.z) continue;
      const qk = key(q);
      if (closed.has(qk)) continue;
      const c = stepCost(ctx, q);
      if (c === Infinity) continue;
      const ng = g.get(k)! + c;
      if (ng < (g.get(qk) ?? Infinity)) {
        g.set(qk, ng);
        from.set(qk, k);
        pos.set(qk, q);
        open.push(qk, ng + manhattan(q, goal));
      }
    }
  }
  return null;
}
