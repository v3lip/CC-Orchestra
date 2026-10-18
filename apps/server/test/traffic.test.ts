/**
 * Traffic control between turtles (Milestone 4) — simulator verification.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { BlockObservation, JobView } from '@ccfleet/protocol';
import type { SimTurtle, SimWorld, TurtleBody } from '@ccfleet/sim';
import { Traffic } from '../src/jobs/traffic';
import type { Fleet } from '../src/fleet';
import { fill, openWorld, spawnTurtle, startServer, waitFor } from './helpers';

type Server = Awaited<ReturnType<typeof startServer>>;
let server: Server | undefined;
const sims: SimTurtle[] = [];

afterEach(async () => {
  for (const t of sims.splice(0)) t.stop();
  await server?.close();
  server = undefined;
});

describe('Traffic (unit)', () => {
  const fleet = { listTurtles: () => [], getTurtle: () => undefined } as unknown as Fleet;

  it('a reserved cell is taken for everyone else', () => {
    const t = new Traffic(fleet);
    t.join('a', 'A', 'w', 'd', 1);
    t.join('b', 'B', 'w', 'd', 2);
    expect(t.tryReserve('a', { x: 1, y: 0, z: 0 })).toBeUndefined();
    expect(t.tryReserve('b', { x: 1, y: 0, z: 0 })).toMatchObject({ id: 'a', agent: true });
    t.release('a');
    expect(t.tryReserve('b', { x: 1, y: 0, z: 0 })).toBeUndefined();
  });

  it('breaks a wait-for cycle by making the least important turtle yield', () => {
    const t = new Traffic(fleet);
    t.join('a', 'A', 'w', 'd', 1);
    t.join('b', 'B', 'w', 'd', 2);
    t.setWaiting('a', 'b');
    expect(t.resolve('a')).toBe('wait'); // no cycle yet
    t.setWaiting('b', 'a');
    expect(t.resolve('a')).toBe('wait');
    expect(t.resolve('b')).toBe('yield');
    t.markNoYield('b'); // B found nowhere to go: A must
    expect(t.resolve('a')).toBe('yield');
    t.markNoYield('a');
    expect(t.resolve('a')).toBe('stuck');
  });
});

/** A 1-wide corridor along +X at y=100, z=0, from x=0 to x=12, inside stone. */
function corridor(world: SimWorld, alcove: boolean): BlockObservation[] {
  fill(world, { x: -2, y: 98, z: -2 }, { x: 14, y: 102, z: 2 }, 'minecraft:stone');
  fill(world, { x: 0, y: 100, z: 0 }, { x: 12, y: 100, z: 0 }, null);
  if (alcove) world.set(6, 100, 1, null);
  // What the turtles "know": the whole block (as if mapped earlier).
  const obs: BlockObservation[] = [];
  for (let x = -2; x <= 14; x++)
    for (let y = 98; y <= 102; y++)
      for (let z = -2; z <= 2; z++) {
        const b = world.get(x, y, z);
        obs.push(b ? { x, y, z, name: b.name } : { x, y, z });
      }
  return obs;
}

describe('head-on in a narrow corridor', () => {
  async function setup(alcove: boolean) {
    server = await startServer();
    const world = openWorld();
    server.fleet.importObservations('sim', 'minecraft:overworld', corridor(world, alcove), 'test');
    const a = await spawnTurtle(server, world, { x: 0, y: 100, z: 0, heading: 1 }, { opMs: 5, fuel: 500 });
    const b = await spawnTurtle(server, world, { x: 12, y: 100, z: 0, heading: 3 }, { opMs: 5, fuel: 500 });
    sims.push(a, b);
    return { server, a, b };
  }

  it('one turtle steps into the alcove and both get through; they never share a cell', async () => {
    const { server, a, b } = await setup(true);
    let clash = false;
    const watch = setInterval(() => {
      if (a.body.pos.x === b.body.pos.x && a.body.pos.y === b.body.pos.y && a.body.pos.z === b.body.pos.z) clash = true;
    }, 2);
    server.jobs.goto(a.turtleId!, { x: 12, y: 100, z: 0 });
    server.jobs.goto(b.turtleId!, { x: 0, y: 100, z: 0 });
    await waitFor(() => !server.jobs.taskRunning(a.turtleId!) && !server.jobs.taskRunning(b.turtleId!), 40000, 'both go-to tasks to end');
    clearInterval(watch);
    expect(clash).toBe(false);
    expect(a.body.pos).toEqual({ x: 12, y: 100, z: 0 });
    expect(b.body.pos).toEqual({ x: 0, y: 100, z: 0 });
    expect(server.fleet.recentEvents(50).some((e) => e.message.includes('steps aside'))).toBe(true);
  }, 60000);

  it('without anywhere to step aside it reports a deadlock instead of hanging', async () => {
    const { server, a, b } = await setup(false);
    server.jobs.goto(a.turtleId!, { x: 12, y: 100, z: 0 });
    server.jobs.goto(b.turtleId!, { x: 0, y: 100, z: 0 });
    await waitFor(() => server.fleet.recentEvents(50).some((e) => e.message.includes('block each other')), 40000, 'deadlock report');
    expect(a.body.pos).not.toEqual(b.body.pos);
  }, 60000);
});

// ---------------------------------------------------------------- campaigns, lanes, waiting spots

function slots(fillSlots: Record<number, { name: string; count: number }>): TurtleBody['slots'] {
  const out: TurtleBody['slots'] = Array(16).fill(null);
  for (const [k, v] of Object.entries(fillSlots)) out[Number(k) - 1] = { ...v };
  return out;
}

async function finishAll(s: Server, ids: string[], timeout = 60000): Promise<JobView[]> {
  return waitFor(() => {
    const js = ids.map((id) => s.jobs.getJob(id)!);
    return js.every((j) => j.status === 'completed' || j.status === 'paused' || j.status === 'cancelled') ? js : undefined;
  }, timeout, () => `jobs to stop: ${ids.map((id) => `${s.jobs.getJob(id)?.status}/${s.jobs.getJob(id)?.phase}`).join(', ')}`);
}

describe('campaigns', () => {
  async function site(opts: { spots?: boolean } = {}) {
    server = await startServer();
    const world = openWorld();
    fill(world, { x: 2, y: 97, z: -4 }, { x: 30, y: 106, z: 6 }, 'minecraft:stone');
    world.placeChest({ x: -1, y: 100, z: 0 }, 54);
    const depot = server.jobs.saveDepot({
      name: 'Home',
      world: 'sim',
      dimension: 'minecraft:overworld',
      dock: { x: 0, y: 100, z: 0 },
      dockHeading: 3,
      unloadDir: 'front',
      waiting: opts.spots ? [{ x: 0, y: 100, z: 3 }] : [],
    });
    return { server, world, depot };
  }

  it('splits one wide tunnel into lanes, one per turtle, assigned left to right', async () => {
    const { server, world, depot } = await site();
    const north = await spawnTurtle(server, world, { x: 1, y: 100, z: 0, heading: 1 }, { opMs: 4, fuel: 800 });
    const south = await spawnTurtle(server, world, { x: 1, y: 100, z: 3, heading: 1 }, { opMs: 4, fuel: 800 });
    sims.push(north, south);
    const r = server.jobs.createCampaign({
      name: 'Wide',
      depotId: depot.id,
      start: true,
      split: { strategy: 'tunnel', params: { origin: { x: 2, y: 100, z: 0 }, heading: 1, width: 4, height: 2, length: 6 }, turtleIds: [south.turtleId!, north.turtleId!] },
    });
    expect(r.jobs).toHaveLength(2);
    // Heading east, "right" is +Z: the turtle at z=0 gets columns 0-1, the one at z=3 gets 2-3.
    const lane = (id: string) => r.jobs.find((j) => j.turtleId === id)!;
    expect(lane(north.turtleId!).params).toMatchObject({ origin: { x: 2, y: 100, z: 0 }, width: 2 });
    expect(lane(south.turtleId!).params).toMatchObject({ origin: { x: 2, y: 100, z: 2 }, width: 2 });
    const done = await finishAll(server, r.jobs.map((j) => j.id));
    expect(done.map((j) => j.status)).toEqual(['completed', 'completed']);
    for (let d = 0; d < 6; d++) for (let z = 0; z < 4; z++) for (const y of [100, 101]) expect(world.get(2 + d, y, z)).toBeNull();
    expect(world.spilled).toBe(0);
  }, 90000);

  it('validates every job before creating any', async () => {
    const { server, world, depot } = await site();
    const a = await spawnTurtle(server, world, { x: 1, y: 100, z: 0, heading: 1 }, { opMs: 4 });
    const b = await spawnTurtle(server, world, { x: 1, y: 100, z: 3, heading: 1 }, { opMs: 4 });
    sims.push(a, b);
    const params = (z: number) => ({ origin: { x: 2, y: 100, z }, heading: 1 as const, width: 2, height: 2, length: 4 });
    expect(() =>
      server.jobs.createCampaign({ name: 'Bad', depotId: depot.id, jobs: [{ turtleId: a.turtleId!, strategy: 'tunnel', params: params(0) }, { turtleId: b.turtleId!, strategy: 'tunnel', params: params(1) }] }),
    ).toThrow(/same cells/);
    expect(server.jobs.listJobs()).toHaveLength(0);
  });

  it('turtles queue on a waiting spot for a busy dock; group pause and resume work', async () => {
    const { server, world, depot } = await site({ spots: true });
    const junk = slots(Object.fromEntries(Array.from({ length: 13 }, (_, i) => [i + 1, { name: `minecraft:junk_${i}`, count: 64 }])));
    const a = await spawnTurtle(server, world, { x: 1, y: 100, z: 0, heading: 1 }, { opMs: 4, fuel: 800, slots: junk.map((s) => s && { ...s }) });
    const b = await spawnTurtle(server, world, { x: 1, y: 100, z: 5, heading: 1 }, { opMs: 4, fuel: 800, slots: junk.map((s) => s && { ...s }) });
    sims.push(a, b);
    const r = server.jobs.createCampaign({
      name: 'Pair',
      depotId: depot.id,
      jobs: [
        { turtleId: a.turtleId!, strategy: 'tunnel', params: { origin: { x: 2, y: 100, z: 0 }, heading: 1, width: 1, height: 2, length: 8 } },
        { turtleId: b.turtleId!, strategy: 'tunnel', params: { origin: { x: 2, y: 100, z: 5 }, heading: 1, width: 1, height: 2, length: 8 } },
      ],
    });
    const ids = r.jobs.map((j) => j.id);
    let sawSpot = false;
    const watch = setInterval(() => {
      for (const t of [a, b]) {
        const pos = server.fleet.getTurtle(t.turtleId!)?.state?.pose.pos;
        if (pos && pos.x === 0 && pos.z === 3 && server.jobs.listJobs().some((j) => j.turtleId === t.turtleId && j.phase === 'waiting')) sawSpot = true;
      }
    }, 5);
    expect(server.jobs.campaignAction(r.campaignId, 'start').every((x) => x.ok)).toBe(true);
    await waitFor(() => ids.every((id) => (server.jobs.getJob(id)?.progress.cellsCleared ?? 0) >= 2));
    server.jobs.turtlesAction([a.turtleId!, b.turtleId!], 'pause');
    const paused = await finishAll(server, ids);
    expect(paused.map((j) => j.status)).toEqual(['paused', 'paused']);
    server.jobs.campaignAction(r.campaignId, 'start');
    const done = await finishAll(server, ids);
    clearInterval(watch);
    expect(done.map((j) => j.status)).toEqual(['completed', 'completed']);
    expect(sawSpot).toBe(true);
    expect(world.spilled).toBe(0);
    expect(server.jobs.listDepots()[0].lockedBy).toBeUndefined();
  }, 90000);

  it('without waiting spots, a turtle waits near the dock, not back in its tunnel', async () => {
    const { server, world, depot } = await site();
    // Tunnels start 14 blocks out, reached through open corridors.
    for (let x = 2; x < 14; x++) for (const z of [0, 5]) for (const y of [100, 101]) world.set(x, y, z, null);
    const junk = slots(Object.fromEntries(Array.from({ length: 13 }, (_, i) => [i + 1, { name: `minecraft:junk_${i}`, count: 64 }])));
    const a = await spawnTurtle(server, world, { x: 1, y: 100, z: 0, heading: 1 }, { opMs: 4, fuel: 800, slots: junk.map((s) => s && { ...s }) });
    const b = await spawnTurtle(server, world, { x: 1, y: 100, z: 5, heading: 1 }, { opMs: 4, fuel: 800, slots: junk.map((s) => s && { ...s }) });
    sims.push(a, b);
    const r = server.jobs.createCampaign({
      name: 'Far',
      depotId: depot.id,
      start: true,
      jobs: [
        { turtleId: a.turtleId!, strategy: 'tunnel', params: { origin: { x: 14, y: 100, z: 0 }, heading: 1, width: 1, height: 2, length: 4 } },
        { turtleId: b.turtleId!, strategy: 'tunnel', params: { origin: { x: 14, y: 100, z: 5 }, heading: 1, width: 1, height: 2, length: 4 } },
      ],
    });
    const ids = r.jobs.map((j) => j.id);
    let waited = 0;
    let farthest = 0;
    const watch = setInterval(() => {
      for (const j of server.jobs.listJobs()) {
        if (j.phase !== 'waiting') continue;
        const pos = server.fleet.getTurtle(j.turtleId)?.state?.pose.pos;
        if (!pos) continue;
        waited++;
        farthest = Math.max(farthest, Math.abs(pos.x) + Math.abs(pos.z));
      }
    }, 5);
    const done = await finishAll(server, ids, 90000);
    clearInterval(watch);
    expect(done.map((j) => j.error)).toEqual([undefined, undefined]);
    expect(done.map((j) => j.status)).toEqual(['completed', 'completed']);
    expect(waited).toBeGreaterThan(0);
    expect(farthest).toBeLessThanOrEqual(8);
    expect(world.spilled).toBe(0);
  }, 120000);
});
