import { describe, expect, it } from 'vitest';
import type { MapBlock } from '@ccfleet/protocol';
import { chunkWork, chunksTouched, tiles } from '../src/lib/chunks';
import { mapCache } from '../src/lib/store';

const stone = (x: number, y: number, z: number): MapBlock => ({ x, y, z, block: 'minecraft:stone', cell: 'solid', observedAt: 0 });

describe('chunk bookkeeping', () => {
  it('a block inside a chunk touches only that chunk; on an edge, also the neighbour across it', () => {
    expect([...chunksTouched([{ x: 5, z: 5 }])]).toEqual(['0,0']);
    expect([...chunksTouched([{ x: 16, z: 5 }])].sort()).toEqual(['0,0', '1,0']);
    expect([...chunksTouched([{ x: -1, z: 15 }])].sort()).toEqual(['-1,0', '-1,1', '0,0'].sort());
  });

  it('splits a big area into requests of at most 4×4 chunks, covering each chunk once', () => {
    const chunks = [];
    for (let cx = -3; cx < 7; cx++) for (let cz = 0; cz < 10; cz++) chunks.push({ cx, cz });
    const ts = tiles(chunks);
    expect(ts.every((t) => t.cx1 - t.cx0 < 4 && t.cz1 - t.cz0 < 4)).toBe(true);
    expect(ts.flatMap((t) => t.chunks).length).toBe(100);
    // 4x4 chunks x 16 levels stays under the server's 100 000-row limit.
    expect(Math.max(...ts.map((t) => (t.cx1 - t.cx0 + 1) * (t.cz1 - t.cz0 + 1) * 16 * 16 * 16))).toBeLessThanOrEqual(65536);
  });

  it('an update touching one chunk rebuilds one chunk mesh (and drops ones out of view)', () => {
    mapCache.reset();
    const inView: string[] = [];
    for (let cx = 0; cx < 16; cx++) for (let cz = 0; cz < 16; cz++) inView.push(`${cx},${cz}`);
    // Everything built and up to date.
    const built = new Map(inView.map((k) => [k, mapCache.version(k)]));
    expect(chunkWork(inView, built, (k) => mapCache.version(k)).rebuild).toEqual([]);
    // A turtle reports one block in the middle of chunk 5,7.
    mapCache.put([stone(5 * 16 + 8, 60, 7 * 16 + 8)]);
    expect(chunkWork(inView, built, (k) => mapCache.version(k)).rebuild).toEqual(['5,7']);
    // On the chunk's edge, its neighbour is rebuilt too.
    built.set('5,7', mapCache.version('5,7'));
    mapCache.put([stone(5 * 16 + 15, 60, 7 * 16 + 8)]);
    expect(chunkWork(inView, built, (k) => mapCache.version(k)).rebuild.sort()).toEqual(['5,7', '6,7']);
    // Moving the view: chunks no longer in it are dropped.
    const work = chunkWork(inView.slice(16), built, (k) => mapCache.version(k));
    expect(work.drop.length).toBe(16);
  });

  it('resetting the map cache invalidates every built chunk', () => {
    mapCache.reset();
    const built = new Map([['0,0', mapCache.version('0,0')]]);
    mapCache.reset();
    expect(chunkWork(['0,0'], built, (k) => mapCache.version(k)).rebuild).toEqual(['0,0']);
  });
});
