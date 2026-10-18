/**
 * Run a fleet of simulated turtles against a backend.
 *
 *   npm run sim -- --count 6 [--speed 2] [--server http://127.0.0.1:8787] [--no-calibrate] [--reset]
 *
 * Simulated turtles enrol with pairing codes like real ones (the CLI logs in with
 * ADMIN_PASSWORD to create the codes) and are registered in the world "sim", so their
 * map data never mixes with real Minecraft data.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Pose } from '@ccfleet/protocol';
import { SimWorld, type TurtleBody } from './world';
import { SimTurtle, type AgentMemory, type MemoryStore } from './turtle';

const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '4' },
    speed: { type: 'string', default: '1' },
    server: { type: 'string', default: process.env.PUBLIC_URL ?? 'http://127.0.0.1:8787' },
    data: { type: 'string', default: resolve(import.meta.dirname, '../../../sim-data') },
    'no-calibrate': { type: 'boolean', default: false },
    'no-gps': { type: 'boolean', default: false },
    reset: { type: 'boolean', default: false },
    seed: { type: 'string', default: '1337' },
  },
});

const count = Math.max(1, Math.min(64, Number(values.count)));
const opMs = Math.round(400 / Math.max(0.1, Number(values.speed)));
const dataDir = values.data!;
const server = values.server!.replace(/\/$/, '');
const wsUrl = server.replace(/^http/, 'ws') + '/ws/turtle';

if (values.reset && existsSync(dataDir)) rmSync(dataDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const worldFile = join(dataDir, 'world.json');
const world = existsSync(worldFile) ? SimWorld.fromJSON(JSON.parse(readFileSync(worldFile, 'utf8'))) : new SimWorld(Number(values.seed));

class FileStore implements MemoryStore {
  constructor(private file: string) {}
  load() {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as AgentMemory) : undefined;
  }
  save(m: AgentMemory) {
    writeFileSync(this.file, JSON.stringify(m));
  }
}

let cookie = '';
async function api(path: string, body: unknown): Promise<any> {
  const res = await fetch(server + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function pairingCode(name: string): Promise<string> {
  if (!cookie) {
    const password = process.env.ADMIN_PASSWORD;
    if (!password || password === 'change-me') throw new Error('Set ADMIN_PASSWORD (in .env) so the simulator can create pairing codes.');
    await api('/api/auth/login', { password });
  }
  const r = await api('/api/enrollments', { name, world: 'sim', dimension: 'minecraft:overworld', simulated: true });
  return r.code;
}

const turtles: SimTurtle[] = [];
for (let i = 0; i < count; i++) {
  const computerId = 1000 + i;
  const bodyFile = join(dataDir, `body-${computerId}.json`);
  const store = new FileStore(join(dataDir, `memory-${computerId}.json`));
  let body: TurtleBody;
  if (existsSync(bodyFile)) body = JSON.parse(readFileSync(bodyFile, 'utf8'));
  else {
    const x = i * 2;
    const z = 0;
    const y = world.surfaceY(x, z) + 1;
    for (let cy = y; cy < y + 3; cy++) world.set(x, cy, z, null); // clear headroom at the start
    const slots: TurtleBody['slots'] = Array(16).fill(null);
    slots[15] = { name: 'minecraft:coal', count: 16 };
    body = { pos: { x, y, z }, heading: 0, fuel: 1000, fuelLimit: 20000, slots, selected: 1 };
  }
  const initialPose: Pose | undefined = values['no-calibrate']
    ? undefined
    : { pos: { ...body.pos }, heading: body.heading, position: 'known', headingConfidence: 'known', source: 'manual' };
  const needsCode = !store.load()?.creds;
  const t = new SimTurtle({
    world,
    body,
    store,
    serverUrl: wsUrl,
    computerId,
    label: `sim-${i + 1}`,
    enrollCode: needsCode ? await pairingCode(`Sim ${i + 1}`) : undefined,
    opMs,
    initialPose,
    gps: !values['no-gps'],
    onLog: (m) => console.log(m),
  });
  turtles.push(t);
  t.start();
}

function saveAll() {
  writeFileSync(worldFile, JSON.stringify(world.toJSON()));
  for (const t of turtles) writeFileSync(join(dataDir, `body-${t.computerId}.json`), JSON.stringify(t.body));
}
setInterval(saveAll, 5000);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    saveAll();
    for (const t of turtles) t.stop();
    process.exit(0);
  });
}
console.log(`[sim] ${count} simulated turtle(s) → ${wsUrl} (op time ${opMs} ms, data in ${dataDir})`);
