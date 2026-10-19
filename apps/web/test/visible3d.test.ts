import { describe, expect, it } from 'vitest';
import type { MapBlock } from '@ccfleet/protocol';
import { surface, visibleBlocks } from '../src/lib/visible3d';

/** A solid cube of stone from (0,0,0) to (n-1,n-1,n-1), as layers keyed "x,z". */
function cube(n: number, extra: MapBlock[] = []) {
  const byY = new Map<number, Map<string, MapBlock>>();
  const put = (b: MapBlock) => {
    if (!byY.has(b.y)) byY.set(b.y, new Map());
    byY.get(b.y)!.set(`${b.x},${b.z}`, b);
  };
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) put({ x, y, z, block: 'minecraft:stone', cell: 'solid', observedAt: 0 });
  extra.forEach(put);
  return (y: number) => byY.get(y);
}

describe('3D view: which blocks are drawn', () => {
  it('skips enclosed blocks, keeps the shell', () => {
    const r = visibleBlocks(cube(5), { x0: 0, x1: 4, y0: 0, y1: 4, z0: 0, z1: 4 });
    expect(r.solids.length).toBe(5 ** 3 - 3 ** 3);
  });

  it('draws the sides of the box even where the map goes on beyond it', () => {
    // Mapped 7x7x7, viewed through the 5x5x5 box in its middle: the box's shell shows.
    const r = visibleBlocks(cube(7), { x0: 1, x1: 5, y0: 1, y1: 5, z0: 1, z1: 5 });
    expect(r.solids.length).toBe(5 ** 3 - 3 ** 3);
    expect(r.solids.every((b) => b.x >= 1 && b.x <= 5 && b.y >= 1 && b.y <= 5 && b.z >= 1 && b.z <= 5)).toBe(true);
  });

  it('a Y cut opens the top: the layer under the cut is drawn', () => {
    const r = visibleBlocks(cube(5), { x0: 0, x1: 4, y0: 0, y1: 2, z0: 0, z1: 4 });
    expect(r.solids.filter((b) => b.y === 2).length).toBe(25);
  });

  it('ores and fluids are always listed, even when enclosed', () => {
    const r = visibleBlocks(
      cube(5, [
        { x: 2, y: 2, z: 2, block: 'emendatusenigmatica:coal_ore', cell: 'solid', observedAt: 0 },
        { x: 2, y: 1, z: 2, block: 'minecraft:water', cell: 'fluid', observedAt: 0 },
      ]),
      { x0: 0, x1: 4, y0: 0, y1: 4, z0: 0, z1: 4 },
    );
    expect(r.ores.map((b) => b.block)).toEqual(['emendatusenigmatica:coal_ore']);
    expect(r.fluids.length).toBe(1);
    // The stone next to the water is now visible through it.
    expect(r.solids.some((b) => b.x === 2 && b.y === 0 && b.z === 2)).toBe(true);
  });
});

describe('3D view: far chunks draw their surface', () => {
  it('keeps the top block of each column, ores at any depth, and water on top', () => {
    const cells: MapBlock[] = [];
    for (let y = 0; y < 6; y++) cells.push({ x: 0, y, z: 0, block: 'minecraft:stone', cell: 'solid', observedAt: 0 });
    cells.push({ x: 0, y: 2, z: 0, block: 'minecraft:diamond_ore', cell: 'solid', observedAt: 0 });
    for (let y = 0; y < 3; y++) cells.push({ x: 1, y, z: 0, block: 'minecraft:dirt', cell: 'solid', observedAt: 0 });
    cells.push({ x: 1, y: 3, z: 0, block: 'minecraft:water', cell: 'fluid', observedAt: 0 });
    cells.push({ x: 0, y: 1, z: 0, block: 'minecraft:water', cell: 'fluid', observedAt: 0 }); // under rock: hidden
    const r = surface(cells);
    expect(r.solids.map((b) => `${b.x},${b.y}`).sort()).toEqual(['0,5', '1,2']);
    expect(r.ores.map((b) => b.y)).toEqual([2]);
    expect(r.fluids.map((b) => `${b.x},${b.y}`)).toEqual(['1,3']);
  });
});
