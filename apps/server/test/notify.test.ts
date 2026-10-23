/**
 * Chat notifications: the notifier itself, and the job events that use it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SimTurtle } from '@ccfleet/sim';
import { Notifier } from '../src/notify';
import { fill, openWorld, spawnTurtle, startServer, waitFor } from './helpers';

type Server = Awaited<ReturnType<typeof startServer>>;
let server: Server | undefined;
let hook: HttpServer | undefined;
const sims: SimTurtle[] = [];

afterEach(async () => {
  for (const t of sims.splice(0)) t.stop();
  await server?.close();
  server = undefined;
  await new Promise<void>((r) => (hook ? hook.close(() => r()) : r()));
  hook = undefined;
});

/** A local webhook that records what it receives. */
async function webhook(): Promise<{ url: string; got: { content: string; text: string }[] }> {
  const got: { content: string; text: string }[] = [];
  hook = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push(JSON.parse(body));
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => hook!.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`, got };
}

describe('Notifier', () => {
  it('sends Discord- and Slack-style text, one at a time, and collapses a burst', async () => {
    const sent: string[] = [];
    const n = new Notifier('http://example.invalid/hook', () => {}, async (_url, body) => (sent.push(JSON.parse(body).content), { ok: true, status: 204 }), 0);
    for (let i = 1; i <= 25; i++) n.send(`message ${i}`);
    await n.flush();
    // The first goes out at once; 20 more wait; the other 4 become one line.
    expect(sent).toHaveLength(22);
    expect(sent[0]).toBe('message 1');
    expect(sent[20]).toBe('message 21');
    expect(sent[21]).toBe("…and 4 more (see the dashboard's activity log)");
  });

  it('says once that delivery fails, and again when it works', async () => {
    const logs: string[] = [];
    let ok = false;
    const n = new Notifier('http://example.invalid/hook', (_l, m) => logs.push(m), async () => ({ ok, status: ok ? 204 : 404 }), 0);
    n.send('a');
    n.send('b');
    await n.flush();
    ok = true;
    n.send('c');
    await n.flush();
    expect(logs).toEqual(['Notification not delivered (HTTP 404); check NOTIFY_WEBHOOK_URL', 'Notifications are being delivered again']);
  });

  it('is off without a URL', () => {
    expect(new Notifier(undefined, () => {}).enabled).toBe(false);
  });
});

describe('job notifications', () => {
  it('a completed job and one that needs attention are reported; the test button works', async () => {
    const wh = await webhook();
    server = await startServer({ notifyUrl: wh.url });
    const world = openWorld();
    fill(world, { x: 2, y: 97, z: -4 }, { x: 20, y: 106, z: 4 }, 'minecraft:stone');
    world.placeChest({ x: -1, y: 100, z: 0 }, 54);
    const home = server.jobs.saveDepot({ name: 'Home', world: 'sim', dimension: 'minecraft:overworld', dock: { x: 0, y: 100, z: 0 }, dockHeading: 3, unloadDir: 'front', waiting: [] });
    const t = await spawnTurtle(server, world, { x: 0, y: 100, z: 0, heading: 1 }, { opMs: 4, fuel: 1000 });
    sims.push(t);
    const tunnel = (name: string, depotId: string, z: number) => ({ name, depotId, turtleId: t.turtleId!, strategy: 'tunnel' as const, params: { origin: { x: 2, y: 100, z }, heading: 1 as const, width: 1, height: 2, length: 3 }, policy: {} });
    const ok = server.jobs.createJob(tunnel('Short tunnel', home.id, 0));
    server.jobs.start(ok.id);
    await waitFor(() => wh.got.some((m) => m.content.includes('completed')), 30000, 'completed message');
    expect(wh.got.find((m) => m.content.includes('completed'))).toEqual({
      content: '✅ [sim] Turtle 1: "Short tunnel" completed: 6 blocks.',
      text: '✅ [sim] Turtle 1: "Short tunnel" completed: 6 blocks.',
    });
    // A depot whose chest is missing: the job pauses and says why.
    const noChest = server.jobs.saveDepot({ name: 'Broken', world: 'sim', dimension: 'minecraft:overworld', dock: { x: 0, y: 100, z: 3 }, dockHeading: 3, unloadDir: 'front', waiting: [] });
    const bad = server.jobs.createJob(tunnel('Doomed', noChest.id, 3));
    server.jobs.start(bad.id);
    await waitFor(() => wh.got.some((m) => m.content.includes('needs attention')), 30000, 'needs-attention message');
    expect(wh.got.find((m) => m.content.includes('needs attention'))!.content).toMatch(/^⚠️ \[sim\] Turtle 1: "Doomed" needs attention: No chest in front of the dock/);
    const r = await fetch(`${server.baseUrl}/api/notify/test`, { method: 'POST', headers: { cookie: await login(server) } });
    expect(r.status).toBe(200);
    await waitFor(() => wh.got.some((m) => m.content.includes('test notification')), 10000, 'test message');
  }, 60000);
});

async function login(s: Server): Promise<string> {
  const r = await fetch(`${s.baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
  return r.headers.get('set-cookie')!.split(';')[0];
}
