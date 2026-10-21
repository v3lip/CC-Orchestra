import { describe, expect, it } from 'vitest';
import { fromInset, overviewFrame, toInset } from '../src/lib/overview';

const box = { x0: -128, x1: 127, z0: -128, z1: 127 };

describe('3D overview inset', () => {
  it('shows at least the minimum range around the 3D area', () => {
    const f = overviewFrame(box, []);
    expect(f.half).toBe(192);
    expect(f.cx).toBe(0);
    expect(f.cz).toBe(0);
  });

  it('widens to fit far turtles and depots, keeping the 3D area in view', () => {
    const f = overviewFrame(box, [{ x: 900, z: -40 }]);
    const pts = [
      { x: 900, z: -40 },
      { x: box.x0, z: box.z0 },
      { x: box.x1, z: box.z1 },
    ];
    for (const p of pts) {
      const { px, py } = toInset(f, 180, p.x, p.z);
      expect(px).toBeGreaterThanOrEqual(0);
      expect(px).toBeLessThanOrEqual(180);
      expect(py).toBeGreaterThanOrEqual(0);
      expect(py).toBeLessThanOrEqual(180);
    }
    expect(f.half % 16).toBe(0);
  });

  it('a click lands on the block that was drawn there', () => {
    const f = overviewFrame(box, [{ x: 300, z: 300 }]);
    for (const [x, z] of [
      [0, 0],
      [-120, 77],
      [299, 300],
    ]) {
      const { px, py } = toInset(f, 180, x + 0.5, z + 0.5);
      expect(fromInset(f, 180, px, py)).toEqual({ x, z });
    }
  });
});
