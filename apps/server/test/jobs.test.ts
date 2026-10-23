/**
 * Tunnel jobs, depot trips and failure handling — simulator verification (TypeScript
 * agent, plus the real Lua agent in the CC host for the core paths).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobView } from '@ccfleet/protocol';
import type { CCTurtle, SimTurtle, SimWorld, TurtleBody } from '@ccfleet/sim';
import { fill, openWorld, spawnLuaTurtle, spawnTurtle, startServer, waitFor } from './helpers';

type Server = Awaited<ReturnType<typeof startServer>>;
let server: Server | undefined;
const sims: SimTurtle[] = [];
const luas: CCTurtle[] = [];

afterEach(async () => {
  for (const t of sims.splice(0)) t.stop();
  for (const t of luas.splice(0)) t.shutdown();
  await server?.close();
  server = undefined;
});

/**
 * Layout (y = 100 is the tunnel floor, everything else at y>=98 is open air):
 *   chest at x=-1 (west of the dock) · dock at x=0 facing west · air at x=1 · rock from x=2 east.
 */
function site(world: SimWorld, opts: { chest?: boolean; chestSize?: number; fuelChest?: boolean } = {}) {
  fill(world, { x: 2, y: 97, z: -4 }, { x: 30, y: 106, z: 4 }, 'minecraft:stone');
  if (opts.chest !== false) world.placeChest({ x: -1, y: 100, z: 0 }, opts.chestSize ?? 27);
  if (opts.fuelChest) world.placeChest({ x: 0, y: 99, z: 0 });
}

function chestItems(world: SimWorld, x = -1, y = 100, z = 0) {
  return (world.inventories.get(`${x},${y},${z}`) ?? []).reduce((n, s) => n + (s?.count ?? 0), 0);
}

function slots(fill: Record<number, { name: string; count: number }>): TurtleBody['slots'] {
  const out: TurtleBody['slots'] = Array(16).fill(null);
  for (const [k, v] of Object.entries(fill)) out[Number(k) - 1] = { ...v };
  return out;
}

async function setup(opts?: Parameters<typeof site>[1]) {
  server = await startServer();
  const world = openWorld();
  site(world, opts);
  const depot = server.jobs.saveDepot({ name: 'Home', world: 'sim', dimension: 'minecraft:overworld', dock: { x: 0, y: 100, z: 0 }, dockHeading: 3, unloadDir: 'front', fuelDir: opts?.fuelChest ? 'down' : undefined });
  return { server, world, depot };
}

function tunnel(turtleId: string, depotId: string, over: Partial<{ width: number; height: number; length: number }> = {}, policy: Record<string, unknown> = {}) {
  return {
    name: 'Test tunnel',
    strategy: 'tunnel' as const,
    params: { origin: { x: 2, y: 100, z: 0 }, heading: 1, width: 1, height: 2, length: 8, ...over },
    depotId,
    turtleId,
    policy,
  };
}

async function finish(s: Server, id: string, timeout = 30000): Promise<JobView> {
  const r = await waitFor(() => {
    const j = s.jobs.getJob(id);
    return j && (j.status === 'completed' || j.status === 'paused' || j.status === 'cancelled') ? j : undefined;
  }, timeout, () => `job ${id} to stop (now ${s.jobs.getJob(id)?.status}/${s.jobs.getJob(id)?.phase})`);
  return r;
}

function allClear(world: SimWorld, w: number, h: number, l: number) {
  for (let d = 0; d < l; d++) for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    const b = world.get(2 + d, 100 + y, x); // heading east: right = south (+z)
    if (b) return `(${2 + d} ${100 + y} ${x}) is ${b.name}`;
  }
  return 'clear';
}

async function sim(s: Server, world: SimWorld, extra: Parameters<typeof spawnTurtle>[3] = {}) {
  const t = await spawnTurtle(s, world, { x: 0, y: 100, z: 0, heading: 1 }, { opMs: 4, fuel: 500, ...extra });
  sims.push(t);
  return t;
}

describe('tunnel job (TS agent)', () => {
  it('mines a 1x2x8 tunnel, returns, and unloads into the depot chest', async () => {
    const { server, world, depot } = await setup();
    const t = await sim(server, world);
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id));
    expect(job.estimate.cells).toBe(16);
    server.jobs.start(job.id);
    const done = await finish(server, job.id);
    expect(done.error).toBeUndefined();
    expect(done.status).toBe('completed');
    expect(allClear(world, 1, 2, 8)).toBe('clear');
    expect(done.progress.cellsCleared).toBe(16);
    // Unloaded at the dock (below), then off it so a later job can use the dock: with no
    // waiting spots, back where the job started.
    expect(t.body.pos).toEqual({ x: 2, y: 100, z: 0 });
    expect(chestItems(world)).toBe(16);
    expect(done.progress.itemsUnloaded).toBe(16);
    expect(t.body.slots.filter(Boolean)).toHaveLength(0);
    expect(world.spilled).toBe(0);
  });

  it('3x3 cross-section: returns when inventory fills, resumes where it left off, keeps the fuel slot', async () => {
    const { server, world, depot } = await setup({ chestSize: 54 });
    // Seven different junk stacks leave few free slots, forcing mid-job trips.
    const junk = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i + 1, { name: `minecraft:junk_${i}`, count: 64 }]));
    const t = await sim(server, world, { slots: slots({ ...junk, 16: { name: 'minecraft:coal', count: 10 } }) });
    // Ores (which drop themselves) add stack types; minFreeSlots 6 triggers early.
    world.set(4, 101, 1, { name: 'minecraft:gold_ore' });
    world.set(5, 102, 2, { name: 'minecraft:iron_ore' });
    world.set(6, 100, 0, { name: 'minecraft:gravel' });
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { width: 3, height: 3, length: 6 }, { minFreeSlots: 6 }));
    server.jobs.start(job.id);
    const done = await finish(server, job.id, 60000);
    expect(done.error).toBeUndefined();
    expect(done.status).toBe('completed');
    expect(allClear(world, 3, 3, 6)).toBe('clear');
    expect(done.progress.trips).toBeGreaterThanOrEqual(2);
    expect(t.body.slots[15]).toEqual({ name: 'minecraft:coal', count: 10 }); // fuel slot kept
    expect(chestItems(world)).toBe(7 * 64 + 54);
    expect(world.spilled).toBe(0);
  });

  it('missing chest: pauses with an actionable error and drops nothing into the world', async () => {
    const { server, world, depot } = await setup({ chest: false });
    const t = await sim(server, world);
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 3 }));
    server.jobs.start(job.id);
    const done = await finish(server, job.id);
    expect(done.status).toBe('paused');
    expect(done.error?.code).toBe('chest_missing');
    expect(done.error?.message).toMatch(/Place one there/);
    expect(world.spilled).toBe(0);
    expect(t.body.slots.filter(Boolean).reduce((n, s) => n + s!.count, 0)).toBe(6);

    // Fix it and resume: the job finishes.
    world.placeChest({ x: -1, y: 100, z: 0 });
    server.jobs.start(job.id);
    expect((await finish(server, job.id)).status).toBe('completed');
    expect(chestItems(world)).toBe(6);
  });

  it('full chest: partial transfer is detected and the job pauses', async () => {
    const { server, world, depot } = await setup({ chestSize: 1 });
    world.inventories.get('-1,100,0')![0] = { name: 'minecraft:cobblestone', count: 60 };
    const t = await sim(server, world);
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 4 }));
    server.jobs.start(job.id);
    const done = await finish(server, job.id);
    expect(done.status).toBe('paused');
    expect(done.error?.code).toBe('chest_full');
    expect(chestItems(world)).toBe(64);
    expect(world.spilled).toBe(0);
  });

  it('never digs a protected block inside the job area', async () => {
    const { server, world, depot } = await setup();
    world.placeChest({ x: 5, y: 101, z: 0 });
    const t = await sim(server, world);
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 6 }));
    server.jobs.start(job.id);
    const done = await finish(server, job.id);
    expect(done.status).toBe('paused');
    expect(done.error?.code).toBe('protected');
    expect(world.get(5, 101, 0)?.name).toBe('minecraft:chest');
  });

  it('Geo scanning finds a vein beside the tunnel that the turtle never looks at, and mines it', async () => {
    for (const scan of [false, true]) {
      const { server, world, depot } = await setup();
      // A diamond vein running off sideways from the tunnel wall.
      for (const z of [1, 2, 3]) world.set(5, 100, z, { name: 'minecraft:diamond_ore' });
      const t = await sim(server, world, { fuel: 2000, upgrades: { left: 'geoScanner' } });
      const policy = { veins: { ores: ['diamond'], maxBlocks: 16, reach: 4 }, ...(scan ? { geoScan: { every: 4, radius: 4 } } : {}) };
      const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 8 }, policy));
      server.jobs.start(job.id);
      const done = await finish(server, job.id, 60000);
      expect(done.error).toBeUndefined();
      expect(done.status).toBe('completed');
      const left = [1, 2, 3].filter((z) => world.get(5, 100, z)?.name === 'minecraft:diamond_ore').length;
      if (scan) {
        expect(left).toBe(0);
        expect(done.progress.veinBlocks).toBe(3);
        expect(done.progress.scans).toBe(2);
      } else {
        expect(left).toBe(3);
      }
      await server.close();
    }
  });

  it('Geo scanning without a scanner says so once and mines on', async () => {
    const { server, world, depot } = await setup();
    const t = await sim(server, world, { fuel: 2000 });
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 8 }, { geoScan: { every: 2, radius: 8 } }));
    server.jobs.start(job.id);
    const done = await finish(server, job.id);
    expect(done.status).toBe('completed');
    expect(done.progress.scans ?? 0).toBe(0);
    expect(server.fleet.recentEvents(200).filter((e) => e.message.includes('has no Geo Scanner'))).toHaveLength(1);
  });

  it('queued jobs start by themselves, one after the other, in queue order', async () => {
    const { server, world, depot } = await setup();
    const t = await sim(server, world, { fuel: 2000 });
    const first = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 3 }));
    // A second job for a busy turtle is refused unless it's queued.
    expect(() => server.jobs.createJob({ ...tunnel(t.turtleId!, depot.id, { length: 3 }), params: { origin: { x: 2, y: 100, z: 3 }, heading: 1, width: 1, height: 2, length: 3 } })).toThrow(/queue/);
    const later = server.jobs.createJob({ ...tunnel(t.turtleId!, depot.id), name: 'Later', params: { origin: { x: 2, y: 100, z: -3 }, heading: 1, width: 1, height: 2, length: 3 }, queue: true });
    const next = server.jobs.createJob({ ...tunnel(t.turtleId!, depot.id), name: 'Next', params: { origin: { x: 2, y: 100, z: 3 }, heading: 1, width: 1, height: 2, length: 3 }, queue: true });
    expect([later.status, next.status]).toEqual(['queued', 'queued']);
    // Queued jobs still count when checking overlaps.
    expect(() => server.jobs.createJob({ ...tunnel(t.turtleId!, depot.id), params: { origin: { x: 3, y: 100, z: 3 }, heading: 1, width: 1, height: 2, length: 3 }, queue: true })).toThrow(/overlaps job "Next"/);
    server.jobs.queueFirst(next.id);
    server.jobs.start(later.id); // asking a queued job to start just leaves it queued
    expect(server.jobs.getJob(later.id)?.status).toBe('queued');
    server.jobs.start(first.id);
    const ids = [first.id, next.id, later.id];
    const done = await waitFor(() => {
      const js = ids.map((id) => server.jobs.getJob(id)!);
      return js.every((j) => j.status === 'completed' || j.status === 'paused') ? js : undefined;
    }, 90000, 'all three jobs');
    expect(done.map((j) => j.error?.message)).toEqual([undefined, undefined, undefined]);
    expect(done.map((j) => j.status)).toEqual(['completed', 'completed', 'completed']);
    expect(done[0].finishedAt! <= done[1].startedAt! && done[1].finishedAt! <= done[2].startedAt!).toBe(true);
    for (const z of [0, 3, -3]) for (let x = 2; x <= 4; x++) expect(world.get(x, 100, z), `${x} 100 ${z}`).toBeNull();
  }, 120000);

  it("the turtle shows its queue; jobs move up and down; campaign actions handle queued jobs", async () => {
    const { server, world, depot } = await setup();
    const t = await sim(server, world, { fuel: 2000 });
    const id = t.turtleId!;
    const at = (z: number) => ({ origin: { x: 2, y: 100, z }, heading: 1 as const, width: 1, height: 2, length: 3 });
    const current = server.jobs.createJob(tunnel(id, depot.id, { length: 3 }));
    const a = server.jobs.createJob({ ...tunnel(id, depot.id), name: 'A', params: at(3), queue: true });
    const b = server.jobs.createJob({ ...tunnel(id, depot.id), name: 'B', params: at(-3), queue: true });
    await waitFor(() => server.fleet.getTurtle(id)?.queue?.count === 2, 3000, 'queue on the turtle');
    expect(server.fleet.getTurtle(id)?.queue?.next).toEqual({ id: a.id, name: 'A' });
    server.jobs.queueMove(b.id, -1);
    expect(server.jobs.queueOf(id).map((j) => j.view.name)).toEqual(['B', 'A']);
    server.jobs.queueMove(b.id, -1); // already first: stays
    server.jobs.queueMove(b.id, 1);
    expect(server.jobs.queueOf(id).map((j) => j.view.name)).toEqual(['A', 'B']);
    // A campaign queued behind the current job: Start all leaves it waiting, Pause all
    // passes over it, Cancel all cancels it.
    const c = server.jobs.createCampaign({ name: 'Later', depotId: depot.id, queue: true, jobs: [{ turtleId: id, strategy: 'tunnel', params: at(6) }] });
    expect(c.jobs[0].status).toBe('queued');
    expect(server.jobs.campaignAction(c.campaignId, 'start')).toEqual([{ jobId: c.jobs[0].id, ok: true }]);
    expect(server.jobs.getJob(c.jobs[0].id)?.status).toBe('queued');
    expect(server.jobs.campaignAction(c.campaignId, 'pause')).toEqual([{ jobId: c.jobs[0].id, ok: true }]);
    expect(server.jobs.campaignAction(c.campaignId, 'cancel')).toEqual([{ jobId: c.jobs[0].id, ok: true }]);
    expect(server.jobs.getJob(c.jobs[0].id)?.status).toBe('cancelled');
    expect(server.jobs.getJob(current.id)?.status).toBe('ready');
  });

  it('a cancelled job does not start the queue; the next one waits for the operator', async () => {
    const { server, world, depot } = await setup();
    const t = await sim(server, world, { fuel: 2000 });
    const first = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 8 }));
    const next = server.jobs.createJob({ ...tunnel(t.turtleId!, depot.id), name: 'Next', params: { origin: { x: 2, y: 100, z: 3 }, heading: 1, width: 1, height: 2, length: 3 }, queue: true });
    server.jobs.start(first.id);
    await waitFor(() => (server.jobs.getJob(first.id)?.progress.cellsCleared ?? 0) >= 2, 30000, 'some progress');
    server.jobs.cancel(first.id);
    await new Promise((r) => setTimeout(r, 1500));
    expect(server.jobs.getJob(next.id)?.status).toBe('queued');
    // Started by hand, it runs now (nothing ahead of it any more).
    server.jobs.start(next.id);
    expect((await finish(server, next.id)).status).toBe('completed');
  }, 120000);

  it('a claimed chunk ("Movement failed") pauses the job with what to do about it', async () => {
    const { server, world, depot } = await setup();
    world.claimedChunks.add('1,0');
    const t = await sim(server, world);
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 20 }));
    server.jobs.start(job.id);
    const done = await finish(server, job.id);
    expect(done.status).toBe('paused');
    expect(done.error?.code).toBe('failed');
    expect(done.error?.message).toContain('into (16 101 0) failed: Movement failed');
    expect(done.error?.message).toContain('FTB Chunks');
    expect(server.fleet.getTurtle(t.turtleId!)?.state?.pose.pos?.x).toBe(15);
  });

  it('a result that never comes from a connected turtle pauses with that reason, not "went offline"', async () => {
    const { server, world, depot } = await setup();
    const t = await sim(server, world);
    let digs = 0;
    t.faults.stallBeforeResult = (op) => (op === 'dig' && ++digs === 3 ? 4000 : undefined); // past the 3 s result timeout
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 6 }));
    server.jobs.start(job.id);
    const paused = await waitFor(() => (server.jobs.getJob(job.id)?.status === 'paused' ? server.jobs.getJob(job.id) : undefined), 20000, 'pause');
    expect(server.fleet.turtleState(t.turtleId!)?.online).toBe(true);
    expect(paused!.pauseReason).toContain('no answer');
    expect(paused!.pauseReason).not.toContain('went offline');
    // Resuming right away: the turtle is still busy with the late command; the job
    // waits for it instead of failing, then finishes.
    server.jobs.start(job.id);
    const done = await finish(server, job.id);
    expect(done.error).toBeUndefined();
    expect(done.status).toBe('completed');
    expect(allClear(world, 1, 2, 6)).toBe('clear');
  });

  it('handles falling gravel by re-digging, without walking into the gravel first', async () => {
    const { server, world, depot } = await setup();
    fill(world, { x: 4, y: 101, z: 0 }, { x: 4, y: 105, z: 0 }, 'minecraft:gravel');
    const t = await sim(server, world);
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 5 }));
    server.jobs.start(job.id);
    const done = await finish(server, job.id);
    expect(done.status).toBe('completed');
    expect(allClear(world, 1, 2, 5)).toBe('clear');
    // The agent reports the gravel that fell back in right after each dig, so the
    // turtle digs again instead of trying to move into it.
    expect(server.fleet.recentEvents(200).filter((e) => e.message.includes('obstructed')).map((e) => e.message)).toEqual([]);
  });

  it('manual control pauses the job after the current step; resume finishes it', async () => {
    const { server, world, depot } = await setup();
    const t = await sim(server, world);
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 8 }));
    server.jobs.start(job.id);
    await waitFor(() => (server.jobs.getJob(job.id)?.progress.cellsCleared ?? 0) >= 4);
    server.fleet.issueCommand({ turtleIds: [t.turtleId!] }, 'turnLeft', {});
    const paused = await finish(server, job.id);
    expect(paused).toMatchObject({ status: 'paused', pauseReason: 'manual control took over' });
    server.jobs.start(job.id);
    const done = await finish(server, job.id);
    expect(done.status).toBe('completed');
    expect(allClear(world, 1, 2, 8)).toBe('clear');
  });

  it('turtle disconnect pauses the job; it resumes after reconnecting', async () => {
    const { server, world, depot } = await setup();
    const t = await sim(server, world);
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 8 }));
    server.jobs.start(job.id);
    await waitFor(() => (server.jobs.getJob(job.id)?.progress.cellsCleared ?? 0) >= 4);
    t.dropConnection();
    const paused = await finish(server, job.id);
    expect(paused.status).toBe('paused');
    expect(paused.pauseReason).toBe('turtle went offline');
    await waitFor(() => server.fleet.getTurtle(t.turtleId!)?.connection === 'online', 8000);
    server.jobs.start(job.id);
    expect((await finish(server, job.id)).status).toBe('completed');
    expect(allClear(world, 1, 2, 8)).toBe('clear');
  });

  it('refuels from the fuel chest when fuel runs low', async () => {
    const { server, world, depot } = await setup({ fuelChest: true });
    world.inventories.get('0,99,0')![0] = { name: 'minecraft:coal', count: 32 };
    const t = await sim(server, world, { fuel: 140 });
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 8 }, { fuelReserve: 120, refuelTarget: 800 }));
    server.jobs.start(job.id);
    const done = await finish(server, job.id);
    expect(done.error).toBeUndefined();
    expect(done.status).toBe('completed');
    expect(typeof t.body.fuel === 'number' && t.body.fuel > 500).toBe(true);
    expect(world.inventories.get('0,99,0')![0]!.count).toBeLessThan(32);
  });

  it('pausing during a depot trip and resuming does not count cells twice', async () => {
    const { server, world, depot } = await setup();
    const junk = slots(Object.fromEntries(Array.from({ length: 13 }, (_, i) => [i + 1, { name: `minecraft:junk_${i}`, count: 64 }])));
    const t = await sim(server, world, { fuel: 800, slots: junk });
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 8 }, { minFreeSlots: 1 }));
    server.jobs.start(job.id);
    // Pause on the way back to work, after unloading, deep enough into the tunnel to matter.
    await waitFor(() => (server.jobs.getJob(job.id)?.progress.trips ?? 0) >= 1 && server.jobs.getJob(job.id)?.phase === 'traveling', 30000, 'a trip back to work');
    await waitFor(() => t.body.pos.x >= 3, 30000, 'turtle back in the tunnel');
    server.jobs.pause(job.id);
    await waitFor(() => server.jobs.getJob(job.id)?.status === 'paused', 30000, 'pause');
    server.jobs.start(job.id);
    const done = await finish(server, job.id);
    expect(done.status).toBe('completed');
    expect(allClear(world, 1, 2, 8)).toBe('clear');
    expect(done.progress.cellsCleared).toBe(16);
  });

  it('topping up from the fuel chest burns only what it took, not the carried reserve', async () => {
    const { server, world, depot } = await setup({ fuelChest: true });
    world.inventories.get('0,99,0')![0] = { name: 'minecraft:coal', count: 32 };
    const t = await sim(server, world, { fuel: 400, slots: slots({ 16: { name: 'minecraft:coal', count: 8 } }) });
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 4 }, { fuelReserve: 100, refuelTarget: 800 }));
    server.jobs.start(job.id);
    const done = await finish(server, job.id);
    expect(done.error).toBeUndefined();
    expect(done.status).toBe('completed');
    // Topped up to the target from the chest...
    expect(typeof t.body.fuel === 'number' && t.body.fuel >= 800 && t.body.fuel < 800 + 80).toBe(true);
    // ...and the reserve in the fuel slot is still there.
    expect(t.body.slots[15]).toEqual({ name: 'minecraft:coal', count: 8 });
  });

  it('without enough fuel or a fuel chest it stops with an actionable error', async () => {
    const { server, world, depot } = await setup();
    const t = await sim(server, world, { fuel: 60 });
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 8 }, { fuelReserve: 60 }));
    server.jobs.start(job.id);
    const done = await finish(server, job.id);
    expect(done.status).toBe('paused');
    expect(done.error?.code).toBe('insufficient_fuel');
    expect(t.body.pos).toEqual({ x: 0, y: 100, z: 0 }); // went home rather than getting stranded
  });

  it('backend restart: running job comes back paused and resumes from its checkpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccorchestra-jobs-'));
    const dbFile = join(dir, 'fleet.sqlite');
    try {
      server = await startServer({ dbFile });
      const port = server.port;
      const world = openWorld();
      site(world);
      const depot = server.jobs.saveDepot({ name: 'Home', world: 'sim', dimension: 'minecraft:overworld', dock: { x: 0, y: 100, z: 0 }, dockHeading: 3, unloadDir: 'front' });
      const t = await sim(server, world);
      const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 10 }));
      server.jobs.start(job.id);
      await waitFor(() => (server!.jobs.getJob(job.id)?.progress.unitsDone ?? 0) >= 3);
      await server.close();
      server = await startServer({ dbFile, port });
      const j = server.jobs.getJob(job.id)!;
      expect(j).toMatchObject({ status: 'paused', pauseReason: 'backend restarted' });
      expect(j.progress.unitsDone).toBeGreaterThanOrEqual(3);
      await waitFor(() => server!.fleet.getTurtle(t.turtleId!)?.connection === 'online', 10000);
      server.jobs.start(job.id);
      expect((await finish(server, job.id)).status).toBe('completed');
      expect(allClear(world, 1, 2, 10)).toBe('clear');
    } finally {
      for (const t of sims.splice(0)) t.stop();
      await server?.close();
      server = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('tunnel job (real Lua agent)', () => {
  async function lua(s: Server, world: SimWorld, extra: Parameters<typeof spawnLuaTurtle>[3] = {}) {
    const t = await spawnLuaTurtle(s, world, { x: 0, y: 100, z: 0, heading: 1 }, { opMs: 4, fuel: 500, ...extra });
    luas.push(t);
    return t;
  }

  it('places torches from the fuel chest (real agent end to end)', async () => {
    const { server, world, depot } = await setup({ fuelChest: true });
    const fuelChest = world.inventories.get('0,99,0')!;
    fuelChest[0] = { name: 'minecraft:torch', count: 64 };
    const t = await lua(server, world, { fuel: 2000 });
    const job = server.jobs.createJob(tunnel(t.turtleId, depot.id, { length: 16 }, { torches: { enabled: true, spacing: 8 } }));
    server.jobs.start(job.id);
    const done = await finish(server, job.id, 60000);
    expect(done.error).toBeUndefined();
    expect(done.status).toBe('completed');
    const placed = Array.from({ length: 16 }, (_, d) => 2 + d).filter((x) => world.get(x, 100, 0)?.name === 'minecraft:torch');
    expect(placed).toHaveLength(2);
    expect(done.progress.torchesPlaced).toBe(2);
    expect(world.spilled).toBe(0);
  });

  it('mines, returns and unloads with verified drops', async () => {
    const { server, world, depot } = await setup();
    const t = await lua(server, world, { slots: slots({ 16: { name: 'minecraft:coal', count: 5 } }) });
    const job = server.jobs.createJob(tunnel(t.turtleId, depot.id, { width: 2, height: 3, length: 4 }));
    server.jobs.start(job.id);
    const done = await finish(server, job.id, 60000);
    expect(done.error).toBeUndefined();
    expect(done.status).toBe('completed');
    expect(allClear(world, 2, 3, 4)).toBe('clear');
    expect(chestItems(world)).toBe(24);
    expect(t.body.slots[15]).toEqual({ name: 'minecraft:coal', count: 5 });
    expect(world.spilled).toBe(0);
  });

  it('refuses to drop when the chest is gone (nothing thrown into the world)', async () => {
    const { server, world, depot } = await setup({ chest: false });
    const t = await lua(server, world);
    const job = server.jobs.createJob(tunnel(t.turtleId, depot.id, { length: 2 }));
    server.jobs.start(job.id);
    const done = await finish(server, job.id);
    expect(done.error?.code).toBe('chest_missing');
    expect(world.spilled).toBe(0);
  });

  it('agent refuses to dig an inventory even when the server asks', async () => {
    const { server, world } = await setup();
    const t = await lua(server, world);
    world.placeChest({ x: 1, y: 100, z: 0 });
    const r = await server.fleet.runStep(t.turtleId, 'dig', { force: true }, 'manual');
    expect(r).toMatchObject({ status: 'failed', code: 'protected' });
    expect(world.get(1, 100, 0)?.name).toBe('minecraft:chest');
  });
});

describe('several turtles, one depot', () => {
  it('rejects a tunnel that overlaps an unfinished job', async () => {
    const { server, world, depot } = await setup();
    const a = await sim(server, world);
    const b = await spawnTurtle(server, world, { x: 1, y: 100, z: 2, heading: 1 }, { opMs: 4, fuel: 500 });
    sims.push(b);
    server.jobs.createJob(tunnel(a.turtleId!, depot.id, { width: 3, length: 4 }));
    expect(() => server.jobs.createJob({ ...tunnel(b.turtleId!, depot.id), params: { origin: { x: 3, y: 100, z: 2 }, heading: 1, width: 1, height: 2, length: 4 } })).toThrow(/overlaps job/);
  });

  it('two turtles take turns at the dock and both finish; nothing collides or spills', async () => {
    const { server, world, depot } = await setup({ chestSize: 54 });
    // Junk forces both to make mid-job trips, so they compete for the dock.
    const junk = (n: number) => slots(Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, { name: `minecraft:junk_${i}`, count: 64 }])));
    const a = await spawnTurtle(server, world, { x: 1, y: 100, z: 0, heading: 1 }, { opMs: 4, fuel: 800, slots: junk(13) });
    const b = await spawnTurtle(server, world, { x: 1, y: 100, z: 2, heading: 1 }, { opMs: 4, fuel: 800, slots: junk(13) });
    sims.push(a, b);
    const ja = server.jobs.createJob({ ...tunnel(a.turtleId!, depot.id, { length: 10 }), name: 'A' });
    const jb = server.jobs.createJob({ ...tunnel(b.turtleId!, depot.id), name: 'B', params: { origin: { x: 2, y: 100, z: 2 }, heading: 1, width: 1, height: 2, length: 10 } });
    const sawWaiting = { v: false };
    const watch = setInterval(() => {
      for (const id of [ja.id, jb.id]) if (server.jobs.getJob(id)?.phase === 'waiting') sawWaiting.v = true;
      // Never both on the dock or the same cell.
      expect(a.body.pos).not.toEqual(b.body.pos);
    }, 5);
    server.jobs.start(ja.id);
    server.jobs.start(jb.id);
    const [da, db] = await Promise.all([finish(server, ja.id, 60000), finish(server, jb.id, 60000)]);
    clearInterval(watch);
    expect(da.error).toBeUndefined();
    expect(db.error).toBeUndefined();
    expect([da.status, db.status]).toEqual(['completed', 'completed']);
    expect(sawWaiting.v).toBe(true);
    expect(chestItems(world)).toBe(2 * (13 * 64 + 20));
    expect(world.spilled).toBe(0);
    for (let d = 0; d < 10; d++) for (const z of [0, 2]) for (const y of [100, 101]) expect(world.get(2 + d, y, z)).toBeNull();
    // Whoever finished first parked in its own tunnel, not on the dock.
    const dock = { x: 0, y: 100, z: 0 };
    const onDock = [a, b].filter((t) => t.body.pos.x === dock.x && t.body.pos.y === dock.y && t.body.pos.z === dock.z);
    expect(onDock.length).toBeLessThanOrEqual(1);
    expect(server.jobs.listDepots()[0].lockedBy).toBeUndefined();
  }, 90_000);
});

describe('chunk loading', () => {
  it('estimates warn when the turtle has no Chunk Controller', async () => {
    const { server, world, depot } = await setup();
    const plain = await sim(server, world);
    const chunky = await spawnTurtle(server, world, { x: 1, y: 100, z: 3, heading: 1 }, { opMs: 4, upgrades: { right: 'chunky' } });
    sims.push(chunky);
    const w1 = server.jobs.estimate(tunnel(plain.turtleId!, depot.id)).warnings;
    const w2 = server.jobs.estimate(tunnel(chunky.turtleId!, depot.id)).warnings;
    expect(w1.some((w) => w.includes('no Chunk Controller'))).toBe(true);
    expect(w2.some((w) => w.includes('no Chunk Controller'))).toBe(false);
  });
});

describe('chunk borders', () => {
  it('the estimate lists the chunks a job uses and which are marked force-loaded', async () => {
    const { server, world, depot } = await setup();
    const t = await sim(server, world);
    const long = tunnel(t.turtleId!, depot.id, { length: 20 }); // x 2..21 crosses x=16
    const e1 = server.jobs.estimate(long);
    expect(e1.chunks.map((c) => `${c.cx},${c.cz}`).sort()).toEqual(['0,0', '1,0']);
    for (const c of e1.chunks) server.jobs.setForced('sim', 'minecraft:overworld', c.cx, c.cz, true);
    const e2 = server.jobs.estimate(long);
    expect(e2.chunks.every((c) => c.forced)).toBe(true);
  });

  it('going offline while crossing a chunk border says so', async () => {
    const { server, world, depot } = await setup();
    const t = await sim(server, world);
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 20 }));
    server.jobs.start(job.id);
    // Drop the link the moment the turtle steps into the next chunk (x=16), as an
    // unloaded chunk would in-game.
    let dropped = false;
    const watch = setInterval(() => {
      if (!dropped && t.body.pos.x === 16) {
        dropped = true;
        t.stop();
      }
    }, 1);
    const done = await finish(server, job.id);
    clearInterval(watch);
    expect(done.status).toBe('paused');
    expect(done.pauseReason).toBe('turtle went offline as it crossed from chunk 0,0 into chunk 1,0');
  });
});

describe('auto-resume (opt-in)', () => {
  it('a job paused because its turtle dropped continues when the turtle comes back', async () => {
    const { server, world, depot } = await setup();
    const t = await sim(server, world);
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 8 }, { autoResume: true }));
    server.jobs.start(job.id);
    await waitFor(() => (server.jobs.getJob(job.id)?.progress.cellsCleared ?? 0) >= 4);
    t.dropConnection(); // the simulated turtle reconnects by itself after ~1 s
    await waitFor(() => server.jobs.getJob(job.id)?.status === 'paused', 5000, 'pause on drop');
    const done = await waitFor(() => (server.jobs.getJob(job.id)?.status === 'completed' ? server.jobs.getJob(job.id) : undefined), 30000, 'completion');
    expect(done.status).toBe('completed');
    expect(server.fleet.recentEvents(80).some((e) => e.message.includes('resumed automatically'))).toBe(true);
    expect(server.fleet.recentEvents(80).some((e) => /disconnected \(socket closed, code \d+/.test(e.message))).toBe(true);
    expect(allClear(world, 1, 2, 8)).toBe('clear');
  });

  it('never resumes a job the operator paused', async () => {
    const { server, world, depot } = await setup();
    const t = await sim(server, world);
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 8 }, { autoResume: true }));
    server.jobs.start(job.id);
    await waitFor(() => (server.jobs.getJob(job.id)?.progress.cellsCleared ?? 0) >= 2);
    server.jobs.pause(job.id);
    await waitFor(() => server.jobs.getJob(job.id)?.status === 'paused', 5000);
    t.dropConnection();
    await waitFor(() => server.fleet.getTurtle(t.turtleId!)?.connection === 'offline', 5000);
    await waitFor(() => server.fleet.getTurtle(t.turtleId!)?.connection === 'online', 8000);
    await new Promise((r) => setTimeout(r, 1500));
    expect(server.jobs.getJob(job.id)?.status).toBe('paused');
  });
});

describe('strategies', () => {
  it('branch mine: corridor plus side branches every 3 blocks, solid between them', async () => {
    const { server, world, depot } = await setup();
    const t = await sim(server, world, { fuel: 800 });
    const job = server.jobs.createJob({
      name: 'Branches',
      strategy: 'branch',
      params: { origin: { x: 2, y: 100, z: 0 }, heading: 1, width: 1, height: 2, length: 10, spacing: 3, branchLength: 3, sides: 'both' },
      depotId: depot.id,
      turtleId: t.turtleId!,
      policy: {},
    });
    expect(job.segments.length).toBe(9); // 3 corridor parts (branches at 3, 6, 9) + 3 x 2 branches
    server.jobs.start(job.id);
    const done = await finish(server, job.id, 60000);
    expect(done.error).toBeUndefined();
    expect(done.status).toBe('completed');
    for (let x = 2; x <= 11; x++) for (const y of [100, 101]) expect(world.get(x, y, 0)).toBeNull();
    for (const x of [5, 8, 11]) for (const z of [-3, -2, -1, 1, 2, 3]) for (const y of [100, 101]) expect(world.get(x, y, z), `${x},${y},${z}`).toBeNull();
    // Between branches the rock stays.
    for (const x of [6, 7, 9, 10]) expect(world.get(x, 100, -1)?.name).toBe('minecraft:stone');
    expect(world.spilled).toBe(0);
  }, 90000);

  it('grid mine: parallel tunnels every 3 blocks, joined at alternate ends, solid between', async () => {
    const { server, world, depot } = await setup();
    const t = await sim(server, world, { fuel: 800 });
    const job = server.jobs.createJob({
      name: 'Grid',
      strategy: 'grid',
      params: { origin: { x: 2, y: 100, z: -3 }, heading: 1, width: 7, length: 6, height: 2, spacing: 3 },
      depotId: depot.id,
      turtleId: t.turtleId!,
      policy: {},
    });
    expect(job.segments.length).toBe(5); // tunnels at z -3, 0, 3 + 2 passages
    server.jobs.start(job.id);
    const done = await finish(server, job.id, 60000);
    expect(done.error).toBeUndefined();
    expect(done.status).toBe('completed');
    const clear = (x: number, z: number) => [100, 101].every((y) => world.get(x, y, z) === null);
    for (let x = 2; x <= 7; x++) for (const z of [-3, 0, 3]) expect(clear(x, z), `tunnel ${x},${z}`).toBe(true);
    // Passages: far end (x=7) between the first two, near end (x=2) between the last two.
    for (const z of [-2, -1]) expect(clear(7, z), `passage 7,${z}`).toBe(true);
    for (const z of [1, 2]) expect(clear(2, z), `passage 2,${z}`).toBe(true);
    // Everything else between the tunnels is still rock.
    for (const z of [-2, -1]) for (let x = 2; x <= 6; x++) expect(world.get(x, 100, z)?.name, `${x},${z}`).toBe('minecraft:stone');
    for (const z of [1, 2]) for (let x = 3; x <= 7; x++) expect(world.get(x, 100, z)?.name, `${x},${z}`).toBe('minecraft:stone');
    expect(world.spilled).toBe(0);
  }, 90000);

  it('quarry: clears a box top-down in layers and leaves the floor below', async () => {
    const { server, world, depot } = await setup();
    const t = await sim(server, world, { fuel: 800 });
    const job = server.jobs.createJob({
      name: 'Pit',
      strategy: 'quarry',
      params: { origin: { x: 2, y: 103, z: 0 }, heading: 1, width: 3, length: 3, depth: 4 },
      depotId: depot.id,
      turtleId: t.turtleId!,
      policy: {},
    });
    expect(job.segments.map((s) => [s.origin.y, s.height])).toEqual([
      [101, 3],
      [100, 1],
    ]);
    server.jobs.start(job.id);
    const done = await finish(server, job.id, 60000);
    expect(done.error).toBeUndefined();
    expect(done.status).toBe('completed');
    for (let x = 2; x <= 4; x++) for (let z = 0; z <= 2; z++) for (let y = 100; y <= 103; y++) expect(world.get(x, y, z), `${x},${y},${z}`).toBeNull();
    for (let x = 2; x <= 4; x++) expect(world.get(x, 99, 1)?.name).toBe('minecraft:stone');
  }, 90000);
});

describe('wall scanning and vein following', () => {
  it('scanWalls maps every block around the tunnel: both wall rows, ceiling, floor and the far end', async () => {
    const { server, world, depot } = await setup();
    const t = await sim(server, world, { fuel: 800 });
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 6 }, { scanWalls: true }));
    server.jobs.start(job.id);
    expect((await finish(server, job.id)).status).toBe('completed');
    const map = server.fleet.queryMap({ world: 'sim', dimension: 'minecraft:overworld', x0: 2, x1: 8, z0: -1, z1: 1, y0: 99, y1: 102 });
    const at = (x: number, y: number, z: number) => map.blocks.find((c) => c.x === x && c.y === y && c.z === z)?.block;
    for (let x = 2; x <= 7; x++) {
      for (const y of [100, 101]) for (const z of [-1, 1]) expect(at(x, y, z), `wall ${x},${y},${z}`).toBe('minecraft:stone');
      expect(at(x, 102, 0), `ceiling ${x}`).toBe('minecraft:stone');
      expect(at(x, 99, 0), `floor ${x}`).toBe('minecraft:stone');
    }
    for (const y of [100, 101]) expect(at(8, y, 0), `end ${y}`).toBe('minecraft:stone');
    expect(allClear(world, 1, 2, 6)).toBe('clear');
  });

  it('follows a diamond vein out of the tunnel, mines only the ore, and comes back', async () => {
    const { server, world, depot } = await setup();
    const vein = [
      [5, 101, -1],
      [5, 102, -1],
      [5, 101, -2],
      [6, 101, -2],
    ];
    for (const [x, y, z] of vein) world.set(x, y, z, { name: 'minecraft:diamond_ore' });
    const t = await sim(server, world, { fuel: 800 });
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 8 }, { scanWalls: true, veins: { ores: ['diamond_ore'], maxBlocks: 16, reach: 4 } }));
    server.jobs.start(job.id);
    const done = await finish(server, job.id, 60000);
    expect(done.error).toBeUndefined();
    expect(done.status).toBe('completed');
    for (const [x, y, z] of vein) expect(world.get(x, y, z), `${x},${y},${z}`).toBeNull();
    expect(done.progress.finds?.['minecraft:diamond_ore']).toBe(4);
    expect(done.progress.veinBlocks).toBe(4);
    // Nothing but the ore was dug outside the tunnel.
    for (const [x, y, z] of [
      [4, 101, -1],
      [6, 101, -1],
      [5, 101, -3],
      [7, 101, -2],
      [5, 100, -1],
    ])
      expect(world.get(x, y, z)?.name, `${x},${y},${z}`).toBe('minecraft:stone');
    expect(allClear(world, 1, 2, 8)).toBe('clear');
    expect(world.inventories.get('-1,100,0')!.some((s) => s?.name === 'minecraft:diamond' && s.count === 4)).toBe(true);
  }, 90000);
});

describe('vein ownership', () => {
  it('ignores ores reported by other turtles; only follows what its own turtle saw', async () => {
    const { server, world, depot } = await setup();
    // Another turtle's passage beside the tunnel, with a diamond only that turtle saw.
    for (const z of [-1, -2, -3]) world.set(6, 100, z, null);
    world.set(5, 100, -3, { name: 'minecraft:diamond_ore' });
    server.fleet.importObservations(
      'sim',
      'minecraft:overworld',
      [{ x: 6, y: 100, z: -1 }, { x: 6, y: 100, z: -2 }, { x: 6, y: 100, z: -3 }, { x: 5, y: 100, z: -3, name: 'minecraft:diamond_ore' }],
      't_someone_else',
    );
    // Next to the tunnel: its own scan finds this one.
    world.set(3, 101, -1, { name: 'minecraft:diamond_ore' });
    const t = await sim(server, world, { fuel: 800 });
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 6 }, { scanWalls: true, veins: { ores: ['diamond_ore'], maxBlocks: 16, reach: 4 } }));
    server.jobs.start(job.id);
    const done = await finish(server, job.id, 60000);
    expect(done.status).toBe('completed');
    expect(world.get(3, 101, -1), 'own find').toBeNull();
    expect(world.get(5, 100, -3)?.name, "another turtle's find").toBe('minecraft:diamond_ore');
    expect(done.progress.veinBlocks).toBe(1);
  }, 90000);
});

describe('agent version gate', () => {
  it('jobs need agent 0.3.0+ (verified unloading, dig protection)', async () => {
    const { agentSupportsJobs } = await import('../src/jobs/runner');
    expect(agentSupportsJobs('lua-0.2.0')).toBe(false);
    expect(agentSupportsJobs('lua-0.3.0')).toBe(true);
    expect(agentSupportsJobs('sim-0.3.0')).toBe(true);
    expect(agentSupportsJobs('lua-1.0.0')).toBe(true);
    expect(agentSupportsJobs('')).toBe(false);
  });
});

describe('torches', () => {
  const torchesIn = (inv: ({ name: string; count: number } | null)[] | undefined) => (inv ?? []).reduce((n, s) => n + (s?.name === 'minecraft:torch' ? s.count : 0), 0);

  it('fetches torches from the fuel chest, lights the tunnel floor every N blocks, and gives back the rest', async () => {
    const { server, world, depot } = await setup({ fuelChest: true });
    // Torches first: a turtle can only take the chest's first stack, so it has to set the
    // extra torches aside to reach the coal, and put them back.
    const fuelChest = world.inventories.get('0,99,0')!;
    fuelChest[0] = { name: 'minecraft:torch', count: 64 };
    fuelChest[1] = { name: 'minecraft:coal', count: 32 };
    const t = await sim(server, world, { fuel: 300 });
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 24 }, { refuelTarget: 800, torches: { enabled: true, spacing: 8 } }));
    server.jobs.start(job.id);
    const done = await finish(server, job.id, 60000);
    expect(done.error).toBeUndefined();
    expect(done.status).toBe('completed');
    // On the floor row (the turtle walks in the row above), 8 apart, nothing else dug away.
    const placed = Array.from({ length: 24 }, (_, d) => 2 + d).filter((x) => world.get(x, 100, 0)?.name === 'minecraft:torch');
    expect(placed).toHaveLength(3);
    for (let i = 1; i < placed.length; i++) expect(placed[i] - placed[i - 1]).toBeGreaterThanOrEqual(8);
    expect(Array.from({ length: 24 }, (_, d) => world.get(2 + d, 101, 0)).filter(Boolean)).toEqual([]);
    expect(done.progress.torchesPlaced).toBe(3);
    // It took only what the job needed, kept them through unloading, and put the rest back.
    expect(torchesIn(world.inventories.get('-1,100,0'))).toBe(0);
    expect(torchesIn(fuelChest) + torchesIn(t.body.slots) + placed.length).toBe(64);
    expect(torchesIn(fuelChest)).toBeGreaterThanOrEqual(60);
    expect(fuelChest.reduce((n, s) => n + (s?.name === 'minecraft:coal' ? s.count : 0), 0)).toBeLessThan(32);
    expect(world.spilled).toBe(0);
  });

  it('torches in the fuel chest are left alone (not "contamination") when a job does not place them', async () => {
    const { server, world, depot } = await setup({ fuelChest: true });
    const fuelChest = world.inventories.get('0,99,0')!;
    fuelChest[0] = { name: 'minecraft:torch', count: 64 };
    fuelChest[1] = { name: 'minecraft:coal', count: 32 };
    const t = await sim(server, world, { fuel: 140 });
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 8 }, { fuelReserve: 120, refuelTarget: 800 }));
    server.jobs.start(job.id);
    const done = await finish(server, job.id);
    expect(done.error).toBeUndefined();
    expect(done.status).toBe('completed');
    expect(torchesIn(fuelChest)).toBe(64);
    expect(torchesIn(t.body.slots)).toBe(0);
    expect(typeof t.body.fuel === 'number' && t.body.fuel > 500).toBe(true);
  });

  it('a quarry only lights its bottom floor (the floors above are dug away)', async () => {
    const { server, world, depot } = await setup({ chestSize: 54 });
    const t = await sim(server, world, { fuel: 3000, slots: slots({ 2: { name: 'minecraft:torch', count: 16 } }) });
    const job = server.jobs.createJob({
      name: 'Quarry',
      strategy: 'quarry',
      params: { origin: { x: 2, y: 103, z: 0 }, heading: 1, width: 3, length: 6, depth: 6 },
      depotId: depot.id,
      turtleId: t.turtleId!,
      policy: { torches: { enabled: true, spacing: 4 } },
    });
    server.jobs.start(job.id);
    const done = await finish(server, job.id, 60000);
    expect(done.error).toBeUndefined();
    expect(done.status).toBe('completed');
    const torches: { x: number; y: number; z: number }[] = [];
    for (let x = 2; x < 8; x++) for (let y = 98; y <= 103; y++) for (let z = 0; z < 3; z++) if (world.get(x, y, z)?.name === 'minecraft:torch') torches.push({ x, y, z });
    expect(torches.length).toBeGreaterThanOrEqual(2);
    expect(torches.every((p) => p.y === 98)).toBe(true);
    for (const a of torches) for (const b of torches) if (a !== b) expect(Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z))).toBeGreaterThanOrEqual(4);
    expect(done.progress.torchesPlaced).toBe(torches.length);
  });

  it('over a cave it waits for floor again, instead of hanging a torch on a block it digs next', async () => {
    const { server, world, depot } = await setup();
    // Air under the first two floor cells: the turtle sees it while scanning the walls.
    world.set(2, 99, 0, null);
    world.set(3, 99, 0, null);
    const t = await sim(server, world, { fuel: 2000, slots: slots({ 2: { name: 'minecraft:torch', count: 16 } }) });
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 16 }, { scanWalls: true, torches: { enabled: true, spacing: 8 } }));
    server.jobs.start(job.id);
    const done = await finish(server, job.id, 60000);
    expect(done.error).toBeUndefined();
    expect(done.status).toBe('completed');
    expect(world.droppedTorches).toBe(0);
    const placed = Array.from({ length: 16 }, (_, d) => 2 + d).filter((x) => world.get(x, 100, 0)?.name.endsWith('torch'));
    expect(placed).toEqual([4, 12]);
    expect(placed.every((x) => world.get(x, 100, 0)?.name === 'minecraft:torch')).toBe(true);
    expect(server.fleet.recentEvents(500).filter((e) => e.message.includes("couldn't place"))).toEqual([]);
  });

  it('with no floor and no lasting wall, a hung torch is taken back and it tries a few blocks on', async () => {
    const { server, world, depot } = await setup();
    // A 3-wide tunnel over a cave: the middle column has no wall but the next slice.
    for (let x = 2; x < 18; x++) for (let z = 0; z < 3; z++) world.set(x, 99, z, null);
    const t = await sim(server, world, { fuel: 3000, slots: slots({ 2: { name: 'minecraft:torch', count: 32 } }) });
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { width: 3, length: 16 }, { torches: { enabled: true, spacing: 6 } }));
    server.jobs.start(job.id);
    const done = await finish(server, job.id, 90000);
    expect(done.error).toBeUndefined();
    expect(done.status).toBe('completed');
    expect(world.droppedTorches).toBe(0);
    // Whatever is left hangs on something outside the tunnel.
    for (let x = 2; x < 18; x++) for (let z = 0; z < 3; z++) {
      const b = world.get(x, 100, z);
      if (!b) continue;
      expect(b.name).toBe('minecraft:wall_torch');
      expect(z === 0 || z === 2).toBe(true);
    }
    // Retries are spread out, not one per block (48 floor cells).
    const failures = server.fleet.recentEvents(1000).filter((e) => e.message.includes('trying again a few blocks on')).length;
    expect(failures).toBeLessThanOrEqual(16);
  });

  it('out of torches, a dark spot counts once per spacing, not once per block', async () => {
    const { server, world, depot } = await setup();
    const t = await sim(server, world, { fuel: 2000 });
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 24 }, { torches: { enabled: true, spacing: 8 } }));
    server.jobs.start(job.id);
    const done = await finish(server, job.id, 60000);
    expect(done.status).toBe('completed');
    expect(done.progress.torchesPlaced ?? 0).toBe(0);
    expect(done.progress.torchesMissed).toBe(3);
  });

  it('tops up the torch stack it carries instead of starting a new slot', async () => {
    const { server, world, depot } = await setup({ fuelChest: true });
    const fuelChest = world.inventories.get('0,99,0')!;
    // Two small stacks: it can only take the first one at a time.
    fuelChest[0] = { name: 'minecraft:torch', count: 5 };
    fuelChest[1] = { name: 'minecraft:torch', count: 40 };
    const t = await sim(server, world, { fuel: 3000 });
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 200 }, { refuelTarget: 100, torches: { enabled: true, spacing: 8 } }));
    server.jobs.start(job.id);
    await waitFor(() => (server.jobs.getJob(job.id)?.progress.trips ?? 0) >= 1, 30000, 'the torch trip');
    server.jobs.pause(job.id);
    await waitFor(() => server.jobs.getJob(job.id)?.status === 'paused', 30000, 'pause');
    const torchSlots = t.body.slots.filter((s) => s?.name === 'minecraft:torch');
    expect(torchSlots).toHaveLength(1);
    expect(torchSlots[0]!.count).toBe(25);
  });

  it('knows which block a torch hangs on', async () => {
    const { torchSupport } = await import('../src/jobs/runner');
    const c = { x: 5, y: 10, z: 5 };
    expect(torchSupport(c, { name: 'minecraft:torch' })).toEqual({ x: 5, y: 9, z: 5 });
    expect(torchSupport(c, { name: 'minecraft:wall_torch', state: { facing: 'north' } })).toEqual({ x: 5, y: 10, z: 6 });
    expect(torchSupport(c, { name: 'minecraft:wall_torch', state: { facing: 'east' } })).toEqual({ x: 4, y: 10, z: 5 });
    expect(torchSupport(c, { name: 'minecraft:wall_torch' })).toBeUndefined();
    expect(torchSupport(c, { name: 'minecraft:stone' })).toBeUndefined();
  });

  it('needs agent 0.3.2 to place torches', async () => {
    const { agentSupportsTorches } = await import('../src/jobs/runner');
    expect(agentSupportsTorches('lua-0.3.1')).toBe(false);
    expect(agentSupportsTorches('lua-0.3.2')).toBe(true);
    expect(agentSupportsTorches('sim-0.4.0')).toBe(true);
    expect(agentSupportsTorches('lua-1.0.0')).toBe(true);
  });
});
