import type { Vec3 } from '@ccfleet/protocol';

/** Has a followed turtle wandered far enough from the 3D area's centre to move the area? */
export function needsRecentre(center: Vec3, pos: Vec3, radius: number): boolean {
  return Math.abs(pos.x - center.x) > radius / 2 || Math.abs(pos.z - center.z) > radius / 2 || Math.abs(pos.y - center.y) > 8;
}

/**
 * One frame of following: move the orbit target a fraction of the way to the goal, and
 * the camera by the same amount, so the viewing angle and distance stay as they were.
 * Returns the shift applied (zero once there).
 */
export function followStep(target: Vec3, camera: Vec3, goal: Vec3, fraction = 0.2): Vec3 {
  const d = { x: goal.x - target.x, y: goal.y - target.y, z: goal.z - target.z };
  if (Math.hypot(d.x, d.y, d.z) < 0.01) return { x: 0, y: 0, z: 0 };
  const step = { x: d.x * fraction, y: d.y * fraction, z: d.z * fraction };
  target.x += step.x;
  target.y += step.y;
  target.z += step.z;
  camera.x += step.x;
  camera.y += step.y;
  camera.z += step.z;
  return step;
}
