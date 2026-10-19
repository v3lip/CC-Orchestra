import type { MapBlock } from '@ccfleet/protocol';
import { isOreBlock } from '@ccfleet/protocol';

export interface Box3 {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

const NEIGHBOURS: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * The blocks the 3D view draws inside `box`: fluids, ores, and ordinary solid blocks
 * that are not enclosed by solid blocks on all six sides. Anything outside the box
 * counts as open, so the box's own sides (and the Y cut) show their blocks.
 */
export function visibleBlocks(layer: Layer, box: Box3): Visible {
  return classify(cellsIn(layer, box), layer, box);
}

type Layer = (y: number) => Map<string, MapBlock> | undefined;
export type Visible = { solids: MapBlock[]; ores: MapBlock[]; fluids: MapBlock[] };

/** Known cells inside a (small) box, read cell by cell: for one chunk column. */
export function cellsIn(layer: Layer, box: Box3): MapBlock[] {
  const out: MapBlock[] = [];
  for (let y = box.y0; y <= box.y1; y++) {
    const l = layer(y);
    if (!l) continue;
    for (let x = box.x0; x <= box.x1; x++)
      for (let z = box.z0; z <= box.z1; z++) {
        const b = l.get(`${x},${z}`);
        if (b) out.push(b);
      }
  }
  return out;
}

/** Known cells inside a (large) box, grouped by chunk column "cx,cz", in one pass over the layers. */
export function cellsByChunk(layer: Layer, box: Box3): Map<string, MapBlock[]> {
  const out = new Map<string, MapBlock[]>();
  for (let y = box.y0; y <= box.y1; y++) {
    const l = layer(y);
    if (!l) continue;
    for (const b of l.values()) {
      if (b.x < box.x0 || b.x > box.x1 || b.z < box.z0 || b.z > box.z1) continue;
      const k = `${Math.floor(b.x / 16)},${Math.floor(b.z / 16)}`;
      const list = out.get(k);
      if (list) list.push(b);
      else out.set(k, [b]);
    }
  }
  return out;
}

/**
 * Sort cells into what is drawn. Neighbours are looked up within `bounds` (the whole
 * view), so a chunk's edge blocks are hidden by blocks in the next chunk, but the
 * view's own sides stay open.
 */
export function classify(cells: MapBlock[], layer: Layer, bounds: Box3): Visible {
  const { x0, x1, y0, y1, z0, z1 } = bounds;
  const at = (x: number, y: number, z: number) => (y > y1 || y < y0 || x < x0 || x > x1 || z < z0 || z > z1 ? undefined : layer(y)?.get(`${x},${z}`));
  const solids: MapBlock[] = [];
  const ores: MapBlock[] = [];
  const fluids: MapBlock[] = [];
  for (const b of cells) {
    if (b.cell === 'empty') continue;
    if (b.cell === 'fluid') {
      fluids.push(b);
      continue;
    }
    if (isOreBlock(b.block)) {
      ores.push(b);
      continue;
    }
    // Skip blocks with a solid block on every side: they can't be seen.
    if (NEIGHBOURS.every(([dx, dy, dz]) => at(b.x + dx, b.y + dy, b.z + dz)?.cell === 'solid')) continue;
    solids.push(b);
  }
  return { solids, ores, fluids };
}
