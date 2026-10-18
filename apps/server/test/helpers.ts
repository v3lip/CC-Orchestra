import type { AddressInfo } from 'node:net';
import type { Heading, Pose } from '@ccfleet/protocol';
import { InMemoryStore, SimTurtle, SimWorld, type MemoryStore, type TurtleBody } from '@ccfleet/sim';
import { buildApp } from '../src/app';
import type { Config } from '../src/config';
import { openDb } from '../src/db';

export const FAST = { staleMs: 600, offlineMs: 1500, resultTimeoutMs: 3000, tickMs: 50, heartbeatMs: 200 };

export function testConfig(dbFile = ':memory:'): Config {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir: '',
    dbFile,
    adminPassword: 'test-password',
    publicUrl: 'http://127.0.0.1',
    webDist: undefined,
    turtleDir: '/nonexistent',
    secureCookies: false,
  };
}

export async function startServer(opts: { dbFile?: string; port?: number } = {}) {
  const config = testConfig(opts.dbFile);
  const db = openDb(config.dbFile);
  const { app, fleet } = await buildApp(config, { db, fleet: FAST });
  await app.listen({ host: '127.0.0.1', port: opts.port ?? 0 });
  const port = (app.server.address() as AddressInfo).port;
  return { app, fleet, port, wsUrl: `ws://127.0.0.1:${port}/ws/turtle`, close: () => app.close() };
}

export function knownPose(x: number, y: number, z: number, heading: Heading): Pose {
  return { pos: { x, y, z }, heading, position: 'known', headingConfidence: 'known', source: 'manual' };
}

let nextComputer = 1;

/** Create, enrol and connect a simulated turtle; resolves once it is online with a snapshot. */
export async function spawnTurtle(
  server: Awaited<ReturnType<typeof startServer>>,
  world: SimWorld,
  at: { x: number; y: number; z: number; heading?: Heading },
  extra: { fuel?: number | 'unlimited'; store?: MemoryStore; opMs?: number; calibrated?: boolean } = {},
) {
  const heading = at.heading ?? 0;
  const body: TurtleBody = {
    pos: { x: at.x, y: at.y, z: at.z },
    heading,
    fuel: extra.fuel ?? 100,
    fuelLimit: extra.fuel === 'unlimited' ? 'unlimited' : 20000,
    slots: Array(16).fill(null),
    selected: 1,
  };
  const { code } = server.fleet.createEnrollment({ world: 'sim', simulated: true });
  const turtle = new SimTurtle({
    world,
    body,
    store: extra.store ?? new InMemoryStore(),
    serverUrl: server.wsUrl,
    computerId: nextComputer++,
    enrollCode: code,
    opMs: extra.opMs ?? 20,
    initialPose: extra.calibrated === false ? undefined : knownPose(at.x, at.y, at.z, heading),
    gps: true,
  });
  turtle.start();
  await waitFor(() => turtle.turtleId && server.fleet.getTurtle(turtle.turtleId)?.state && server.fleet.getTurtle(turtle.turtleId)?.connection === 'online');
  return turtle;
}

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000, label = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Wait until every item in a batch reaches one of the given statuses. */
export async function settle(server: Awaited<ReturnType<typeof startServer>>, batchId: string, done = ['succeeded', 'failed', 'cancelled', 'rejected', 'expired', 'undeliverable', 'unknown']) {
  return waitFor(() => {
    const b = server.fleet.getBatch(batchId);
    return b && b.items.every((i) => done.includes(i.status)) ? b : undefined;
  }, 8000, `batch ${batchId}`);
}

/** A world where y=100 and above is open air (generated terrain tops out near y=70). */
export function openWorld(): SimWorld {
  return new SimWorld(42);
}
