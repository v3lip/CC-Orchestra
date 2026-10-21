/**
 * Instances: one per Minecraft world/server ("save"). Everything is already tagged with
 * a world name (turtles, map, depots, jobs, marked chunks); an instance is that name,
 * made first-class: listed with counts, created before anything is paired into it,
 * renamed, or deleted with all its data. Turtles of every instance stay connected at
 * once; the dashboard shows one instance at a time.
 */
import type { InstanceView } from '@ccfleet/protocol';
import type { Db } from './db';
import { ApiError, type Fleet } from './fleet';
import type { JobManager } from './jobs/manager';
import { now } from './util';

export class Instances {
  constructor(
    private db: Db,
    private fleet: Fleet,
    private jobs: JobManager,
  ) {}

  list(): InstanceView[] {
    const out = new Map<string, InstanceView>();
    const get = (name: string) => {
      let v = out.get(name);
      if (!v) out.set(name, (v = { name, turtles: 0, online: 0, mapBlocks: 0, jobs: 0, depots: 0 }));
      return v;
    };
    for (const r of this.db.prepare('SELECT name, created_at FROM instances').all() as { name: string; created_at: number }[]) get(r.name).createdAt = r.created_at;
    for (const t of this.fleet.listTurtles()) {
      const v = get(t.world);
      v.turtles++;
      if (t.connection !== 'offline') v.online++;
      v.lastSeen = Math.max(v.lastSeen ?? 0, t.lastSeen ?? 0) || undefined;
    }
    for (const r of this.db.prepare('SELECT world, count(*) n FROM map_blocks GROUP BY world').all() as { world: string; n: number }[]) get(r.world).mapBlocks = r.n;
    for (const j of this.jobs.listJobs()) if (j.status !== 'completed' && j.status !== 'cancelled') get(j.world).jobs++;
    for (const d of this.jobs.listDepots()) get(d.world).depots++;
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  create(name: string): InstanceView[] {
    const n = clean(name);
    this.db.prepare('INSERT OR IGNORE INTO instances (name, created_at) VALUES (?,?)').run(n, now());
    this.changed();
    return this.list();
  }

  rename(from: string, to: string): InstanceView[] {
    const n = clean(to);
    if (n === from) return this.list();
    if (!this.list().some((i) => i.name === from)) throw new ApiError(404, `no instance "${from}"`);
    if (this.list().some((i) => i.name === n && (i.turtles || i.mapBlocks || i.jobs || i.depots))) throw new ApiError(409, `an instance called "${n}" already has data`);
    if (this.jobs.worldBusy(from)) throw new ApiError(409, 'a job or go-to is running there; pause it first');
    this.fleet.renameWorld(from, n);
    this.jobs.renameWorld(from, n);
    this.db.prepare('DELETE FROM instances WHERE name=?').run(n);
    this.db.prepare('UPDATE instances SET name=? WHERE name=?').run(n, from);
    this.db.prepare('INSERT OR IGNORE INTO instances (name, created_at) VALUES (?,?)').run(n, now());
    this.fleet.log('info', `Instance "${from}" renamed to "${n}"`);
    this.changed();
    return this.list();
  }

  /** Delete an instance and everything in it. Its turtles are unpaired (credentials revoked). */
  remove(name: string): InstanceView[] {
    const v = this.list().find((i) => i.name === name);
    if (!v) throw new ApiError(404, `no instance "${name}"`);
    if (v.online) throw new ApiError(409, `${v.online} of its turtles are online; stop them (or close that world) first`);
    if (this.jobs.worldBusy(name)) throw new ApiError(409, 'a job or go-to is running there; pause it first');
    this.jobs.deleteWorld(name);
    this.fleet.deleteWorld(name);
    this.db.prepare('DELETE FROM instances WHERE name=?').run(name);
    this.fleet.log('warn', `Instance "${name}" deleted: ${v.turtles} turtle(s), ${v.mapBlocks} map blocks, ${v.jobs} job(s), ${v.depots} depot(s)`);
    this.changed();
    return this.list();
  }

  private changed(): void {
    this.fleet.broadcast({ type: 'instances', instances: this.list() });
  }
}

function clean(name: string): string {
  const n = name.trim();
  if (!n || n.length > 40) throw new ApiError(400, 'instance names are 1-40 characters');
  if (!/^[\w .:-]+$/.test(n)) throw new ApiError(400, 'use letters, digits, spaces and . _ : - only');
  return n;
}
