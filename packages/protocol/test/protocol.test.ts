import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_BYTES, branchIds, classifyReason, reasonHint, parseOpArgs, parseTurtleMessage, segmentsFor, splitStrategy, stepFor, turned } from '../src/index';

const base = { v: 1, id: 'm1', ts: 0 };

describe('protocol', () => {
  it('rejects other protocol versions, oversized frames and unknown types', () => {
    expect(parseTurtleMessage(JSON.stringify({ ...base, v: 2, type: 'hb', seq: 1 }))).toMatchObject({ ok: false });
    expect(parseTurtleMessage('x'.repeat(MAX_MESSAGE_BYTES + 1))).toMatchObject({ ok: false, error: 'message too large' });
    expect(parseTurtleMessage(JSON.stringify({ ...base, type: 'eval', code: 'os.shutdown()' }))).toMatchObject({ ok: false });
    expect(parseTurtleMessage('{not json')).toMatchObject({ ok: false });
  });

  it("accepts Lua's {} encoding of empty arrays", () => {
    const r = parseTurtleMessage(JSON.stringify({ ...base, type: 'observe', blocks: {} }));
    expect(r.ok && r.msg.type === 'observe' && r.msg.blocks).toEqual([]);
  });

  it('only whitelisted operations with valid arguments', () => {
    expect(parseOpArgs('forward', {})).toMatchObject({ ok: true });
    expect(parseOpArgs('forward', { distance: 3 })).toMatchObject({ ok: false });
    expect(parseOpArgs('select', { slot: 17 })).toMatchObject({ ok: false });
    expect(parseOpArgs('runLua', { code: 'x' })).toMatchObject({ ok: false });
  });

  it('uses Minecraft axes: north is -Z, east is +X', () => {
    expect(stepFor('forward', 0)).toEqual({ x: 0, y: 0, z: -1 });
    expect(stepFor('forward', 1)).toEqual({ x: 1, y: 0, z: 0 });
    expect(stepFor('back', 1)).toEqual({ x: -1, y: 0, z: 0 });
    expect(turned(0, 'turnLeft')).toBe(3);
    expect(turned(3, 'turnRight')).toBe(0);
  });

  it('classifies CC: Tweaked failure reasons', () => {
    expect(classifyReason('Movement obstructed')).toBe('obstructed');
    expect(classifyReason('Out of fuel')).toBe('out_of_fuel');
    expect(classifyReason('Unbreakable block detected')).toBe('unbreakable');
    expect(classifyReason('Something new')).toBe('failed');
  });

  it('explains "Movement failed" (a claim mod), and only that', () => {
    expect(reasonHint('Movement failed')).toContain('FTB Chunks');
    expect(reasonHint('Movement obstructed')).toBeUndefined();
    expect(reasonHint(undefined)).toBeUndefined();
  });
});

describe('sharing a job between turtles (splitStrategy)', () => {
  const at = (x: number, z: number) => ({ x, y: 64, z });
  it('a branch mine: the turtle nearest the start digs the corridor, branches are dealt out', () => {
    const whole = { strategy: 'branch' as const, params: { origin: at(0, 0), heading: 1 as const, width: 1, height: 2, length: 13, spacing: 4, branchLength: 3, sides: 'both' as const } };
    expect(branchIds(whole.params)).toEqual([0, 1, 2, 3, 4, 5]);
    const r = splitStrategy(whole, [{ id: 'far', pos: at(-3, 5) }, { id: 'near', pos: at(-1, 0) }, { id: 'extra', pos: at(-9, 9) }]);
    expect(r.parts.map((p) => [p.turtleId, (p.strategy.params as { corridor?: boolean }).corridor, (p.strategy.params as { branchIds?: number[] }).branchIds])).toEqual([
      ['near', true, [0, 3]],
      ['far', false, [1, 4]],
      ['extra', false, [2, 5]],
    ]);
    // Together they cover exactly the whole mine, nothing twice.
    const cells = (s: Parameters<typeof segmentsFor>[0]) => segmentsFor(s).map((t) => JSON.stringify(t));
    const shared = r.parts.flatMap((p) => cells(p.strategy));
    expect(new Set(shared).size).toBe(shared.length);
    expect([...shared].sort()).toEqual(cells(whole).sort());
    // Two turtles: one takes the left branches, the other the right ones.
    const two = splitStrategy(whole, [{ id: 'a', pos: at(-1, 0) }, { id: 'b', pos: at(-1, 2) }]);
    expect(two.parts.map((p) => (p.strategy.params as { branchIds?: number[] }).branchIds)).toEqual([[0, 2, 4], [1, 3, 5]]);
  });

  it('a grid mine: bands of whole tunnels, left to right', () => {
    const whole = { strategy: 'grid' as const, params: { origin: at(0, 0), heading: 0 as const, width: 7, length: 10, height: 2, spacing: 3 } };
    const r = splitStrategy(whole, [{ id: 'right', pos: at(6, 1) }, { id: 'left', pos: at(0, 1) }, { id: 'more', pos: at(9, 1) }, { id: 'most', pos: at(12, 1) }]);
    expect(r.parts.map((p) => [p.turtleId, p.strategy.params.origin.x, p.strategy.params.width])).toEqual([
      ['left', 0, 1],
      ['right', 3, 1],
      ['more', 6, 1],
    ]);
    expect(r.skipped).toEqual(['most']);
  });
});
