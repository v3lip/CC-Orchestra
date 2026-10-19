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
const servers: Server[] = [];
const sims: SimTurtle[] = [];

afterEach(async () => {
  for (const t of sims.splice(0)) t.stop();
  await server?.close();
  server = undefined;
  for (const s of servers.splice(0)) await s.close();
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

  it('meeting head-on, the one giving way takes the other row early; nobody stops nose to nose', async () => {
    const server = await startServer();
    servers.push(server);
    const world = openWorld();
    const obs = corridor(world, false);
    // A 2-high stretch in the middle of the 1-high corridor: room to pass.
    fill(world, { x: 3, y: 101, z: 0 }, { x: 9, y: 101, z: 0 }, null);
    for (let x = 3; x <= 9; x++) obs.push({ x, y: 101, z: 0 });
    server.fleet.importObservations('sim', 'minecraft:overworld', obs, 'test');
    const a = await spawnTurtle(server, world, { x: 0, y: 100, z: 0, heading: 1 }, { opMs: 5, fuel: 500 });
    const b = await spawnTurtle(server, world, { x: 12, y: 100, z: 0, heading: 3 }, { opMs: 5, fuel: 500 });
    sims.push(a, b);
    let clash = false;
    const watch = setInterval(() => {
      if (a.body.pos.x === b.body.pos.x && a.body.pos.y === b.body.pos.y && a.body.pos.z === b.body.pos.z) clash = true;
    }, 2);
    // (Goals short of each other's start, so neither has to wait for the other to leave it.)
    server.jobs.goto(a.turtleId!, { x: 11, y: 100, z: 0 });
    server.jobs.goto(b.turtleId!, { x: 1, y: 100, z: 0 });
    await waitFor(() => !server.jobs.taskRunning(a.turtleId!) && !server.jobs.taskRunning(b.turtleId!), 40000, 'both go-to tasks to end');
    clearInterval(watch);
    const events = server.fleet.recentEvents(100).map((e) => e.message);
    expect(clash).toBe(false);
    expect(a.body.pos).toEqual({ x: 11, y: 100, z: 0 });
    expect(b.body.pos).toEqual({ x: 1, y: 100, z: 0 });
    expect(events.some((m) => m.includes('takes a parallel path'))).toBe(true);
    expect(events.filter((m) => m.includes('failed') || m.includes('block each other') || m.includes('steps aside'))).toEqual([]);
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

  it('a finished turtle leaves the dock, so a job started later can still unload', async () => {
    const { server, world, depot } = await site();
    const junk = () => slots(Object.fromEntries(Array.from({ length: 13 }, (_, i) => [i + 1, { name: `minecraft:junk_${i}`, count: 64 }])));
    const a = await spawnTurtle(server, world, { x: 1, y: 100, z: 0, heading: 1 }, { opMs: 4, fuel: 800 });
    sims.push(a);
    const ja = server.jobs.createJob({ name: 'A', depotId: depot.id, turtleId: a.turtleId!, strategy: 'tunnel', params: { origin: { x: 2, y: 100, z: 0 }, heading: 1, width: 1, height: 2, length: 3 }, policy: {} });
    server.jobs.start(ja.id);
    expect((await finishAll(server, [ja.id]))[0].status).toBe('completed');
    expect(a.body.pos).not.toEqual({ x: 0, y: 100, z: 0 });
    // Only now does another turtle start a job that needs the dock.
    const b = await spawnTurtle(server, world, { x: 1, y: 100, z: 3, heading: 1 }, { opMs: 4, fuel: 800, slots: junk() });
    sims.push(b);
    const jb = server.jobs.createJob({ name: 'B', depotId: depot.id, turtleId: b.turtleId!, strategy: 'tunnel', params: { origin: { x: 2, y: 100, z: 3 }, heading: 1, width: 1, height: 2, length: 3 }, policy: {} });
    server.jobs.start(jb.id);
    const done = (await finishAll(server, [jb.id]))[0];
    expect(done.error).toBeUndefined();
    expect(done.status).toBe('completed');
    expect(done.progress.trips).toBeGreaterThan(0);
  }, 90000);

  it('a turtle left standing on the dock gives a clear error, not "no route"', async () => {
    const { server, world, depot } = await site();
    const parked = await spawnTurtle(server, world, { x: 0, y: 100, z: 0, heading: 3 }, { opMs: 4 });
    const junk = slots(Object.fromEntries(Array.from({ length: 13 }, (_, i) => [i + 1, { name: `minecraft:junk_${i}`, count: 64 }])));
    const b = await spawnTurtle(server, world, { x: 1, y: 100, z: 3, heading: 1 }, { opMs: 4, fuel: 800, slots: junk });
    sims.push(parked, b);
    const jb = server.jobs.createJob({ name: 'B', depotId: depot.id, turtleId: b.turtleId!, strategy: 'tunnel', params: { origin: { x: 2, y: 100, z: 3 }, heading: 1, width: 1, height: 2, length: 3 }, policy: {} });
    server.jobs.start(jb.id);
    const done = (await finishAll(server, [jb.id]))[0];
    expect(done.status).toBe('paused');
    expect(done.error?.code).toBe('dock_blocked');
    expect(done.error?.message).toContain(server.fleet.getTurtle(parked.turtleId!)!.name);
  }, 90000);

  it('a turtle paused on its way to the dock does not keep the dock from the others', async () => {
    const { server, world, depot } = await site();
    for (let x = 2; x < 14; x++) for (const z of [0, 5]) for (const y of [100, 101]) world.set(x, y, z, null);
    const junk = () => slots(Object.fromEntries(Array.from({ length: 13 }, (_, i) => [i + 1, { name: `minecraft:junk_${i}`, count: 64 }])));
    const a = await spawnTurtle(server, world, { x: 1, y: 100, z: 0, heading: 1 }, { opMs: 40, fuel: 800, slots: junk() });
    const b = await spawnTurtle(server, world, { x: 1, y: 100, z: 5, heading: 1 }, { opMs: 4, fuel: 800, slots: junk() });
    sims.push(a, b);
    const ja = server.jobs.createJob({ name: 'A', depotId: depot.id, turtleId: a.turtleId!, strategy: 'tunnel', params: { origin: { x: 14, y: 100, z: 0 }, heading: 1, width: 1, height: 2, length: 4 }, policy: {} });
    const jb = server.jobs.createJob({ name: 'B', depotId: depot.id, turtleId: b.turtleId!, strategy: 'tunnel', params: { origin: { x: 14, y: 100, z: 5 }, heading: 1, width: 1, height: 2, length: 4 }, policy: {} });
    server.jobs.start(ja.id);
    // A heads home and takes the dock: pause it before it gets there.
    await waitFor(() => server.jobs.listDepots()[0].lockedBy === a.turtleId && a.body.pos.x > 0, 60000, 'A to take the dock on its way in');
    server.jobs.pause(ja.id);
    await waitFor(() => server.jobs.getJob(ja.id)?.status === 'paused', 30000, 'A paused');
    expect(a.body.pos).not.toEqual({ x: 0, y: 100, z: 0 });
    // B can still use the dock.
    server.jobs.start(jb.id);
    const done = await finishAll(server, [jb.id], 60000);
    expect(done[0].error).toBeUndefined();
    expect(done[0].status).toBe('completed');
    expect(done[0].progress.trips).toBeGreaterThan(0);
    // And A, resumed, finishes its trip and its tunnel.
    server.jobs.start(ja.id);
    const doneA = await finishAll(server, [ja.id], 60000);
    expect(doneA[0].status).toBe('completed');
    expect(world.spilled).toBe(0);
  }, 150000);

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
