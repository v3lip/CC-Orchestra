/**
 * Waypoints for in-game minimaps, as chat text: paste it into Minecraft's chat and the
 * mod turns it into a clickable "add waypoint" link. (Writing their waypoint files
 * directly depends on each mod version's format and folder layout; chat works the same
 * in single player and on servers.)
 */
import type { Vec3 } from '@ccfleet/protocol';

/** Characters the formats use as separators. */
const clean = (name: string) => name.replace(/[:"\[\],]/g, ' ').replace(/\s+/g, ' ').trim() || 'Waypoint';

/** JourneyMap: `[name:"Home", x:0, y:64, z:0, dim:minecraft:overworld]`. */
export function journeyMapWaypoint(name: string, p: Vec3, dimension: string): string {
  return `[name:"${clean(name)}", x:${p.x}, y:${p.y}, z:${p.z}, dim:${dimension}]`;
}

/** Xaero's Minimap "share waypoint" text: `xaero-waypoint:name:initials:x:y:z:colour:false:0:container`. */
export function xaeroWaypoint(name: string, p: Vec3, dimension: string, colour = 11): string {
  const n = clean(name);
  const initials = n
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return `xaero-waypoint:${n}:${initials}:${p.x}:${p.y}:${p.z}:${colour}:false:0:Internal-${xaeroDimension(dimension)}-waypoints`;
}

function xaeroDimension(dimension: string): string {
  if (dimension === 'minecraft:overworld') return 'overworld';
  if (dimension === 'minecraft:the_nether') return 'the-nether';
  if (dimension === 'minecraft:the_end') return 'the-end';
  return `dim%${dimension.replace(':', '$')}`;
}
