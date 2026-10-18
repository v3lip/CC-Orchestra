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
    expect(t.body.pos).toEqual({ x: 0, y: 100, z: 0 });
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

  it('handles falling gravel by re-digging', async () => {
    const { server, world, depot } = await setup();
    fill(world, { x: 4, y: 101, z: 0 }, { x: 4, y: 105, z: 0 }, 'minecraft:gravel');
    const t = await sim(server, world);
    const job = server.jobs.createJob(tunnel(t.turtleId!, depot.id, { length: 5 }));
    server.jobs.start(job.id);
    const done = await finish(server, job.id);
    expect(done.status).toBe('completed');
    expect(allClear(world, 1, 2, 5)).toBe('clear');
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
    const dir = mkdtempSync(join(tmpdir(), 'ccfleet-jobs-'));
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
