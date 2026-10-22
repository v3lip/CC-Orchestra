/**
 * A small deterministic voxel world for the simulator. It is not Minecraft terrain;
 * it only needs the features that matter to turtles: solid blocks, ores, caves,
 * fluids, falling gravel, bedrock, chests and other turtles.
 */
import type { Heading, Vec3 } from '@ccfleet/protocol';

export interface Block {
  name: string;
  state?: Record<string, string | number | boolean>;
}

export interface SimItem {
  name: string;
  count: number;
}

/** The physical turtle: survives agent reboots, unlike the agent's memory. */
export interface TurtleBody {
  pos: Vec3;
  heading: Heading;
  fuel: number | 'unlimited';
  fuelLimit: number | 'unlimited';
  slots: (SimItem | null)[];
  selected: number;
}

const FALLING = new Set(['minecraft:gravel', 'minecraft:sand']);
const FLUIDS = new Set(['minecraft:water', 'minecraft:lava']);
export const MIN_Y = 0;
export const MAX_Y = 255;

const DROPS: Record<string, { name: string; count: number }> = {
  'minecraft:stone': { name: 'minecraft:cobblestone', count: 1 },
  'minecraft:grass_block': { name: 'minecraft:dirt', count: 1 },
  'minecraft:coal_ore': { name: 'minecraft:coal', count: 1 },
  'minecraft:diamond_ore': { name: 'minecraft:diamond', count: 1 },
  'minecraft:redstone_ore': { name: 'minecraft:redstone', count: 4 },
  'minecraft:lapis_ore': { name: 'minecraft:lapis_lazuli', count: 5 },
  'minecraft:wall_torch': { name: 'minecraft:torch', count: 1 },
};

const FUEL_VALUES: Record<string, number> = {
  'minecraft:coal': 80,
  'minecraft:charcoal': 80,
  'minecraft:coal_block': 800,
  'minecraft:lava_bucket': 1000,
};

function hash3(seed: number, x: number, y: number, z: number): number {
  let h = seed ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth2(seed: number, x: number, z: number, scale: number): number {
  const fx = x / scale;
  const fz = z / scale;
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const tx = fx - x0;
  const tz = fz - z0;
  const s = (t: number) => t * t * (3 - 2 * t);
  const a = hash3(seed, x0, 0, z0);
  const b = hash3(seed, x0 + 1, 0, z0);
  const c = hash3(seed, x0, 0, z0 + 1);
  const d = hash3(seed, x0 + 1, 0, z0 + 1);
  const u = s(tx);
  return (a * (1 - u) + b * u) * (1 - s(tz)) + (c * (1 - u) + d * u) * s(tz);
}

function smooth3(seed: number, x: number, y: number, z: number, scale: number): number {
  const f = [x / scale, y / scale, z / scale];
  const i = f.map(Math.floor);
  const t = f.map((v, k) => {
    const r = v - i[k];
    return r * r * (3 - 2 * r);
  });
  let acc = 0;
  for (let dx = 0; dx < 2; dx++)
    for (let dy = 0; dy < 2; dy++)
      for (let dz = 0; dz < 2; dz++) {
        const w = (dx ? t[0] : 1 - t[0]) * (dy ? t[1] : 1 - t[1]) * (dz ? t[2] : 1 - t[2]);
        acc += w * hash3(seed, i[0] + dx, i[1] + dy, i[2] + dz);
      }
  return acc;
}

export const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

export class SimWorld {
  /** Blocks changed from generated terrain. null = air. */
  overrides = new Map<string, Block | null>();
  /** Positions of turtle bodies (keyed by position). */
  occupants = new Map<string, TurtleBody>();
  /** Chest contents by position. */
  inventories = new Map<string, (SimItem | null)[]>();
  /** Items lost because a turtle had no free slot. */
  spilled = 0;
  /** Chunks ("cx,cz") a claim mod protects: turtles can't move into them (CC says "Movement failed"). */
  claimedChunks = new Set<string>();

  constructor(public seed = 1337) {}

  surfaceY(x: number, z: number): number {
    return 64 + Math.round(smooth2(this.seed, x, z, 24) * 8 - 4);
  }

  private generate(x: number, y: number, z: number): Block | null {
    if (y < MIN_Y || y > MAX_Y) return null;
    if (y === 0) return { name: 'minecraft:bedrock' };
    if (y <= 4 && hash3(this.seed + 7, x, y, z) < 0.6 - y * 0.12) return { name: 'minecraft:bedrock' };
    const h = this.surfaceY(x, z);
    if (y > h) return y <= 62 ? { name: 'minecraft:water', state: { level: 0 } } : null;
    if (y === h) return { name: h <= 62 ? 'minecraft:sand' : 'minecraft:grass_block' };
    if (y > h - 4) return { name: 'minecraft:dirt' };
    if (y < h - 6 && smooth3(this.seed + 3, x, y, z, 9) > 0.72) {
      return y <= 10 ? { name: 'minecraft:lava', state: { level: 0 } } : null;
    }
    const r = hash3(this.seed + 11, x, y, z);
    if (r < 0.01) return { name: 'minecraft:coal_ore' };
    if (r < 0.016 && y < 64) return { name: 'minecraft:iron_ore' };
    if (r < 0.018 && y < 32) return { name: 'minecraft:gold_ore' };
    if (r < 0.024 && y < 16) return { name: 'minecraft:redstone_ore' };
    if (r < 0.0255 && y < 16) return { name: 'minecraft:diamond_ore' };
    if (r < 0.035) return { name: 'minecraft:gravel' };
    return { name: 'minecraft:stone' };
  }

  get(x: number, y: number, z: number): Block | null {
    const k = key(x, y, z);
    if (this.overrides.has(k)) return this.overrides.get(k)!;
    return this.generate(x, y, z);
  }

  set(x: number, y: number, z: number, b: Block | null): void {
    this.overrides.set(key(x, y, z), b);
  }

  isFluid(b: Block | null): boolean {
    return !!b && FLUIDS.has(b.name);
  }

  /** Can a turtle enter this cell? Air and fluids are passable; other turtles are not. */
  passable(p: Vec3): boolean {
    if (p.y < MIN_Y || p.y > MAX_Y) return false;
    if (this.occupants.has(key(p.x, p.y, p.z))) return false;
    const b = this.get(p.x, p.y, p.z);
    return b === null || this.isFluid(b);
  }

  placeChest(p: Vec3, size = 27): void {
    this.set(p.x, p.y, p.z, { name: 'minecraft:chest', state: { facing: 'north' } });
    this.inventories.set(key(p.x, p.y, p.z), Array(size).fill(null));
  }

  /** Remove a block, returning what it drops. Falling blocks above settle down. */
  breakBlock(p: Vec3): SimItem | null {
    const b = this.get(p.x, p.y, p.z);
    if (!b) return null;
    this.set(p.x, p.y, p.z, null);
    const inv = this.inventories.get(key(p.x, p.y, p.z));
    if (inv) {
      this.inventories.delete(key(p.x, p.y, p.z));
      this.spilled += inv.reduce((n, s) => n + (s?.count ?? 0), 0);
    }
    this.settle(p.x, p.y, p.z);
    const d = DROPS[b.name];
    return d ? { ...d } : { name: b.name, count: 1 };
  }

  /** Let gravel/sand above (x,y,z) fall into empty space. */
  settle(x: number, y: number, z: number): void {
    for (let cy = y; cy < MAX_Y; cy++) {
      const above = this.get(x, cy + 1, z);
      const here = this.get(x, cy, z);
      if (!above || !FALLING.has(above.name)) return;
      if (here !== null && !this.isFluid(here)) return;
      if (this.occupants.has(key(x, cy, z))) return;
      this.set(x, cy, z, above);
      this.set(x, cy + 1, z, null);
    }
  }

  addOccupant(body: TurtleBody): void {
    this.occupants.set(key(body.pos.x, body.pos.y, body.pos.z), body);
  }

  removeOccupant(body: TurtleBody): void {
    const k = key(body.pos.x, body.pos.y, body.pos.z);
    if (this.occupants.get(k) === body) this.occupants.delete(k);
  }

  moveOccupant(body: TurtleBody, to: Vec3): void {
    this.removeOccupant(body);
    body.pos = { ...to };
    this.addOccupant(body);
  }

  static fuelValue(name: string): number {
    return FUEL_VALUES[name] ?? 0;
  }

  static isUnbreakable(b: Block): boolean {
    return b.name === 'minecraft:bedrock';
  }

  toJSON() {
    return {
      seed: this.seed,
      overrides: [...this.overrides.entries()],
      inventories: [...this.inventories.entries()],
      spilled: this.spilled,
    };
  }

  static fromJSON(j: ReturnType<SimWorld['toJSON']>): SimWorld {
    const w = new SimWorld(j.seed);
    w.overrides = new Map(j.overrides);
    w.inventories = new Map(j.inventories);
    w.spilled = j.spilled ?? 0;
    return w;
  }
}
