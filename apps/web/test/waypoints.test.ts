import { describe, expect, it } from 'vitest';
import { journeyMapWaypoint, xaeroWaypoint } from '../src/lib/waypoints';

describe('minimap waypoints as chat text', () => {
  const p = { x: -131, y: 51, z: -177 };
  it('JourneyMap', () => {
    expect(journeyMapWaypoint('Home', p, 'minecraft:overworld')).toBe('[name:"Home", x:-131, y:51, z:-177, dim:minecraft:overworld]');
  });
  it("Xaero's Minimap, per dimension", () => {
    expect(xaeroWaypoint('Home depot', p, 'minecraft:overworld')).toBe('xaero-waypoint:Home depot:HD:-131:51:-177:11:false:0:Internal-overworld-waypoints');
    expect(xaeroWaypoint('Vein', p, 'minecraft:the_nether')).toContain(':Internal-the-nether-waypoints');
    expect(xaeroWaypoint('Vein', p, 'twilightforest:twilight_forest')).toContain(':Internal-dim%twilightforest$twilight_forest-waypoints');
  });
  it("names can't break the format", () => {
    expect(journeyMapWaypoint('a:b "c" [d]', p, 'minecraft:overworld')).toBe('[name:"a b c d", x:-131, y:51, z:-177, dim:minecraft:overworld]');
    expect(xaeroWaypoint(':::', p, 'minecraft:overworld').split(':')[1]).toBe('Waypoint');
  });
});
