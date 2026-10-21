import { describe, expect, it } from 'vitest';
import { DRIVE_KEYS, VIEW3D_KEYS, isTyping, view3dAction } from '../src/lib/keys';
import { followStep, needsRecentre } from '../src/lib/follow';

describe('3D keyboard shortcuts', () => {
  it('never clash with the keys that drive turtles (or Escape)', () => {
    const drive = new Set([...Object.keys(DRIVE_KEYS), 'escape']);
    for (const k of Object.keys(VIEW3D_KEYS)) expect(drive.has(k), k).toBe(false);
  });

  it('map keys to actions, case-insensitively', () => {
    expect(view3dAction('X')).toBe('xray');
    expect(view3dAction('g')).toBe('follow');
    expect(view3dAction('w')).toBeUndefined();
  });

  it('are ignored while typing or with modifiers', () => {
    const ev = (extra: Partial<KeyboardEvent>, target: unknown = null) => ({ key: 'x', target, ctrlKey: false, metaKey: false, altKey: false, repeat: false, ...extra }) as unknown as KeyboardEvent;
    expect(isTyping(ev({}))).toBe(false);
    expect(isTyping(ev({ ctrlKey: true }))).toBe(true);
    expect(isTyping(ev({ repeat: true }))).toBe(true);
    expect(isTyping(ev({}, { tagName: 'TEXTAREA' }))).toBe(true);
  });
});

describe('follow camera', () => {
  it('moves target and camera together, keeping the view angle, and settles', () => {
    const target = { x: 0, y: 64, z: 0 };
    const camera = { x: 20, y: 90, z: 30 };
    const goal = { x: 10, y: 64, z: -5 };
    for (let i = 0; i < 60; i++) followStep(target, camera, goal);
    expect(target.x).toBeCloseTo(10, 1);
    expect(target.z).toBeCloseTo(-5, 1);
    // Same offset from the target as before.
    expect(camera.x - target.x).toBeCloseTo(20, 6);
    expect(camera.y - target.y).toBeCloseTo(26, 6);
    expect(camera.z - target.z).toBeCloseTo(30, 6);
    expect(followStep({ ...goal }, { ...camera }, goal)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('re-centres the 3D area only when the turtle leaves its middle', () => {
    const c = { x: 0, y: 64, z: 0 };
    expect(needsRecentre(c, { x: 60, y: 64, z: 0 }, 128)).toBe(false);
    expect(needsRecentre(c, { x: 65, y: 64, z: 0 }, 128)).toBe(true);
    expect(needsRecentre(c, { x: 0, y: 50, z: 0 }, 128)).toBe(true);
  });
});
