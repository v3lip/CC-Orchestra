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
export function visibleBlocks(layer: (y: number) => Map<string, MapBlock> | undefined, box: Box3): { solids: MapBlock[]; ores: MapBlock[]; fluids: MapBlock[] } {
  const { x0, x1, y0, y1, z0, z1 } = box;
  const at = (x: number, y: number, z: number) => (y > y1 || y < y0 || x < x0 || x > x1 || z < z0 || z > z1 ? undefined : layer(y)?.get(`${x},${z}`));
  const solids: MapBlock[] = [];
  const ores: MapBlock[] = [];
  const fluids: MapBlock[] = [];
  for (let y = y0; y <= y1; y++) {
    const l = layer(y);
    if (!l) continue;
    for (const b of l.values()) {
      if (b.x < x0 || b.x > x1 || b.z < z0 || b.z > z1 || b.cell === 'empty') continue;
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
  }
  return { solids, ores, fluids };
}
