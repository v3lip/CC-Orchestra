import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_BYTES, classifyReason, reasonHint, parseOpArgs, parseTurtleMessage, stepFor, turned } from '../src/index';

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
