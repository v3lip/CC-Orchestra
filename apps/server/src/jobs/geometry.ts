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

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.min.x <= b.max.x && b.min.x <= a.max.x && a.min.y <= b.max.y && b.min.y <= a.max.y && a.min.z <= b.max.z && b.min.z <= a.max.z;
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

/**
 * Split a tunnel's width into side-by-side lanes, one per turtle (at most one per
 * column). Turtles are assigned left to right by where they stand, so their paths to
 * their lanes don't cross. Returns the lanes and the turtles left without one.
 */
export function splitTunnel(p: TunnelParams, turtles: { id: string; pos?: Vec3 }[]): { lanes: { turtleId: string; params: TunnelParams; index: number }[]; skipped: string[] } {
  const n = Math.min(turtles.length, p.width);
  const { r } = frame(p.heading as Heading);
  const along = (t: { pos?: Vec3 }) => (t.pos ? (t.pos.x - p.origin.x) * r.x + (t.pos.z - p.origin.z) * r.z : Infinity);
  const ordered = [...turtles].sort((a, b) => along(a) - along(b));
  const base = Math.floor(p.width / n);
  const extra = p.width % n;
  const lanesOut: { turtleId: string; params: TunnelParams; index: number }[] = [];
  let offset = 0;
  for (let i = 0; i < n; i++) {
    const width = base + (i < extra ? 1 : 0);
    const o = tunnelCell(p, 0, offset, 0);
    lanesOut.push({ turtleId: ordered[i].id, index: i, params: { ...p, origin: o, width } });
    offset += width;
  }
  return { lanes: lanesOut, skipped: ordered.slice(n).map((t) => t.id) };
}

export const chunkOf = (p: { x: number; z: number }) => ({ cx: Math.floor(p.x / 16), cz: Math.floor(p.z / 16) });

/**
 * Chunks a tunnel job will visit: the tunnel's footprint, the dock, and the chunks on a
 * straight line between them (an approximation of the route).
 */
export function jobChunks(p: TunnelParams, dock: Vec3): { cx: number; cz: number }[] {
  const out = new Map<string, { cx: number; cz: number }>();
  const add = (x: number, z: number) => {
    const c = chunkOf({ x, z });
    out.set(`${c.cx},${c.cz}`, c);
  };
  const b = tunnelBox(p);
  for (let cx = Math.floor(b.min.x / 16); cx <= Math.floor(b.max.x / 16); cx++)
    for (let cz = Math.floor(b.min.z / 16); cz <= Math.floor(b.max.z / 16); cz++) out.set(`${cx},${cz}`, { cx, cz });
  add(dock.x, dock.z);
  const steps = Math.max(Math.abs(p.origin.x - dock.x), Math.abs(p.origin.z - dock.z), 1);
  for (let i = 0; i <= steps; i++) add(Math.round(dock.x + ((p.origin.x - dock.x) * i) / steps), Math.round(dock.z + ((p.origin.z - dock.z) * i) / steps));
  return [...out.values()];
}
