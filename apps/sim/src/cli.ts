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
import { CCTurtle } from './cc/host';

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
    // Run the real Lua agent (turtle/fleet/agent.lua) in the CC host instead of the TS agent.
    lua: { type: 'boolean', default: false },
    // Equip simulated turtles with a Chunk Controller (Advanced Peripherals) on the left.
    chunky: { type: 'boolean', default: false },
  },
});

const count = Math.max(1, Math.min(64, Number(values.count)));
const opMs = Math.round(400 / Math.max(0.1, Number(values.speed)));
// npm runs workspace scripts from apps/sim; resolve --data against where npm was invoked.
const dataDir = resolve(process.env.INIT_CWD ?? process.cwd(), values.data!);
const server = values.server!.replace(/\/$/, '');
const wsUrl = server.replace(/^http/, 'ws') + '/ws/turtle';

if (values.reset && existsSync(dataDir)) rmSync(dataDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const worldFile = join(dataDir, 'world.json');
const freshWorld = !existsSync(worldFile);
const world = freshWorld ? new SimWorld(Number(values.seed)) : SimWorld.fromJSON(JSON.parse(readFileSync(worldFile, 'utf8')));

// A fresh world gets a ready-made depot next to the first turtle's start (x=0, z=0):
// an unload chest to its west and a fuel chest with coal (and torches, for jobs that
// place them) under it.
const depotHint = (() => {
  const y = world.surfaceY(0, 0) + 1;
  if (freshWorld) {
    for (let cy = y; cy < y + 3; cy++) world.set(-1, cy, 0, null);
    world.placeChest({ x: -1, y, z: 0 }, 54);
    world.placeChest({ x: 0, y: y - 1, z: 0 });
    world.inventories.get(`0,${y - 1},0`)![0] = { name: 'minecraft:coal', count: 64 };
    world.inventories.get(`0,${y - 1},0`)![1] = { name: 'minecraft:coal', count: 64 };
    world.inventories.get(`0,${y - 1},0`)![2] = { name: 'minecraft:torch', count: 64 };
  }
  return `dock 0 ${y} 0 facing west, unload chest in front, fuel chest below`;
})();

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
const luaTurtles: { t: CCTurtle; diskFile: string }[] = [];
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
  if (values.lua) {
    const diskFile = join(dataDir, `disk-${computerId}.json`);
    const files = new Map<string, string>(existsSync(diskFile) ? JSON.parse(readFileSync(diskFile, 'utf8')) : []);
    const label = files.size ? `sim-lua-${i + 1}` : undefined;
    const t = new CCTurtle({
      world,
      body,
      computerId,
      label,
      files,
      opMs,
      gps: !values['no-gps'],
      upgrades: values.chunky ? { left: 'chunky' } : undefined,
      inputs: [values['no-calibrate'] ? '' : `${body.pos.x} ${body.pos.y} ${body.pos.z} ${'nesw'[body.heading]}`],
      onPrint: (m) => console.log(`[lua #${computerId}] ${m}`),
    });
    if (files.has('startup.lua')) await t.boot('startup.lua');
    else {
      t.files.set('install.lua', await (await fetch(`${server}/turtle/install.lua`)).text());
      await t.boot('install.lua', [await pairingCode(`Sim Lua ${i + 1}`)]);
    }
    luaTurtles.push({ t, diskFile });
    continue;
  }
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
    upgrades: values.chunky ? { left: 'chunky' } : undefined,
    onLog: (m) => console.log(m),
  });
  turtles.push(t);
  t.start();
}

function saveAll() {
  writeFileSync(worldFile, JSON.stringify(world.toJSON()));
  for (const t of turtles) writeFileSync(join(dataDir, `body-${t.computerId}.json`), JSON.stringify(t.body));
  for (const { t, diskFile } of luaTurtles) {
    writeFileSync(join(dataDir, `body-${t.computerId}.json`), JSON.stringify(t.body));
    writeFileSync(diskFile, JSON.stringify([...t.files]));
  }
}
setInterval(saveAll, 5000);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    saveAll();
    for (const t of turtles) t.stop();
    for (const { t } of luaTurtles) t.shutdown();
    process.exit(0);
  });
}
console.log(`[sim] depot site: ${depotHint}`);
console.log(`[sim] ${count} simulated turtle(s)${values.lua ? ' running the real Lua agent' : ''} → ${wsUrl} (op time ${opMs} ms, data in ${dataDir})`);
