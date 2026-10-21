/**
 * Instances (one per Minecraft world/server): list, create, rename, delete.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SimTurtle } from '@ccfleet/sim';
import { openWorld, spawnTurtle, startServer, waitFor } from './helpers';

type Server = Awaited<ReturnType<typeof startServer>>;
let server: Server | undefined;
const sims: SimTurtle[] = [];

afterEach(async () => {
  for (const t of sims.splice(0)) t.stop();
  await server?.close();
  server = undefined;
});

async function login(s: Server): Promise<string> {
  const r = await fetch(`${s.baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
  return r.headers.get('set-cookie')!.split(';')[0];
}
async function api(s: Server, cookie: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${s.baseUrl}${path}`, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
}

describe('instances', () => {
  it('lists every world with counts, and an empty one can be created before pairing', async () => {
    server = await startServer();
    const cookie = await login(server);
    const world = openWorld();
    const t = await spawnTurtle(server, world, { x: 0, y: 64, z: 0 });
    sims.push(t);
    server.fleet.importObservations('old-save', 'minecraft:overworld', [{ x: 1, y: 2, z: 3, name: 'minecraft:stone' }], 'test');
    const created = await api(server, cookie, 'POST', '/api/instances', { name: 'New server' });
    expect(created.status).toBe(200);
    const list = (await api(server, cookie, 'GET', '/api/instances')).data as { name: string; turtles: number; online: number; mapBlocks: number }[];
    expect(list.map((i) => i.name)).toEqual(['New server', 'old-save', 'sim']);
    expect(list.find((i) => i.name === 'sim')).toMatchObject({ turtles: 1, online: 1 });
    expect(list.find((i) => i.name === 'old-save')).toMatchObject({ turtles: 0, mapBlocks: 1 });
    expect(list.find((i) => i.name === 'New server')).toMatchObject({ turtles: 0, mapBlocks: 0 });
    expect((await api(server, cookie, 'POST', '/api/instances', { name: 'bad/name' })).status).toBe(400);
  });

  it('rename moves turtles, map, depots and marked chunks; the turtle stays connected', async () => {
    server = await startServer();
    const cookie = await login(server);
    const world = openWorld();
    const t = await spawnTurtle(server, world, { x: 0, y: 64, z: 0 });
    sims.push(t);
    server.fleet.importObservations('sim', 'minecraft:overworld', [{ x: 5, y: 60, z: 5, name: 'minecraft:diamond_ore' }], 'test');
    const depot = server.jobs.saveDepot({ name: 'Home', world: 'sim', dimension: 'minecraft:overworld', dock: { x: 0, y: 64, z: 0 }, dockHeading: 3, unloadDir: 'front', waiting: [] });
    server.jobs.setForced('sim', 'minecraft:overworld', 0, 0, true);
    const r = await api(server, cookie, 'PATCH', '/api/instances/sim', { name: 'Server B' });
    expect(r.status).toBe(200);
    expect(server.fleet.getTurtle(t.turtleId!)?.world).toBe('Server B');
    expect(server.fleet.getTurtle(t.turtleId!)?.connection).toBe('online');
    expect(server.fleet.findOres('Server B', 'minecraft:overworld').length).toBe(1);
    expect(server.fleet.findOres('sim', 'minecraft:overworld').length).toBe(0);
    expect(server.jobs.listDepots().find((d) => d.id === depot.id)?.world).toBe('Server B');
    expect(server.jobs.listForced().map((c) => c.world)).toEqual(['Server B']);
    expect((r.data as { name: string }[]).map((i) => i.name)).toEqual(['Server B']);
  });

  it('delete is refused while its turtles are online, then removes everything and unpairs them', async () => {
    server = await startServer();
    const cookie = await login(server);
    const world = openWorld();
    const t = await spawnTurtle(server, world, { x: 0, y: 64, z: 0 });
    sims.push(t);
    server.jobs.saveDepot({ name: 'Home', world: 'sim', dimension: 'minecraft:overworld', dock: { x: 0, y: 64, z: 0 }, dockHeading: 3, unloadDir: 'front', waiting: [] });
    server.fleet.importObservations('sim', 'minecraft:overworld', [{ x: 1, y: 60, z: 1, name: 'minecraft:stone' }], 'test');
    expect((await api(server, cookie, 'DELETE', '/api/instances/sim')).status).toBe(409);
    t.stop();
    await waitFor(() => server!.fleet.getTurtle(t.turtleId!)?.connection === 'offline', 10000, 'turtle offline');
    const r = await api(server, cookie, 'DELETE', '/api/instances/sim');
    expect(r.status).toBe(200);
    expect(r.data).toEqual([]);
    expect(server.fleet.getTurtle(t.turtleId!)).toBeUndefined();
    expect(server.jobs.listDepots()).toEqual([]);
    expect(server.fleet.queryMap({ world: 'sim', dimension: 'minecraft:overworld', x0: -5, x1: 5, z0: -5, z1: 5, y0: 55, y1: 65 }).blocks).toEqual([]);
  });
});
