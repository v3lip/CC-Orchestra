/**
 * Physical turtle actions against a SimWorld, shared by the TypeScript simulated agent
 * and the CC host that runs the real Lua agent. Results mirror CC: Tweaked's
 * return values (success flag plus CC's reason strings).
 */
import { type Heading, type Vec3, addVec, stepFor, turned } from '@ccfleet/protocol';
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
