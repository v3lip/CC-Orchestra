/** Framing and coordinates of the 3D view's top-down overview inset. */

export interface Frame {
  /** World X/Z at the inset's centre. */
  cx: number;
  cz: number;
  /** Half the width (and height) the inset shows, in blocks. */
  half: number;
}

/**
 * A square frame around the 3D area that also fits every point of interest (turtles,
 * depots), with a margin, never smaller than `minHalf`, rounded up to a whole chunk.
 */
export function overviewFrame(box: { x0: number; x1: number; z0: number; z1: number }, points: { x: number; z: number }[], minHalf = 192): Frame {
  const xs = [box.x0, box.x1 + 1, ...points.map((p) => p.x)];
  const zs = [box.z0, box.z1 + 1, ...points.map((p) => p.z)];
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const z0 = Math.min(...zs);
  const z1 = Math.max(...zs);
  const half = Math.max(minHalf, Math.ceil((Math.max(x1 - x0, z1 - z0) / 2) * 1.1 / 16) * 16);
  return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, half };
}

/** World X/Z to inset pixels (north, −Z, up). */
export function toInset(f: Frame, size: number, x: number, z: number): { px: number; py: number } {
  const s = size / (2 * f.half);
  return { px: (x - f.cx) * s + size / 2, py: (z - f.cz) * s + size / 2 };
}

/** Inset pixels back to the world block under them. */
export function fromInset(f: Frame, size: number, px: number, py: number): { x: number; z: number } {
  const s = (2 * f.half) / size;
  return { x: Math.floor((px - size / 2) * s + f.cx), z: Math.floor((py - size / 2) * s + f.cz) };
}
