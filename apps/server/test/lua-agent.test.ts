/**
 * Runs the REAL Lua agent and installer (turtle/) inside the CC host (wasmoon, Lua 5.4)
 * against the real backend. This is still simulator verification: it checks the
 * agent's logic and protocol use, not compatibility with Minecraft or CC's Cobalt VM.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import luaparse from 'luaparse';
import type { CCTurtle, TurtleBody } from '@ccfleet/sim';
import { TURTLE_DIR, openWorld, settle, spawnLuaTurtle, startServer, waitFor } from './helpers';

type Server = Awaited<ReturnType<typeof startServer>>;
let server: Server | undefined;
const turtles: CCTurtle[] = [];

afterEach(async () => {
  for (const t of turtles.splice(0)) t.shutdown();
  await server?.close();
  server = undefined;
});

async function setup() {
  server = await startServer();
  return { server, world: openWorld() };
}
async function spawn(...args: Parameters<typeof spawnLuaTurtle>) {
  const t = await spawnLuaTurtle(...args);
  turtles.push(t);
  return t;
}
const cmd = (s: Server, id: string, op: string, args: Record<string, unknown> = {}) => settle(s, s.fleet.issueCommand({ turtleIds: [id] }, op, args).id);

describe('Lua agent: syntax', () => {
  it('every Lua file parses as Lua 5.1 (CC: Tweaked rejects newer syntax such as goto and //)', () => {
    const files = [join(TURTLE_DIR, 'install.lua'), ...readdirSync(join(TURTLE_DIR, 'fleet')).map((f) => join(TURTLE_DIR, 'fleet', f))];
    for (const f of files.filter((f) => f.endsWith('.lua'))) {
      expect(() => luaparse.parse(readFileSync(f, 'utf8'), { luaVersion: '5.1' }), f).not.toThrow();
    }
  });
});

describe('Lua agent: install, pairing, telemetry', () => {
  it('installs from the backend, pairs with a one-time code, reports a calibrated pose', async () => {
    const { server, world } = await setup();
    const t = await spawn(server, world, { x: 5, y: 100, z: -3, heading: 1 });
    const v = server.fleet.getTurtle(t.turtleId)!;
    expect(v.simulated).toBe(true);
    expect(v.agentVersion).toMatch(/^lua-/);
    expect(v.state?.pose).toMatchObject({ pos: { x: 5, y: 100, z: -3 }, heading: 1, position: 'known', source: 'manual' });
    expect(t.files.has('fleet/agent.lua') && t.files.has('startup.lua')).toBe(true);
    expect(t.files.has('fleet/enroll.json')).toBe(false); // code consumed
    expect(t.label).toBe(v.name); // labelled so it keeps its files when picked up
    expect(t.state.creds.turtleId).toBe(t.turtleId);
  });

  it('reports equipped upgrades, e.g. an Advanced Peripherals Chunk Controller ("chunky")', async () => {
    const { server, world } = await setup();
    const chunky = await spawn(server, world, { x: 0, y: 100, z: 0 }, { upgrades: { left: 'chunky' } });
    const plain = await spawn(server, world, { x: 3, y: 100, z: 0 });
    expect(server.fleet.getTurtle(chunky.turtleId)?.state?.upgrades).toEqual({ left: 'chunky' });
    expect(server.fleet.getTurtle(plain.turtleId)?.state?.upgrades).toEqual({});
  });

  it('a turtle installed without calibration reports an unknown pose and can be calibrated', async () => {
    const { server, world } = await setup();
    const t = await spawn(server, world, { x: 0, y: 100, z: 0 }, { calibrate: false });
    expect(server.fleet.getTurtle(t.turtleId)?.state?.pose.position).toBe('unknown');
    const r = await cmd(server, t.turtleId, 'calibrate', { x: 0, y: 100, z: 0, heading: 2 });
    expect(r.items[0].status).toBe('succeeded');
    expect(server.fleet.getTurtle(t.turtleId)?.state?.pose).toMatchObject({ position: 'known', heading: 2 });
  });

  it('re-running the installer without a code updates files and keeps the identity', async () => {
    const { server, world } = await setup();
    const t = await spawn(server, world, { x: 0, y: 100, z: 0 });
    const id = t.turtleId;
    // Installed before the project was renamed: still our launcher, so no backup.
    t.files.set('startup.lua', '-- CC Fleet launcher (installed as /startup.lua). Restarts the agent if it crashes.\n');
    t.files.set('install.lua', await (await fetch(`${server.baseUrl}/turtle/install.lua`)).text());
    await t.boot('install.lua', []);
    await waitFor(() => server.fleet.getTurtle(id)?.connection === 'online' && t.status === 'running', 5000);
    expect(server.fleet.listTurtles()).toHaveLength(1);
    expect(t.state.creds.turtleId).toBe(id);
    await waitFor(() => t.files.get('startup.lua')?.includes('CC Orchestra launcher'), 5000, 'the new launcher');
    expect(t.files.has('startup.lua.bak')).toBe(false);
  });
});

describe('Lua agent: placing', () => {
  it('places a torch on the floor below, maps it, and fails cleanly where there is no room', async () => {
    const { server, world } = await setup();
    world.set(0, 99, 0, null);
    world.set(0, 98, 0, { name: 'minecraft:stone' });
    const slots: TurtleBody['slots'] = Array(16).fill(null);
    slots[1] = { name: 'minecraft:torch', count: 64 };
    const t = await spawn(server, world, { x: 0, y: 100, z: 0, heading: 0 }, { slots });
    const r = await cmd(server, t.turtleId, 'place', { dir: 'down', slot: 2 });
    expect(r.items[0]).toMatchObject({ status: 'succeeded', data: { item: 'minecraft:torch' } });
    expect(world.get(0, 99, 0)?.name).toBe('minecraft:torch');
    expect(t.body.slots[1]?.count).toBe(63);
    await waitFor(() => server.fleet.mapCell('sim', 'minecraft:overworld', { x: 0, y: 99, z: 0 })?.block === 'minecraft:torch', 3000, 'torch on the map');
    const again = await cmd(server, t.turtleId, 'place', { dir: 'down', slot: 2 });
    expect(again.items[0]).toMatchObject({ status: 'failed', reason: 'Cannot place block here' });
    expect((await cmd(server, t.turtleId, 'place', { dir: 'down', slot: 5 })).items[0]).toMatchObject({ status: 'failed', reason: 'slot 5 is empty' });
  });
});

describe('Lua agent: Geo Scanner', () => {
  it('maps every block within the radius, and the air around them, from one scan', async () => {
    const { server, world } = await setup();
    // A diamond 3 blocks away and a cave pocket 2 blocks away, among stone.
    for (let x = -3; x <= 3; x++) for (let y = 97; y <= 103; y++) for (let z = -3; z <= 3; z++) world.set(x, y, z, { name: 'minecraft:stone' });
    world.set(0, 100, 0, null);
    world.set(3, 98, -1, { name: 'minecraft:diamond_ore' });
    world.set(-2, 101, 2, null);
    const t = await spawn(server, world, { x: 0, y: 100, z: 0, heading: 0 }, { upgrades: { left: 'geoScanner' } });
    expect(server.fleet.getTurtle(t.turtleId)?.state?.upgrades).toEqual({ left: 'geoScanner' });
    const r = await cmd(server, t.turtleId, 'geoScan', { radius: 3 });
    expect(r.items[0]).toMatchObject({ status: 'succeeded', data: { center: { x: 0, y: 100, z: 0 }, radius: 3, count: 7 * 7 * 7 - 2 } });
    const cell = (x: number, y: number, z: number) => server.fleet.mapCell('sim', 'minecraft:overworld', { x, y, z });
    await waitFor(() => cell(-2, 101, 2)?.cell === 'empty', 3000, 'scanned air');
    expect(cell(3, 98, -1)).toMatchObject({ block: 'minecraft:diamond_ore', cell: 'solid' });
    expect(cell(-3, 103, 3)).toMatchObject({ block: 'minecraft:stone' });
    expect(cell(0, 100, 0)?.cell).toBe('empty'); // the turtle itself is not a block on the map
    expect(server.fleet.findOres('sim', 'minecraft:overworld').map((b) => b.block)).toEqual(['minecraft:diamond_ore']);
    // AP's 2 s cooldown (shortened in the simulator).
    expect((await cmd(server, t.turtleId, 'geoScan', { radius: 3 })).items[0]).toMatchObject({ status: 'failed', reason: 'scanBlocks is on cooldown' });
  });

  it('without a Geo Scanner it says so', async () => {
    const { server, world } = await setup();
    const t = await spawn(server, world, { x: 0, y: 100, z: 0, heading: 0 });
    expect((await cmd(server, t.turtleId, 'geoScan', { radius: 8 })).items[0]).toMatchObject({ status: 'failed', code: 'no_scanner' });
  });
});

describe('Lua agent: manual control', () => {
  it('moves, tracks pose, digs, fails cleanly on obstruction, and maps what it sees', async () => {
    const { server, world } = await setup();
    world.set(0, 100, -2, { name: 'minecraft:stone' });
    world.set(0, 99, 0, { name: 'minecraft:coal_ore' });
    const t = await spawn(server, world, { x: 0, y: 100, z: 0, heading: 0 });

    expect((await cmd(server, t.turtleId, 'forward')).items[0].status).toBe('succeeded');
    expect(server.fleet.getTurtle(t.turtleId)?.state).toMatchObject({ pose: { pos: { x: 0, y: 100, z: -1 } }, fuel: 99 });
    const blocked = await cmd(server, t.turtleId, 'forward');
    expect(blocked.items[0]).toMatchObject({ status: 'failed', code: 'obstructed', reason: 'Movement obstructed' });
    expect(server.fleet.getTurtle(t.turtleId)?.state?.pose.pos).toEqual({ x: 0, y: 100, z: -1 });
    expect(server.fleet.getTurtle(t.turtleId)?.status).toBe('blocked');

    const dug = await cmd(server, t.turtleId, 'dig');
    expect(dug.items[0]).toMatchObject({ status: 'succeeded', data: { block: 'minecraft:stone' } });
    expect(server.fleet.getTurtle(t.turtleId)?.state?.inventory).toEqual([{ slot: 1, name: 'minecraft:cobblestone', count: 1 }]);

    const map = server.fleet.queryMap({ world: 'sim', dimension: 'minecraft:overworld', x0: -1, x1: 1, z0: -3, z1: 1, y0: 98, y1: 101 });
    const at = (x: number, y: number, z: number) => map.blocks.find((b) => b.x === x && b.y === y && b.z === z);
    expect(at(0, 100, -1)?.cell).toBe('empty'); // traversed
    expect(at(0, 100, -2)?.cell).toBe('empty'); // dug, then re-inspected

    const inspect = await cmd(server, t.turtleId, 'turnRight');
    expect(inspect.items[0].status).toBe('succeeded');
    expect(server.fleet.getTurtle(t.turtleId)?.state?.pose.heading).toBe(1);
  });

  it('refuses invalid arguments and unknown operations on the turtle side too', async () => {
    const { server, world } = await setup();
    const t = await spawn(server, world, { x: 0, y: 100, z: 0 });
    // Bypass server validation to prove the agent validates independently.
    const rec = (server.fleet as any).turtles.get(t.turtleId);
    const replies: any[] = [];
    const orig = (server.fleet as any).ack.bind(server.fleet);
    (server.fleet as any).ack = (...a: any[]) => (replies.push(a), orig(...a));
    rec.conn.send({ v: 1, type: 'cmd', id: 'x', ts: Date.now(), commandId: 'c_bad1', op: 'select', args: { slot: 99 }, expiresAt: Date.now() + 10000, executor: 'manual' });
    rec.conn.send({ v: 1, type: 'cmd', id: 'y', ts: Date.now(), commandId: 'c_bad2', op: 'runLua', args: {}, expiresAt: Date.now() + 10000, executor: 'manual' });
    rec.conn.send({ v: 1, type: 'cmd', id: 'z', ts: Date.now(), commandId: 'c_old', op: 'forward', args: {}, expiresAt: Date.now() - 60000, executor: 'manual' });
    await waitFor(() => replies.length >= 3, 3000);
    expect(replies.map((r) => [r[1], r[2], r[3]])).toEqual([
      ['c_bad1', 'rejected', 'invalid'],
      ['c_bad2', 'rejected', 'invalid'],
      ['c_old', 'rejected', 'expired'],
    ]);
    expect(t.body.pos).toEqual({ x: 0, y: 100, z: 0 });
  });

  it('a re-delivered command is not executed twice', async () => {
    const { server, world } = await setup();
    const t = await spawn(server, world, { x: 0, y: 100, z: 0, heading: 0 }, { opMs: 80 });
    const b = server.fleet.issueCommand({ turtleIds: [t.turtleId] }, 'forward', {});
    await waitFor(() => server.fleet.getBatch(b.id)?.items[0].status === 'running');
    server.fleet.redeliver(b.items[0].commandId!);
    await settle(server, b.id);
    server.fleet.redeliver(b.items[0].commandId!);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.body.pos).toEqual({ x: 0, y: 100, z: -1 });
    expect(t.body.fuel).toBe(99);
  });
});

describe('Lua agent: stop, reboot and connection loss', () => {
  it('e-stop finishes the atomic op, holds across a reboot, and resumes', async () => {
    const { server, world } = await setup();
    const t = await spawn(server, world, { x: 0, y: 100, z: 0 }, { opMs: 250 });
    // Let the boot-time scan finish first. (A stop that arrives before a command
    // starts makes the agent refuse it with "held", which is also correct.)
    await new Promise((r) => setTimeout(r, 300));
    const move = server.fleet.issueCommand({ turtleIds: [t.turtleId] }, 'forward', {});
    await waitFor(() => server.fleet.getBatch(move.id)?.items[0].status === 'running');
    const stop = await settle(server, server.fleet.stop({ turtleIds: [t.turtleId] }, 'estop').id, ['stopped', 'unreachable']);
    expect(stop.items[0].status).toBe('stopped');
    expect((await settle(server, move.id)).items[0].status).toBe('succeeded');
    expect(t.body.pos.z).toBe(-1);

    await t.reboot();
    await waitFor(() => server.fleet.getTurtle(t.turtleId)?.connection === 'offline', 3000, 'drop on reboot');
    await waitFor(() => server.fleet.getTurtle(t.turtleId)?.connection === 'online' && server.fleet.getTurtle(t.turtleId)?.state?.hold, 8000, 'reconnect after reboot');
    const refused = await cmd(server, t.turtleId, 'forward');
    expect(refused.items[0]).toMatchObject({ status: 'rejected', code: 'held' });

    const res = await settle(server, server.fleet.resume({ turtleIds: [t.turtleId] }).id, ['released', 'unreachable']);
    expect(res.items[0].status).toBe('released');
    expect((await cmd(server, t.turtleId, 'forward')).items[0].status).toBe('succeeded');
  });

  it('reboot between the physical move and saving it: fuel evidence settles the position', async () => {
    const { server, world } = await setup();
    const t = await spawn(server, world, { x: 0, y: 100, z: 0, heading: 0 });
    let once = true;
    t.faults.crashAfterPhysicalMove = () => {
      const c = once;
      once = false;
      return c;
    };
    const b = server.fleet.issueCommand({ turtleIds: [t.turtleId] }, 'forward', {});
    const item = await waitFor(() => {
      const i = server.fleet.getBatch(b.id)?.items[0];
      return i?.status === 'succeeded' ? i : undefined;
    }, 10000, 'reconciled result');
    expect(item.reason).toMatch(/resolved after reconnect/);
    expect(server.fleet.getTurtle(t.turtleId)?.state?.pose).toMatchObject({ pos: { x: 0, y: 100, z: -1 }, position: 'known' });
  });

  it('with unlimited fuel an interrupted move leaves the position uncertain until a GPS fix', async () => {
    const { server, world } = await setup();
    const t = await spawn(server, world, { x: 0, y: 100, z: 0, heading: 0 }, { fuel: 'unlimited', gps: true });
    let once = true;
    t.faults.crashAfterPhysicalMove = () => {
      const c = once;
      once = false;
      return c;
    };
    const b = server.fleet.issueCommand({ turtleIds: [t.turtleId] }, 'forward', {});
    await waitFor(() => server.fleet.getTurtle(t.turtleId)?.state?.pose.position === 'uncertain', 10000, 'uncertain pose');
    expect(server.fleet.getTurtle(t.turtleId)?.state?.pose.candidates).toEqual([
      { x: 0, y: 100, z: 0 },
      { x: 0, y: 100, z: -1 },
    ]);
    expect(server.fleet.getBatch(b.id)?.items[0].status).toBe('unknown');
    const fix = await cmd(server, t.turtleId, 'gpsLocate');
    expect(fix.items[0]).toMatchObject({ status: 'succeeded', data: { x: 0, y: 100, z: -1, agreedWithTracking: false } });
    expect(server.fleet.getTurtle(t.turtleId)?.state?.pose).toMatchObject({ position: 'known', source: 'gps', heading: 0 });
  });

  it('GPS without a modem fails with an actionable error', async () => {
    const { server, world } = await setup();
    const t = await spawn(server, world, { x: 0, y: 100, z: 0 });
    const r = await cmd(server, t.turtleId, 'gpsLocate');
    expect(r.items[0]).toMatchObject({ status: 'failed', code: 'no_gps' });
  });

  it('link lost after the ack: outcome unknown, then reconciled from the agent record', async () => {
    const { server, world } = await setup();
    const t = await spawn(server, world, { x: 0, y: 100, z: 0, heading: 0 }, { opMs: 100 });
    let once = true;
    t.faults.dropAfterSend = (m) => {
      if (m.type === 'ack' && once) {
        once = false;
        return true;
      }
      return false;
    };
    const b = server.fleet.issueCommand({ turtleIds: [t.turtleId] }, 'forward', {});
    await waitFor(() => server.fleet.getBatch(b.id)?.items[0].status === 'unknown', 5000, 'unknown');
    await waitFor(() => server.fleet.getBatch(b.id)?.items[0].status === 'succeeded', 10000, 'reconciled after reconnect');
    expect(t.body.pos).toEqual({ x: 0, y: 100, z: -1 });
    expect(server.fleet.getTurtle(t.turtleId)?.state?.pose.pos).toEqual({ x: 0, y: 100, z: -1 });
  });
});
