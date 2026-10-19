/**
 * HTTP/WebSocket surface: login is required, inputs are validated, history is pruned.
 */
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startServer } from './helpers';

type Server = Awaited<ReturnType<typeof startServer>>;
let server: Server | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function login(s: Server): Promise<string> {
  const r = await fetch(`${s.baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
  return r.headers.get('set-cookie')!.split(';')[0];
}

/** Open the dashboard socket; resolves with the first message, or why it closed. */
function uiSocket(s: Server, cookie?: string): Promise<{ first?: string; closed?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/ui`, { headers: cookie ? { cookie } : {} });
    ws.on('message', (d) => {
      resolve({ first: d.toString().slice(0, 40) });
      ws.close();
    });
    ws.on('unexpected-response', (_req, res) => resolve({ closed: res.statusCode }));
    ws.on('close', (code) => resolve({ closed: code }));
    ws.on('error', () => resolve({ closed: -1 }));
  });
}

describe('API', () => {
  it('the dashboard socket needs a login', async () => {
    server = await startServer();
    const anon = await uiSocket(server);
    expect(anon.first).toBeUndefined();
    const authed = await uiSocket(server, await login(server));
    expect(authed.first).toContain('"type":"init"');
  });

  it('rejects a bad events limit instead of passing it to SQL', async () => {
    server = await startServer();
    const cookie = await login(server);
    for (const limit of ['-1', 'abc', '0', '5000']) {
      const r = await fetch(`${server.baseUrl}/api/events?limit=${limit}`, { headers: { cookie } });
      expect(r.status, `limit=${limit}`).toBe(400);
    }
    const ok = await fetch(`${server.baseUrl}/api/events?limit=5`, { headers: { cookie } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).length).toBeLessThanOrEqual(5);
  });

  it('prunes command history older than two days and keeps recent rows', async () => {
    server = await startServer();
    const db = (server.fleet as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown } } }).db;
    const t = Date.now();
    const insert = db.prepare('INSERT INTO commands (id, batch_id, turtle_id, op, args_json, executor, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
    insert.run('c_old', null, 't_x', 'forward', '{}', 'job:j', 'succeeded', t - 3 * 24 * 3600_000, t - 3 * 24 * 3600_000);
    insert.run('c_new', null, 't_x', 'forward', '{}', 'job:j', 'succeeded', t - 3600_000, t - 3600_000);
    const r = server.fleet.prune(t);
    expect(r.commands).toBe(1);
    expect(db.prepare("SELECT count(*) n FROM commands WHERE id='c_new'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) n FROM commands WHERE id='c_old'").get()).toEqual({ n: 0 });
  });
});
