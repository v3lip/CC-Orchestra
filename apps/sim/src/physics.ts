/**
 * Physical turtle actions against a SimWorld, shared by the TypeScript simulated agent
 * and the CC host that runs the real Lua agent. Results mirror CC: Tweaked's
 * return values (success flag plus CC's reason strings).
 */
import { HEADING_VECTORS, type Heading, type Vec3, addVec, isTorchItem, stepFor, turned } from '@ccfleet/protocol';
import { SimWorld, type Block, type SimItem, type TurtleBody } from './world';

export type Dir = 'front' | 'up' | 'down';
export type MoveOp = 'forward' | 'back' | 'up' | 'down';

export function adjacentCell(body: TurtleBody, dir: Dir): Vec3 {
  const p = body.pos;
  if (dir === 'up') return { ...p, y: p.y + 1 };
  if (dir === 'down') return { ...p, y: p.y - 1 };
  return addVec(p, stepFor('forward', body.heading)!);
}

export function move(world: SimWorld, body: TurtleBody, op: MoveOp): { ok: true } | { ok: false; reason: string } {
  if (body.fuel !== 'unlimited' && body.fuel <= 0) return { ok: false, reason: 'Out of fuel' };
  const to = addVec(body.pos, stepFor(op, body.heading)!);
  if (to.y > 255) return { ok: false, reason: 'Too high to move' };
  if (to.y < 0) return { ok: false, reason: 'Too low to move' };
  if (!world.passable(to)) return { ok: false, reason: 'Movement obstructed' };
  // CC's checks passed, but the claim mod refuses the turtle block at the new cell.
  if (world.claimedChunks.has(`${Math.floor(to.x / 16)},${Math.floor(to.z / 16)}`)) return { ok: false, reason: 'Movement failed' };
  world.moveOccupant(body, to);
  if (body.fuel !== 'unlimited') body.fuel -= 1;
  return { ok: true };
}

export function turn(body: TurtleBody, op: 'turnLeft' | 'turnRight'): void {
  body.heading = turned(body.heading, op) as Heading;
}

/** What turtle.inspect* would see. Another turtle reads as a turtle block. */
export function inspect(world: SimWorld, body: TurtleBody, dir: Dir): Block | null {
  const p = adjacentCell(body, dir);
  if (world.occupants.has(`${p.x},${p.y},${p.z}`)) return { name: 'computercraft:turtle_normal', state: { facing: 'north' } };
  return world.get(p.x, p.y, p.z);
}

export function dig(world: SimWorld, body: TurtleBody, dir: Dir): { ok: true; block: string } | { ok: false; reason: string } {
  const p = adjacentCell(body, dir);
  if (world.occupants.has(`${p.x},${p.y},${p.z}`)) return { ok: false, reason: 'Nothing to dig here' };
  const block = world.get(p.x, p.y, p.z);
  if (!block || world.isFluid(block)) return { ok: false, reason: 'Nothing to dig here' };
  if (SimWorld.isUnbreakable(block)) return { ok: false, reason: 'Unbreakable block detected' };
  const drop = world.breakBlock(p);
  if (drop) addItem(world, body, drop);
  return { ok: true, block: block.name };
}

/**
 * turtle.place[Up|Down]() from the selected slot, following CC's order: click the block
 * beyond the target cell, then (placing forward) the block under it. A torch clicked on a
 * side face becomes a wall torch; on a top face, a standing torch. Placing up, it looks
 * for a wall in the direction the turtle faces first, then the other sides.
 */
export function place(world: SimWorld, body: TurtleBody, dir: Dir): { ok: true; block: string } | { ok: false; reason: string } {
  const slot = body.slots[body.selected - 1];
  if (!slot) return { ok: false, reason: 'No items to place' };
  const p = adjacentCell(body, dir);
  if (!world.passable(p) || world.isFluid(world.get(p.x, p.y, p.z))) return { ok: false, reason: 'Cannot place block here' };
  const solid = (c: Vec3) => {
    const b = world.get(c.x, c.y, c.z);
    return !!b && !world.isFluid(b) && !b.name.endsWith('torch') && !world.occupants.has(`${c.x},${c.y},${c.z}`);
  };
  const below = { ...p, y: p.y - 1 };
  let block: Block | undefined;
  if (isTorchItem(slot.name)) {
    // Side blocks, the way the turtle faces first; a wall torch faces away from its block.
    const sides = [0, 1, 2, 3].map((i) => ((body.heading + i) % 4) as Heading);
    const wall = sides.find((h) => solid(addVec(p, { ...HEADING_VECTORS[h], y: 0 })));
    const wallTorch = wall === undefined ? undefined : { name: 'minecraft:wall_torch', state: { facing: FACINGS[(wall + 2) % 4] } };
    if (dir === 'down') block = solid(below) ? { name: 'minecraft:torch' } : wallTorch;
    else if (dir === 'front') {
      const h = body.heading as Heading;
      block = solid(addVec(p, stepFor('forward', h)!)) ? { name: 'minecraft:wall_torch', state: { facing: FACINGS[(h + 2) % 4] } } : solid(below) ? { name: 'minecraft:torch' } : undefined;
    } else block = wallTorch;
  } else {
    block = { name: slot.name };
  }
  if (!block) return { ok: false, reason: 'Cannot place block here' };
  world.set(p.x, p.y, p.z, block);
  slot.count -= 1;
  if (slot.count === 0) body.slots[body.selected - 1] = null;
  return { ok: true, block: block.name };
}

const FACINGS = ['north', 'east', 'south', 'west'] as const;

/** Put an item in the inventory like a turtle does: selected slot first, then wrap around. */
export function addItem(world: SimWorld, body: TurtleBody, item: SimItem): void {
  const slots = body.slots;
  let left = item.count;
  const order = Array.from({ length: 16 }, (_, i) => (body.selected - 1 + i) % 16);
  for (const i of order) {
    const s = slots[i];
    if (s && s.name === item.name && s.count < 64) {
      const n = Math.min(64 - s.count, left);
      s.count += n;
      left -= n;
      if (!left) return;
    }
  }
  for (const i of order) {
    if (!slots[i]) {
      slots[i] = { name: item.name, count: left };
      return;
    }
  }
  world.spilled += left; // no room: the item drops into the world
}

/** turtle.refuel([count]) from the selected slot. */
export function refuel(body: TurtleBody, count?: number): { ok: true; used: number } | { ok: false; reason: string } {
  const slot = body.slots[body.selected - 1];
  const value = slot ? SimWorld.fuelValue(slot.name) : 0;
  if (!slot || value === 0) return { ok: false, reason: 'Items not combustible' };
  if (body.fuel === 'unlimited' || body.fuelLimit === 'unlimited') return { ok: true, used: 0 };
  if (count === 0) return { ok: true, used: 0 };
  const want = count ?? slot.count;
  let used = 0;
  while (used < want && used < slot.count && body.fuel + value <= body.fuelLimit) {
    body.fuel += value;
    used++;
  }
  slot.count -= used;
  if (slot.count === 0) body.slots[body.selected - 1] = null;
  if (used === 0) return { ok: false, reason: 'Fuel limit reached' };
  return { ok: true, used };
}

/** The inventory next to the turtle, if any. Another turtle also counts as an inventory. */
export function inventoryAt(world: SimWorld, body: TurtleBody, dir: Dir): (SimItem | null)[] | undefined {
  const p = adjacentCell(body, dir);
  const k = `${p.x},${p.y},${p.z}`;
  const occupant = world.occupants.get(k);
  if (occupant) return occupant.slots;
  return world.inventories.get(k);
}

/** Insert into an inventory: stack onto matching stacks, then empty slots. Returns how many fit. */
export function insert(inv: (SimItem | null)[], name: string, count: number): number {
  let left = count;
  for (const s of inv) {
    if (s && s.name === name && s.count < 64) {
      const n = Math.min(64 - s.count, left);
      s.count += n;
      left -= n;
      if (!left) return count;
    }
  }
  for (let i = 0; i < inv.length && left > 0; i++) {
    if (!inv[i]) {
      const n = Math.min(64, left);
      inv[i] = { name, count: n };
      left -= n;
    }
  }
  return count - left;
}

/**
 * turtle.drop[Up|Down]([count]) from the selected slot. Like CC: with no inventory there,
 * the items are thrown into the world (counted in world.spilled).
 */
export function drop(world: SimWorld, body: TurtleBody, dir: Dir, count?: number): { ok: true } | { ok: false; reason: string } {
  const slot = body.slots[body.selected - 1];
  if (!slot) return { ok: false, reason: 'No items to drop' };
  const n = Math.min(count ?? slot.count, slot.count);
  const inv = inventoryAt(world, body, dir);
  let moved: number;
  if (!inv) {
    world.spilled += n;
    moved = n;
  } else {
    moved = insert(inv, slot.name, n);
    if (moved === 0) return { ok: false, reason: 'No space for items' };
  }
  slot.count -= moved;
  if (slot.count === 0) body.slots[body.selected - 1] = null;
  return { ok: true };
}

/** turtle.suck[Up|Down]([count]) from an adjacent inventory into the selected slot onwards. */
export function suck(world: SimWorld, body: TurtleBody, dir: Dir, count?: number): { ok: true } | { ok: false; reason: string } {
  const inv = inventoryAt(world, body, dir);
  if (!inv) return { ok: false, reason: 'No items to take' };
  const idx = inv.findIndex((s) => s && s.count > 0);
  if (idx < 0) return { ok: false, reason: 'No items to take' };
  const src = inv[idx]!;
  const want = Math.min(count ?? 64, src.count);
  // Items go to the selected slot first, then onwards (wrapping), like CC.
  const order = Array.from({ length: 16 }, (_, i) => (body.selected - 1 + i) % 16);
  let left = want;
  for (const i of order) {
    const s = body.slots[i];
    if (s && s.name === src.name && s.count < 64) {
      const n = Math.min(64 - s.count, left);
      s.count += n;
      left -= n;
    } else if (!s) {
      const n = Math.min(64, left);
      body.slots[i] = { name: src.name, count: n };
      left -= n;
    }
    if (!left) break;
  }
  const taken = want - left;
  if (taken === 0) return { ok: false, reason: 'No space for items' };
  src.count -= taken;
  if (src.count === 0) inv[idx] = null;
  return { ok: true };
}
