import { describe, expect, it } from 'vitest';
import { isOreBlock, oreMatches } from '@ccfleet/protocol';

describe('ore matching (modded ids)', () => {
  it('recognises ores by the word "ore" in the id, whatever the mod', () => {
    for (const id of [
      'minecraft:coal_ore',
      'emendatusenigmatica:coal_ore',
      'emendatusenigmatica:uranium_ore',
      'immersiveengineering:ore_copper',
      'x:deepslate_coal_ore',
      'projectred-exploration:electrotine_ore',
      'minecraft:ancient_debris',
    ])
      expect(isOreBlock(id), id).toBe(true);
    for (const id of ['minecraft:stone', 'x:core_block', 'minecraft:stone_bricks', 'chisel:basalt/raw', 'x:boreal_log']) expect(isOreBlock(id), id).toBe(false);
  });

  it('"Any ore" matches every ore, including ore_ prefixed ones', () => {
    for (const f of ['_ore', 'any', 'Any ore', 'ore'])
      for (const id of ['emendatusenigmatica:coal_ore', 'immersiveengineering:ore_copper', 'minecraft:ancient_debris']) expect(oreMatches(f, id), `${f} ${id}`).toBe(true);
    expect(oreMatches('_ore', 'minecraft:stone')).toBe(false);
  });

  it('a material matches that ore from any mod, typed any way', () => {
    for (const f of ['coal_ore', 'coal', 'Coal Ore', ' COAL '])
      for (const id of ['minecraft:coal_ore', 'emendatusenigmatica:coal_ore', 'x:deepslate_coal_ore', 'x:ore_coal']) expect(oreMatches(f, id), `${f} ${id}`).toBe(true);
    expect(oreMatches('coal_ore', 'x:charcoal_ore')).toBe(false);
    expect(oreMatches('coal_ore', 'emendatusenigmatica:iron_ore')).toBe(false);
    expect(oreMatches('ancient_debris', 'minecraft:ancient_debris')).toBe(true);
  });

  it('full ids match exactly; plain words match non-ore blocks only by exact name', () => {
    expect(oreMatches('thermal:tin_ore', 'thermal:tin_ore')).toBe(true);
    expect(oreMatches('thermal:tin_ore', 'mekanism:tin_ore')).toBe(false);
    expect(oreMatches('obsidian', 'minecraft:obsidian')).toBe(true);
    expect(oreMatches('stone', 'minecraft:stone_bricks')).toBe(false);
  });
});
