import { type Box, type Heading, type TunnelParams, type Vec3, HEADING_VECTORS } from '@ccfleet/protocol';

export const key = (v: Vec3) => `${v.x},${v.y},${v.z}`;
export const eq = (a: Vec3, b: Vec3) => a.x === b.x && a.y === b.y && a.z === b.z;
export const fmt = (v: Vec3) => `(${v.x} ${v.y} ${v.z})`;
export const manhattan = (a: Vec3, b: Vec3) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);

export function inBox(b: Box, c: Vec3): boolean {
  return c.x >= b.min.x && c.x <= b.max.x && c.y >= b.min.y && c.y <= b.max.y && c.z >= b.min.z && c.z <= b.max.z;
}

function frame(h: Heading) {
  return { f: HEADING_VECTORS[h], r: HEADING_VECTORS[(h + 1) % 4] };
}

/** Cell at slice d, column w (to the right), row h (up). */
export function tunnelCell(p: TunnelParams, d: number, w: number, h: number): Vec3 {
  const { f, r } = frame(p.heading as Heading);
  return { x: p.origin.x + f.x * d + r.x * w, y: p.origin.y + h, z: p.origin.z + f.z * d + r.z * w };
}

/** Local (d, w, h) of a world cell, or undefined if it is outside the tunnel. */
export function tunnelLocal(p: TunnelParams, c: Vec3): { d: number; w: number; h: number } | undefined {
  const { f, r } = frame(p.heading as Heading);
  const rx = c.x - p.origin.x;
  const rz = c.z - p.origin.z;
  const d = rx * f.x + rz * f.z;
  const w = rx * r.x + rz * r.z;
  const h = c.y - p.origin.y;
  if (d < 0 || d >= p.length || w < 0 || w >= p.width || h < 0 || h >= p.height) return undefined;
  return { d, w, h };
}

/** Axis-aligned bounding box of the tunnel. */
export function tunnelBox(p: TunnelParams): Box {
  const a = tunnelCell(p, 0, 0, 0);
  const b = tunnelCell(p, p.length - 1, p.width - 1, p.height - 1);
  return {
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
  };
}

/**
 * Rows the turtle walks along. From each lane row it also digs the rows directly
 * above and below, so one pass clears three rows.
 */
export function lanes(height: number): number[] {
  const out: number[] = [];
  for (let l = 1; l - 1 < height; l += 3) {
    const v = Math.min(l, height - 1);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

export interface Station {
  /** Where the turtle stands (itself a tunnel cell, cleared by moving in). */
  pos: Vec3;
  /** Cells directly above/below to clear from here. */
  extra: Vec3[];
}

/**
 * Stations of one slice in serpentine order. Odd slices run in reverse so the last
 * station of a slice is directly behind the first station of the next one.
 */
export function sliceStations(p: TunnelParams, d: number): Station[] {
  const ls = lanes(p.height);
  const laneSet = new Set(ls);
  const covered = new Set<number>(ls);
  const rowsFor = (l: number) => {
    const rows: number[] = [];
    for (const r of [l - 1, l + 1]) {
      if (r >= 0 && r < p.height && !laneSet.has(r) && !covered.has(r)) {
        covered.add(r);
        rows.push(r);
      }
    }
    return rows;
  };
  const extraRows = ls.map(rowsFor);
  const seq: Station[] = [];
  ls.forEach((l, i) => {
    const cols = Array.from({ length: p.width }, (_, w) => w);
    if (i % 2 === 1) cols.reverse();
    for (const w of cols) seq.push({ pos: tunnelCell(p, d, w, l), extra: extraRows[i].map((r) => tunnelCell(p, d, w, r)) });
  });
  return d % 2 === 0 ? seq : seq.reverse();
}
