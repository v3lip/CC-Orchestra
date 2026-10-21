import { describe, expect, it } from 'vitest';
import type { TunnelParams } from '@ccfleet/protocol';
import { sectionBox } from '@ccfleet/protocol';
import { routeAhead, sectionProgress, splitSection } from '../src/lib/progress';

const seg = (o: [number, number, number], heading: 0 | 1 | 2 | 3, length: number, width = 1): TunnelParams => ({ origin: { x: o[0], y: o[1], z: o[2] }, heading, width, height: 2, length });

describe('job progress and routes', () => {
  it('a route is drawn from the turtle onwards, not from where it was planned', () => {
    const route = [0, 1, 2, 3, 4].map((x) => ({ x, y: 10, z: 0 }));
    expect(routeAhead(route, { x: 2, y: 10, z: 0 }).map((c) => c.x)).toEqual([2, 3, 4]);
    expect(routeAhead(route, { x: 9, y: 10, z: 0 })).toHaveLength(5); // off the route: draw all of it
    expect(routeAhead(undefined, { x: 0, y: 0, z: 0 })).toEqual([]);
  });

  it('splits a section into the dug part and the rest, along its heading', () => {
    const east = seg([10, 64, 5], 1, 8, 3); // heading east, 3 wide to the south
    const { dug, left } = splitSection(east, 3);
    expect(sectionBox(dug!)).toEqual({ min: { x: 10, y: 64, z: 5 }, max: { x: 12, y: 65, z: 7 } });
    expect(sectionBox(left!)).toEqual({ min: { x: 13, y: 64, z: 5 }, max: { x: 17, y: 65, z: 7 } });
    const north = splitSection(seg([0, 64, 0], 0, 4), 1);
    expect(sectionBox(north.left!).max.z).toBe(-1);
    expect(sectionBox(north.left!).min.z).toBe(-3);
    expect(splitSection(east, 0).dug).toBeUndefined();
    expect(splitSection(east, 8).left).toBeUndefined();
  });

  it('shares the finished slices out over the sections in order', () => {
    const segs = [seg([0, 0, 0], 1, 4), seg([0, -3, 0], 1, 4), seg([0, -6, 0], 1, 4)];
    expect(sectionProgress(segs, 6).map((p) => p.done)).toEqual([4, 2, 0]);
    expect(sectionProgress(segs, 12).map((p) => p.done)).toEqual([4, 4, 4]);
  });
});
