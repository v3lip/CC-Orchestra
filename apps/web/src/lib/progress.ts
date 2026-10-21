import type { TunnelParams, Vec3 } from '@ccfleet/protocol';
import { HEADING_VECTORS } from '@ccfleet/protocol';

/**
 * The part of a planned route still ahead of a turtle: a route is published when it is
 * planned, so as the turtle walks, the cells behind it would otherwise keep being drawn.
 */
export function routeAhead(route: Vec3[] | undefined, pos: Vec3 | undefined): Vec3[] {
  if (!route?.length) return [];
  if (!pos) return route;
  const i = route.findIndex((c) => c.x === pos.x && c.y === pos.y && c.z === pos.z);
  return i < 0 ? route : route.slice(i);
}

/** A section split at `done` slices into the dug part and the part still to dig. */
export function splitSection(seg: TunnelParams, done: number): { dug?: TunnelParams; left?: TunnelParams } {
  const d = Math.max(0, Math.min(seg.length, done));
  const f = HEADING_VECTORS[seg.heading];
  return {
    dug: d > 0 ? { ...seg, length: d } : undefined,
    left: d < seg.length ? { ...seg, origin: { x: seg.origin.x + f.x * d, y: seg.origin.y, z: seg.origin.z + f.z * d }, length: seg.length - d } : undefined,
  };
}

/** Each section of a job with its share of the finished slices (sections are mined in order). */
export function sectionProgress(segments: TunnelParams[], unitsDone: number): { seg: TunnelParams; done: number }[] {
  let left = unitsDone;
  return segments.map((seg) => {
    const done = Math.max(0, Math.min(seg.length, left));
    left -= seg.length;
    return { seg, done };
  });
}
