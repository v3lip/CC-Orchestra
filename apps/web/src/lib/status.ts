import type { DisplayStatus, TurtleView } from '@ccfleet/protocol';
import { CHUNKY_PERIPHERAL, GEO_SCANNER_PERIPHERAL, hasChunkLoader, hasGeoScanner, isOreBlock } from '@ccfleet/protocol';

export const STATUS_COLOR: Record<DisplayStatus, string> = {
  idle: '#38bdf8',
  working: '#4ade80',
  paused: '#fbbf24',
  unloading: '#a78bfa',
  returning: '#60a5fa',
  blocked: '#fb923c',
  error: '#f87171',
  stale: '#a3a35c',
  offline: '#4b5563',
};

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  idle: 'Idle',
  working: 'Working',
  paused: 'Paused',
  unloading: 'Unloading',
  returning: 'Returning',
  blocked: 'Blocked',
  error: 'Error',
  stale: 'Stale',
  offline: 'Offline',
};

export function statusOf(t: TurtleView): DisplayStatus {
  if (t.connection === 'online' && t.state?.hold) return 'paused';
  return t.status;
}

export const HEADING_SHORT = ['N', 'E', 'S', 'W'];

export function fuelFraction(t: TurtleView): number | undefined {
  const f = t.state?.fuel;
  const l = t.state?.fuelLimit;
  if (typeof f !== 'number' || typeof l !== 'number' || l <= 0) return undefined;
  return Math.min(1, f / l);
}

export function shortItem(name: string): string {
  return name.replace(/^minecraft:/, '').replace(/_/g, ' ');
}

export function ago(ts?: number): string {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Colours for observed blocks on the map. Unknown names get a stable hashed colour. */
const BLOCK_COLORS: Record<string, string> = {
  'minecraft:stone': '#6b7280',
  'minecraft:cobblestone': '#5b6270',
  'minecraft:deepslate': '#4b4f5c',
  'minecraft:andesite': '#7c8088',
  'minecraft:diorite': '#a8a8ad',
  'minecraft:granite': '#9a6b5a',
  'minecraft:dirt': '#7a5534',
  'minecraft:grass_block': '#4d7c34',
  'minecraft:sand': '#d6c58a',
  'minecraft:gravel': '#857f7a',
  'minecraft:bedrock': '#1f2329',
  'minecraft:water': '#2563eb',
  'minecraft:lava': '#ea580c',
  'minecraft:coal_ore': '#2b2b2b',
  'minecraft:iron_ore': '#c8a07e',
  'minecraft:gold_ore': '#f1c232',
  'minecraft:redstone_ore': '#c0262d',
  'minecraft:diamond_ore': '#4fd1d9',
  'minecraft:lapis_ore': '#2a52be',
  'minecraft:emerald_ore': '#27ae60',
  'minecraft:chest': '#a16207',
  'minecraft:torch': '#fbbf24',
  'minecraft:wall_torch': '#fbbf24',
  'computercraft:turtle_normal': '#94a3b8',
  'computercraft:turtle_advanced': '#eab308',
};

export function blockColor(name: string): string {
  const c = BLOCK_COLORS[name];
  if (c) return c;
  // Modded ores: the colour of the vanilla ore of the same material, if there is one.
  if (isOreBlock(name)) {
    for (const w of (name.split(':').pop() ?? '').split(/[/_]/)) {
      const v = BLOCK_COLORS[`minecraft:${w}_ore`];
      if (v) return v;
    }
  }
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360} 35% 42%)`;
}

/** Has an Advanced Peripherals Geo Scanner equipped. */
export function hasScanner(t: TurtleView | undefined): boolean {
  return hasGeoScanner(t?.state?.upgrades);
}

/** A readable name for an upgrade's peripheral type. */
export function upgradeLabel(type: string | undefined): string {
  if (!type) return 'tool / none';
  if (type === CHUNKY_PERIPHERAL) return 'Chunk Controller';
  if (type === GEO_SCANNER_PERIPHERAL) return 'Geo Scanner';
  return type;
}

/** Has an Advanced Peripherals Chunk Controller equipped (keeps its own chunk loaded). */
export function isChunky(t: TurtleView): boolean {
  return hasChunkLoader(t.state?.upgrades);
}

export const chunkOf = (x: number, z: number) => ({ cx: Math.floor(x / 16), cz: Math.floor(z / 16) });
