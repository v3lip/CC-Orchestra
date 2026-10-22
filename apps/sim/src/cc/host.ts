/**
 * Runs the REAL Lua turtle agent (turtle/fleet/agent.lua) and installer under Node,
 * inside a small CC: Tweaked-like environment (see rom.lua) backed by the simulator's
 * world and physics. This catches logic bugs in the Lua code without Minecraft. It
 * does not prove CC: Tweaked compatibility: the VM is Lua 5.4, not CC's Cobalt.
 * (Lua 5.1 syntax is checked separately.)
 */
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { LuaFactory, type LuaEngine } from 'wasmoon';
import { SimWorld, type TurtleBody } from '../world';
import * as physics from '../physics';

const ROM = readFileSync(new URL('./rom.lua', import.meta.url), 'utf8');
let factory: LuaFactory | undefined;

type Event = [string, unknown?, unknown?, unknown?];

export interface CCTurtleOptions {
  world: SimWorld;
  body: TurtleBody;
  computerId: number;
  label?: string;
  /** The turtle's disk. Survives reboots. */
  files?: Map<string, string>;
  /** Duration of a move/turn/dig in ms (real turtles: ~400). */
  opMs?: number;
  /** A wireless modem is attached and GPS hosts are in range. */
  gps?: boolean;
  /** Lines returned by read(). */
  inputs?: string[];
  /** Peripheral upgrades on each side, e.g. { left: 'chunky' } for a Chunk Controller. */
  upgrades?: { left?: string; right?: string };
  onPrint?: (line: string) => void;
}

export interface CCFaults {
  /** After a successful physical move, before the agent hears about it: reboot instead. */
  crashAfterPhysicalMove?: (op: string) => boolean;
  /** Called for each outgoing websocket message; return true to drop the link right after sending it. */
  dropAfterSend?: (msg: { type: string }) => boolean;
}

export class CCTurtle {
  readonly world: SimWorld;
  readonly body: TurtleBody;
  readonly files: Map<string, string>;
  readonly dirs = new Set<string>();
  readonly output: string[] = [];
  readonly faults: CCFaults = {};
  label?: string;
  status: 'off' | 'running' | 'dead' | 'error' = 'off';
  lastError?: string;

  private lua?: LuaEngine;
  private deliverFn?: (...a: unknown[]) => string;
  private queue: Event[] = [];
  private pumping = false;
  private timers = new Map<number, NodeJS.Timeout>();
  private sockets = new Map<number, WebSocket>();
  private nextId = 1;
  private generation = 0;
  private opMs: number;
  private inputs: string[];

  constructor(private opts: CCTurtleOptions) {
    this.world = opts.world;
    this.body = opts.body;
    this.files = opts.files ?? new Map();
    this.label = opts.label;
    this.opMs = opts.opMs ?? 400;
    this.inputs = [...(opts.inputs ?? [])];
    this.world.addOccupant(this.body);
  }

  get computerId(): number {
    return this.opts.computerId;
  }

  /** Read the agent's persisted state (for assertions). */
  get state(): any {
    const s = this.files.get('fleet/state.json');
    return s ? JSON.parse(s) : undefined;
  }

  /** Boot the computer and run a program (default: startup.lua, as CC does). */
  async boot(program = 'startup.lua', args: string[] = []): Promise<void> {
    this.shutdownVm();
    const gen = ++this.generation;
    factory ??= new LuaFactory();
    const lua = await factory.createEngine({ injectObjects: false, enableProxy: false });
    if (gen !== this.generation) {
      lua.global.close();
      return;
    }
    this.lua = lua;
    this.installHost(lua, gen);
    await lua.doString(ROM);
    this.deliverFn = lua.global.get('__deliver');
    const bootFn = lua.global.get('__boot') as (p: string, a: string) => string;
    this.status = 'running';
    this.handleStatus(bootFn(program, JSON.stringify(args)));
  }

  /** Simulate a crash/restart: memory and connections are lost, disk and body remain. */
  async reboot(): Promise<void> {
    await this.boot('startup.lua');
  }

  /** Power off: the VM stops and sockets drop. */
  shutdown(): void {
    this.generation++;
    this.shutdownVm();
    this.status = 'off';
  }

  /** Drop all network connections without rebooting. */
  dropConnections(): void {
    for (const ws of this.sockets.values()) ws.terminate();
  }

  private shutdownVm(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const ws of this.sockets.values()) ws.terminate();
    this.sockets.clear();
    this.queue = [];
    if (this.lua) {
      try {
        this.lua.global.close();
      } catch {
        /* already closed */
      }
    }
    this.lua = undefined;
    this.deliverFn = undefined;
  }

  private handleStatus(s: string): void {
    if (s === 'dead') this.status = 'dead';
    else if (s.startsWith('error:')) {
      this.status = 'error';
      this.lastError = s.slice(6);
      this.log(`[lua error] ${this.lastError}`);
    }
  }

  private log(line: string): void {
    this.output.push(line);
    this.opts.onPrint?.(line);
  }

  private enqueue(gen: number, ev: Event): void {
    if (gen !== this.generation) return;
    this.queue.push(ev);
    if (!this.pumping) {
      this.pumping = true;
      setImmediate(() => this.pump(gen));
    }
  }

  private pump(gen: number): void {
    this.pumping = false;
    while (gen === this.generation && this.queue.length && this.status === 'running' && this.deliverFn) {
      const ev = this.queue.shift()!;
      // wasmoon cannot push JS null (Lua nil arrives as null); use undefined.
      this.handleStatus(this.deliverFn(...ev.map((v) => (v === null ? undefined : v))));
    }
  }

  private installHost(lua: LuaEngine, gen: number): void {
    const g = lua.global;
    const q = (ev: Event) => this.enqueue(gen, ev);
    const later = (ms: number, fn: () => void) => {
      const id = this.nextId++;
      this.timers.set(
        id,
        setTimeout(() => {
          this.timers.delete(id);
          if (gen === this.generation) fn();
        }, ms),
      );
      return id;
    };

    g.set('__queue_event', (name: string, a?: unknown, b?: unknown, c?: unknown) => q([name, a, b, c]));
    g.set('__start_timer', (s: number) => {
      let id = 0;
      id = later(Math.max(0, s) * 1000, () => q(['timer', id]));
      return id;
    });
    g.set('__cancel_timer', (id: number) => {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
    });
    g.set('__epoch', () => Date.now());
    g.set('__computer_id', () => this.opts.computerId);
    g.set('__get_label', () => this.label);
    g.set('__set_label', (l?: string) => {
      this.label = l ?? undefined;
    });
    g.set('__reboot', () => {
      setImmediate(() => void this.reboot());
    });
    g.set('__print', (s: string) => this.log(s));
    g.set('__read', () => this.inputs.shift() ?? '');

    // fs
    const parentDirs = (p: string) => {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
    };
    g.set('__fs_exists', (p: string) => this.files.has(p) || this.dirs.has(p));
    g.set('__fs_is_dir', (p: string) => this.dirs.has(p));
    g.set('__fs_mkdir', (p: string) => {
      parentDirs(p + '/x');
    });
    g.set('__fs_read', (p: string) => this.files.get(p));
    g.set('__fs_write', (p: string, s: string) => {
      parentDirs(p);
      this.files.set(p, s ?? '');
    });
    g.set('__fs_delete', (p: string) => {
      this.files.delete(p);
      this.dirs.delete(p);
    });

    // http
    g.set('__http_check', () => true);
    g.set('__http_get', (url: string) => {
      fetch(url)
        .then(async (r) => (r.ok ? q(['http_success', url, await r.text()]) : q(['http_failure', url, `HTTP ${r.status}`])))
        .catch((e) => q(['http_failure', url, String(e)]));
    });
    g.set('__ws_open', (url: string) => {
      const id = this.nextId++;
      const ws = new WebSocket(url);
      this.sockets.set(id, ws);
      let opened = false;
      ws.on('open', () => {
        opened = true;
        q(['websocket_success', url, id]);
      });
      ws.on('message', (d) => q(['websocket_message', url, d.toString(), false]));
      ws.on('close', () => {
        this.sockets.delete(id);
        if (opened) q(['websocket_closed', url]);
      });
      ws.on('error', (e) => {
        if (!opened) q(['websocket_failure', url, String(e.message)]);
      });
    });
    g.set('__ws_send', (id: number, msg: string) => {
      const ws = this.sockets.get(id);
      if (!ws || ws.readyState !== WebSocket.OPEN) return 'attempt to use a closed file';
      ws.send(msg);
      try {
        if (this.faults.dropAfterSend?.(JSON.parse(msg))) setImmediate(() => ws.terminate());
      } catch {
        /* not JSON */
      }
      return 'ok';
    });
    g.set('__ws_close', (id: number) => {
      this.sockets.get(id)?.close();
    });

    // turtle
    const body = this.body;
    g.set('__turtle_task', (name: string, arg?: number) => {
      const id = this.nextId++;
      const respond = (ok: boolean, payload?: string) => q(['turtle_response', id, ok, payload]);
      const dir = (n: string): physics.Dir => (n.endsWith('Up') ? 'up' : n.endsWith('Down') ? 'down' : 'front');
      const quick = Math.max(1, this.opMs / 8);
      if (name.startsWith('inspect')) {
        later(quick, () => {
          const b = physics.inspect(this.world, body, dir(name));
          if (b) respond(true, JSON.stringify({ name: b.name, state: b.state ?? {}, tags: {} }));
          else respond(false, 'No block to inspect');
        });
      } else if (['forward', 'back', 'up', 'down'].includes(name)) {
        later(this.opMs, () => {
          const r = physics.move(this.world, body, name as physics.MoveOp);
          if (r.ok && this.faults.crashAfterPhysicalMove?.(name)) {
            void this.reboot();
            return;
          }
          respond(r.ok, r.ok ? undefined : r.reason);
        });
      } else if (name === 'turnLeft' || name === 'turnRight') {
        later(this.opMs, () => {
          physics.turn(body, name);
          respond(true);
        });
      } else if (name.startsWith('dig')) {
        later(this.opMs, () => {
          const r = physics.dig(this.world, body, dir(name));
          respond(r.ok, r.ok ? undefined : r.reason);
        });
      } else if (/^(drop|suck)(Up|Down)?$/.test(name)) {
        later(quick, () => {
          const r = name.startsWith('drop') ? physics.drop(this.world, body, dir(name), arg ?? undefined) : physics.suck(this.world, body, dir(name), arg ?? undefined);
          respond(r.ok, r.ok ? undefined : r.reason);
        });
      } else if (/^place(Up|Down)?$/.test(name)) {
        later(quick, () => {
          const r = physics.place(this.world, body, dir(name));
          respond(r.ok, r.ok ? undefined : r.reason);
        });
      } else if (name === 'refuel') {
        later(quick, () => {
          const r = physics.refuel(body, arg ?? undefined);
          respond(r.ok, r.ok ? undefined : r.reason);
        });
      } else {
        later(0, () => respond(false, `unknown task ${name}`));
      }
      return id;
    });
    g.set('__turtle_select', (s: number) => {
      body.selected = s;
    });
    g.set('__turtle_selected', () => body.selected);
    g.set('__turtle_fuel', () => body.fuel);
    g.set('__turtle_fuel_limit', () => body.fuelLimit);
    g.set('__turtle_item', (s: number) => {
      const it = body.slots[s - 1];
      return it ? JSON.stringify({ name: it.name, count: it.count }) : undefined;
    });
    g.set('__inv_size', (d: physics.Dir) => physics.inventoryAt(this.world, body, d)?.length);
    g.set('__inv_list', (d: physics.Dir) => {
      const inv = physics.inventoryAt(this.world, body, d);
      return inv ? JSON.stringify(inv.flatMap((it, i) => (it ? [{ slot: i + 1, name: it.name, count: it.count }] : []))) : undefined;
    });
    g.set('__periph_type', (side: string) => (side === 'left' || side === 'right' ? this.opts.upgrades?.[side] : undefined));
    g.set('__has_modem', () => !!this.opts.gps);
    g.set('__gps', () => (this.opts.gps ? `${body.pos.x},${body.pos.y},${body.pos.z}` : undefined));
  }
}
