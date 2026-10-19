/** Chunk bookkeeping for the map cache and the 3D view. */

export const CHUNK = 16;

export const chunkOfX = (x: number) => Math.floor(x / CHUNK);
export const chunkKey = (cx: number, cz: number) => `${cx},${cz}`;

/**
 * Chunks whose look in 3D a set of changed blocks can affect: the chunk each block is
 * in, and the neighbouring chunk across any chunk edge the block touches (a block on
 * the edge decides whether the neighbour's edge block is hidden).
 */
export function chunksTouched(blocks: { x: number; z: number }[]): Set<string> {
  const out = new Set<string>();
  for (const b of blocks) {
    const cx = chunkOfX(b.x);
    const cz = chunkOfX(b.z);
    out.add(chunkKey(cx, cz));
    const lx = b.x - cx * CHUNK;
    const lz = b.z - cz * CHUNK;
    if (lx === 0) out.add(chunkKey(cx - 1, cz));
    if (lx === CHUNK - 1) out.add(chunkKey(cx + 1, cz));
    if (lz === 0) out.add(chunkKey(cx, cz - 1));
    if (lz === CHUNK - 1) out.add(chunkKey(cx, cz + 1));
  }
  return out;
}

/**
 * Group chunks into requests of at most `size`×`size` chunks, so no map request can
 * exceed the server's row limit (4×4 chunks × 16 levels = 65 536 cells).
 */
export function tiles(chunks: { cx: number; cz: number }[], size = 4): { cx0: number; cx1: number; cz0: number; cz1: number; chunks: { cx: number; cz: number }[] }[] {
  const groups = new Map<string, { cx: number; cz: number }[]>();
  for (const c of chunks) {
    const k = `${Math.floor(c.cx / size)},${Math.floor(c.cz / size)}`;
    const g = groups.get(k);
    if (g) g.push(c);
    else groups.set(k, [c]);
  }
  return [...groups.values()].map((cs) => ({
    cx0: Math.min(...cs.map((c) => c.cx)),
    cx1: Math.max(...cs.map((c) => c.cx)),
    cz0: Math.min(...cs.map((c) => c.cz)),
    cz1: Math.max(...cs.map((c) => c.cz)),
    chunks: cs,
  }));
}

/**
 * Which chunk meshes of the 3D view need rebuilding: those in view whose map version
 * moved since they were built (or never built), and built ones that left the view.
 */
export function chunkWork(inView: string[], built: Map<string, number>, version: (k: string) => number): { rebuild: string[]; drop: string[] } {
  const view = new Set(inView);
  const rebuild = inView.filter((k) => built.get(k) !== version(k));
  const drop = [...built.keys()].filter((k) => !view.has(k));
  return { rebuild, drop };
}

/** Chunks within this many chunks of the centre (Chebyshev) get full detail. */
export const LOD_FULL_RADIUS = 3;
/** Most blocks the 3D view draws; beyond it near chunks fall back to their surface. */
export const MAX_INSTANCES = 200_000;

export const lodFull = (cx: number, cz: number, ccx: number, ccz: number) => Math.max(Math.abs(cx - ccx), Math.abs(cz - ccz)) <= LOD_FULL_RADIUS;

/** The chunk columns covering a box, nearest to the centre chunk first. */
export function chunkOrder(box: { x0: number; x1: number; z0: number; z1: number }, ccx: number, ccz: number): string[] {
  const out: { k: string; d: number }[] = [];
  for (let cx = Math.floor(box.x0 / CHUNK); cx <= Math.floor(box.x1 / CHUNK); cx++)
    for (let cz = Math.floor(box.z0 / CHUNK); cz <= Math.floor(box.z1 / CHUNK); cz++) out.push({ k: chunkKey(cx, cz), d: (cx - ccx) ** 2 + (cz - ccz) ** 2 });
  return out.sort((a, b) => a.d - b.d).map((c) => c.k);
}
