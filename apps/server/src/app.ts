import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { MAX_MESSAGE_BYTES, StopReason } from '@ccfleet/protocol';
import type { Config } from './config';
import { openDb, type Db } from './db';
import { ApiError, Fleet, type FleetOptions } from './fleet';
import { handleTurtleSocket } from './turtleSocket';
import { JobManager } from './jobs/manager';
import { digestEquals, now, randomToken, sha256 } from './util';

const SESSION_COOKIE = 'ccf_session';
const SESSION_TTL_MS = 7 * 24 * 3600_000;

const TargetsSchema = z.object({
  turtleIds: z.array(z.string()).max(500).optional(),
  groupIds: z.array(z.string()).max(100).optional(),
  all: z.boolean().optional(),
});

export async function buildApp(config: Config, opts: { fleet?: FleetOptions; db?: Db; logger?: boolean; turtleRateLimit?: number } = {}) {
  const db = opts.db ?? openDb(config.dbFile);
  const fleet = new Fleet(db, opts.fleet);
  const jobs = new JobManager(db, fleet);
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 256 * 1024 });

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES } });

  // ---------------------------------------------------------------- auth

  const sessionValid = (req: FastifyRequest): boolean => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return false;
    const row = db.prepare('SELECT expires_at FROM sessions WHERE token_hash=?').get(sha256(token)) as { expires_at: number } | undefined;
    return !!row && row.expires_at > now();
  };
  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!sessionValid(req)) return reply.code(401).send({ error: 'not logged in' });
  };

  let failedLogins = 0;
  let failedWindow = now();
  app.post('/api/auth/login', async (req, reply) => {
    if (now() - failedWindow > 60_000) {
      failedWindow = now();
      failedLogins = 0;
    }
    if (failedLogins >= 10) return reply.code(429).send({ error: 'too many attempts; wait a minute' });
    const body = z.object({ password: z.string().max(200) }).safeParse(req.body);
    if (!body.success || !digestEquals(sha256(body.data.password), sha256(config.adminPassword))) {
      failedLogins++;
      return reply.code(401).send({ error: 'wrong password' });
    }
    const token = randomToken();
    db.prepare('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?,?,?)').run(sha256(token), now(), now() + SESSION_TTL_MS);
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', path: '/', secure: config.secureCookies, maxAge: SESSION_TTL_MS / 1000 });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(token));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({ loggedIn: sessionValid(req) }));

  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues[0]?.message ?? 'invalid request' });
    const statusCode = (err as Error & { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) return reply.code(statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'internal error' });
  });

  // ---------------------------------------------------------------- authenticated API

  await app.register(async (api) => {
    api.addHook('preHandler', requireAuth);

    api.get('/api/info', async () => ({ publicUrl: config.publicUrl, worlds: fleet.worlds() }));

    api.get('/api/turtles', async () => fleet.listTurtles());

    api.patch('/api/turtles/:id', async (req) => {
      const { id } = req.params as { id: string };
      const body = z.object({ name: z.string().min(1).max(40).optional(), world: z.string().min(1).max(40).optional(), dimension: z.string().min(1).max(80).optional() }).parse(req.body);
      return fleet.updateTurtle(id, body);
    });

    api.delete('/api/turtles/:id', async (req) => {
      fleet.removeTurtle((req.params as { id: string }).id);
      return { ok: true };
    });

    api.post('/api/enrollments', async (req) => {
      const body = z
        .object({
          name: z.string().max(40).optional(),
          world: z.string().min(1).max(40).optional(),
          dimension: z.string().min(1).max(80).optional(),
          groupId: z.string().optional(),
          simulated: z.boolean().optional(),
          ttlMinutes: z.number().int().min(1).max(1440).optional(),
        })
        .parse(req.body ?? {});
      const r = fleet.createEnrollment(body);
      return { ...r, publicUrl: config.publicUrl };
    });

    api.get('/api/groups', async () => fleet.listGroups());
    api.post('/api/groups', async (req) => {
      const body = z.object({ name: z.string(), memberIds: z.array(z.string()).max(500).optional(), color: z.string().max(16).optional() }).parse(req.body);
      return fleet.createGroup(body.name, body.memberIds, body.color);
    });
    api.patch('/api/groups/:id', async (req) => {
      const body = z.object({ name: z.string().optional(), color: z.string().max(16).optional() }).parse(req.body);
      return fleet.updateGroup((req.params as { id: string }).id, body);
    });
    api.put('/api/groups/:id/members', async (req) => {
      const body = z.object({ memberIds: z.array(z.string()).max(500) }).parse(req.body);
      return fleet.setGroupMembers((req.params as { id: string }).id, body.memberIds);
    });
    api.delete('/api/groups/:id', async (req) => {
      fleet.deleteGroup((req.params as { id: string }).id);
      return { ok: true };
    });

    api.post('/api/commands', async (req) => {
      const body = z.object({ targets: TargetsSchema, op: z.string(), args: z.record(z.unknown()).optional(), ttlMs: z.number().int().optional() }).parse(req.body);
      return fleet.issueCommand(body.targets, body.op, body.args ?? {}, { ttlMs: body.ttlMs });
    });
    api.post('/api/stop', async (req) => {
      const body = z.object({ targets: TargetsSchema, reason: StopReason }).parse(req.body);
      return fleet.stop(body.targets, body.reason);
    });
    api.post('/api/resume', async (req) => fleet.resume(z.object({ targets: TargetsSchema }).parse(req.body).targets));
    api.post('/api/cancel', async (req) => fleet.cancel(z.object({ targets: TargetsSchema }).parse(req.body).targets));
    api.get('/api/batches/:id', async (req, reply) => fleet.getBatch((req.params as { id: string }).id) ?? reply.code(404).send({ error: 'not found' }));

    api.get('/api/events', async (req) => fleet.recentEvents(Math.min(Number((req.query as { limit?: string }).limit ?? 200), 1000)));

    api.get('/api/map/ores', async (req) => {
      const q = z.object({ world: z.string(), dimension: z.string() }).parse(req.query);
      return { ores: fleet.findOres(q.world, q.dimension) };
    });

    api.get('/api/map/blocks', async (req) => {
      const q = z
        .object({
          world: z.string(),
          dimension: z.string(),
          x0: z.coerce.number().int(),
          x1: z.coerce.number().int(),
          z0: z.coerce.number().int(),
          z1: z.coerce.number().int(),
          y0: z.coerce.number().int(),
          y1: z.coerce.number().int(),
        })
        .parse(req.query);
      if ((q.x1 - q.x0 + 1) * (q.z1 - q.z0 + 1) > 1024 * 1024 || q.y1 - q.y0 > 64) throw new ApiError(400, 'requested area too large');
      return fleet.queryMap(q);
    });

    api.get('/api/depots', async () => jobs.listDepots());
    api.post('/api/depots', async (req) => jobs.saveDepot(req.body));
    api.put('/api/depots/:id', async (req) => jobs.saveDepot(req.body, (req.params as { id: string }).id));
    api.delete('/api/depots/:id', async (req) => {
      jobs.deleteDepot((req.params as { id: string }).id);
      return { ok: true };
    });

    api.get('/api/jobs', async () => jobs.listJobs());
    api.post('/api/jobs/estimate', async (req) => jobs.estimate(req.body));
    api.post('/api/jobs', async (req) => jobs.createJob(req.body));
    api.post('/api/jobs/:id/start', async (req) => jobs.start((req.params as { id: string }).id));
    api.post('/api/jobs/:id/pause', async (req) => jobs.pause((req.params as { id: string }).id));
    api.post('/api/jobs/:id/cancel', async (req) => jobs.cancel((req.params as { id: string }).id));
    api.get('/api/forced-chunks', async () => jobs.listForced());
    api.post('/api/forced-chunks', async (req) => {
      const b = z.object({ world: z.string().min(1).max(40), dimension: z.string().min(1).max(80), cx: z.number().int(), cz: z.number().int(), forced: z.boolean() }).parse(req.body);
      return jobs.setForced(b.world, b.dimension, b.cx, b.cz, b.forced);
    });
    api.post('/api/campaigns', async (req) => jobs.createCampaign(req.body));
    api.post('/api/campaigns/:id/:action', async (req) => {
      const { id, action } = z.object({ id: z.string(), action: z.enum(['start', 'pause', 'cancel']) }).parse(req.params);
      return jobs.campaignAction(id, action);
    });
    api.post('/api/jobs/by-turtles', async (req) => {
      const body = z.object({ turtleIds: z.array(z.string()).max(500), action: z.enum(['start', 'pause', 'cancel']) }).parse(req.body);
      return jobs.turtlesAction(body.turtleIds, body.action);
    });
    api.post('/api/goto', async (req) => {
      const body = z.object({ turtleId: z.string(), target: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }) }).parse(req.body);
      jobs.goto(body.turtleId, body.target);
      return { ok: true };
    });
    api.delete('/api/jobs/:id', async (req) => {
      jobs.deleteJob((req.params as { id: string }).id);
      return { ok: true };
    });

    api.get('/ws/ui', { websocket: true }, (socket) => {
      socket.send(JSON.stringify(fleet.initMessage()));
      const off = fleet.subscribe((m) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
      });
      socket.on('close', off);
      socket.on('message', () => {}); // the UI socket is server-push only
    });
  });

  // ---------------------------------------------------------------- turtles

  app.get('/ws/turtle', { websocket: true }, (socket, req) => handleTurtleSocket(socket, fleet, req.ip, opts.turtleRateLimit));

  if (existsSync(config.turtleDir)) {
    // The installer gets this backend's public URL baked in.
    app.get('/turtle/install.lua', async (_req, reply) => {
      const src = readFileSync(join(config.turtleDir, 'install.lua'), 'utf8');
      reply.type('text/plain; charset=utf-8');
      return src.replace('__BASE_URL__', config.publicUrl.replace(/\/$/, ''));
    });
    app.get('/turtle/manifest.json', async () => {
      const agent = readFileSync(join(config.turtleDir, 'fleet/agent.lua'), 'utf8');
      return {
        version: /AGENT_VERSION = "([^"]+)"/.exec(agent)?.[1] ?? 'unknown',
        files: [
          { src: 'fleet/agent.lua', dest: '/fleet/agent.lua' },
          { src: 'fleet/startup.lua', dest: '/startup.lua' },
        ],
      };
    });
    await app.register(fastifyStatic, { root: config.turtleDir, prefix: '/turtle/', decorateReply: false });
  }
  if (config.webDist && existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/ws')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not found' });
    });
  }

  app.addHook('onClose', async () => {
    jobs.close();
    fleet.close();
    db.close();
  });

  return { app, fleet, jobs, db };
}
