import { create } from 'zustand';
import type { BatchView, ChunkNeed, DepotView, EventView, ForcedChunk, GroupView, Heading, InstanceView, JobView, MapBlock, Targets, TunnelParams, TurtleView, UiServerMsg, Vec3 } from '@ccfleet/protocol';
import { api } from './api';
import { CHUNK, chunksTouched, tiles } from './chunks';

/** What was right-clicked on the map, and where the menu goes on screen. */
export interface MapMenu {
  /** Screen position (client coordinates). */
  x: number;
  y: number;
  view: '2d' | '3d';
  /** The cell a turtle would go to (open space), if any. */
  cell?: Vec3;
  /** The block clicked (3D), or the cell (2D). Used as a job's start. */
  block?: MapBlock | Vec3;
  turtleId?: string;
}

export interface Toast {
  id: number;
  level: 'info' | 'error';
  text: string;
}

interface FleetState {
  live: 'connecting' | 'live' | 'down';
  turtles: Record<string, TurtleView>;
  groups: GroupView[];
  batches: BatchView[];
  events: EventView[];
  selection: string[];
  focusId?: string;
  activeBatchId?: string;
  world: string;
  dimension: string;
  y: number;
  followY: boolean;
  /** Bumped whenever the map cache changes, so the canvas redraws. */
  mapVersion: number;
  /** Bumped to ask the map to centre on `centerTarget`. */
  centerTarget?: { x: number; z: number; n: number };
  toasts: Toast[];
  jobs: Record<string, JobView>;
  depots: Record<string, DepotView>;
  rightTab: 'turtle' | 'jobs' | 'depots' | 'ores';
  /** Show the chunk grid and which chunks turtles keep loaded. */
  showChunks: boolean;
  setShowChunks(v: boolean): void;
  /** Mark ores seen near the current Y level. */
  showOres: boolean;
  setShowOres(v: boolean): void;
  /** Instances (Minecraft worlds/servers) the backend knows; the one shown is `world`. */
  instances: InstanceView[];
  setInstances(list: InstanceView[]): void;
  /** Show another instance: its turtles, map, jobs and depots (remembered in this browser). */
  setInstance(name: string): void;
  /** 2D slice map or 3D view. */
  mapMode: '2d' | '3d';
  setMapMode(m: '2d' | '3d'): void;
  /** Right-click menu on the map, if open. */
  contextMenu?: MapMenu;
  setContextMenu(m: MapMenu | undefined): void;
  /** Start position for the next new job ("New job here" on the map). */
  jobPrefill?: { origin: Vec3; heading?: Heading };
  newJobAt(origin: Vec3, heading?: Heading): void;
  clearJobPrefill(): void;
  /** Chunks the operator marked as force-loaded (FTB Chunks etc.). */
  forcedChunks: ForcedChunk[];
  /** Map clicks toggle "force-loaded" on chunks instead of selecting turtles. */
  markChunks: boolean;
  setMarkChunks(v: boolean): void;
  /** Chunks the job being drafted would need. */
  draftChunks?: ChunkNeed[];
  setDraftChunks(c: ChunkNeed[] | undefined): void;
  /** Tunnel being drafted in the job form, previewed on the map. */
  jobDraft?: TunnelParams[];
  setRightTab(t: FleetState['rightTab']): void;
  setJobDraft(p: TunnelParams[] | undefined): void;

  select(ids: string[], mode?: 'replace' | 'add' | 'toggle'): void;
  focus(id: string | undefined, center?: boolean): void;
  setY(y: number): void;
  setFollowY(v: boolean): void;
  setWorld(world: string, dimension: string): void;
  centerOn(x: number, z: number, y?: number): void;
  setActiveBatch(id: string | undefined): void;
  toast(level: Toast['level'], text: string): void;
  dismissToast(id: number): void;
}

let toastSeq = 0;
let centerSeq = 0;

export const useFleet = create<FleetState>((set, get) => ({
  live: 'connecting',
  turtles: {},
  groups: [],
  batches: [],
  events: [],
  selection: [],
  world: savedInstance() ?? 'main',
  dimension: 'minecraft:overworld',
  y: 64,
  followY: true,
  mapVersion: 0,
  toasts: [],
  jobs: {},
  depots: {},
  rightTab: 'turtle',
  showOres: true,
  setShowOres: (showOres) => set({ showOres }),
  instances: [],
  setInstances: (instances) => {
    rememberServerInstances(instances);
    set({ instances });
  },
  setInstance(name) {
    rememberInstance(name);
    const st = get();
    if (name === st.world) return;
    // Its turtles' dimension (else the overworld), centred on one of them.
    const here = Object.values(st.turtles).filter((t) => t.world === name);
    const first = here.find((t) => t.connection !== 'offline' && t.state?.pose.pos) ?? here.find((t) => t.state?.pose.pos);
    set({ selection: [], focusId: undefined });
    st.setWorld(name, first?.dimension ?? 'minecraft:overworld');
    const p = first?.state?.pose.pos;
    if (p) st.centerOn(p.x, p.z, p.y);
  },
  mapMode: '2d',
  setMapMode: (mapMode) => set({ mapMode }),
  contextMenu: undefined,
  setContextMenu: (contextMenu) => set({ contextMenu }),
  jobPrefill: undefined,
  newJobAt: (origin, heading) => set({ jobPrefill: { origin, heading }, rightTab: 'jobs', contextMenu: undefined }),
  clearJobPrefill: () => set({ jobPrefill: undefined }),
  showChunks: true,
  setShowChunks: (showChunks) => set({ showChunks, ...(showChunks ? {} : { markChunks: false }) }),
  forcedChunks: [],
  markChunks: false,
  setMarkChunks: (markChunks) => set({ markChunks, ...(markChunks ? { showChunks: true } : {}) }),
  setDraftChunks: (draftChunks) => set({ draftChunks }),
  setRightTab: (rightTab) => set({ rightTab }),
  setJobDraft: (jobDraft) => set({ jobDraft }),

  select(ids, mode = 'replace') {
    const cur = new Set(get().selection);
    if (mode === 'replace') {
      set({ selection: [...new Set(ids)], focusId: ids.length ? ids[ids.length - 1] : get().focusId });
      return;
    }
    for (const id of ids) {
      if (mode === 'add') cur.add(id);
      else if (cur.has(id)) cur.delete(id);
      else cur.add(id);
    }
    set({ selection: [...cur], focusId: ids.length && cur.has(ids[ids.length - 1]) ? ids[ids.length - 1] : get().focusId });
  },
  focus(id, center = false) {
    set({ focusId: id });
    const t = id ? get().turtles[id] : undefined;
    if (!t) return;
    if (t.world !== get().world || t.dimension !== get().dimension) get().setWorld(t.world, t.dimension);
    const pos = t.state?.pose.pos;
    if (pos && (center || get().followY)) set({ y: pos.y });
    if (pos && center) get().centerOn(pos.x, pos.z);
  },
  setY: (y) => set({ y: Math.max(-64, Math.min(320, Math.round(y))) }),
  setFollowY: (followY) => set({ followY }),
  setWorld(world, dimension) {
    if (world === get().world && dimension === get().dimension) return;
    mapCache.reset();
    set({ world, dimension, mapVersion: get().mapVersion + 1 });
  },
  centerOn(x, z, y) {
    set({ centerTarget: { x, z, n: ++centerSeq }, ...(y !== undefined ? { y } : {}) });
  },
  setActiveBatch: (activeBatchId) => set({ activeBatchId }),
  toast(level, text) {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, level, text }].slice(-4) });
    setTimeout(() => get().dismissToast(id), level === 'error' ? 7000 : 3500);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

// ------------------------------------------------------------------ live updates

function apply(m: UiServerMsg) {
  const s = useFleet.getState();
  switch (m.type) {
    case 'init': {
      const turtles = Object.fromEntries(m.turtles.map((t) => [t.id, t]));
      const selection = s.selection.filter((id) => turtles[id]);
      useFleet.setState({
        turtles,
        groups: m.groups,
        batches: m.batches,
        events: m.events,
        selection,
        jobs: Object.fromEntries((m.jobs ?? []).map((j) => [j.id, j])),
        depots: Object.fromEntries((m.depots ?? []).map((d) => [d.id, d])),
        forcedChunks: m.forcedChunks ?? [],
      });
      // Default the map to where the turtles are (in the chosen instance, if one was chosen).
      if (!Object.keys(s.turtles).length && m.turtles.length) {
        const chosen = savedInstance();
        const pool = chosen ? m.turtles.filter((t) => t.world === chosen) : m.turtles;
        const first = pool.find((t) => t.connection !== 'offline' && t.state?.pose.pos) ?? pool.find((t) => t.state?.pose.pos);
        if (first) {
          s.setWorld(first.world, first.dimension);
          const p = first.state!.pose.pos!;
          s.centerOn(p.x, p.z, p.y);
        }
      }
      break;
    }
    case 'turtle': {
      const prev = s.turtles[m.turtle.id];
      useFleet.setState({ turtles: { ...s.turtles, [m.turtle.id]: m.turtle } });
      const pos = m.turtle.state?.pose.pos;
      if (s.followY && s.focusId === m.turtle.id && pos && prev?.state?.pose.pos?.y !== pos.y) s.setY(pos.y);
      break;
    }
    case 'turtle_removed': {
      const { [m.id]: _gone, ...rest } = s.turtles;
      useFleet.setState({ turtles: rest, selection: s.selection.filter((id) => id !== m.id), focusId: s.focusId === m.id ? undefined : s.focusId });
      break;
    }
    case 'groups':
      useFleet.setState({ groups: m.groups });
      break;
    case 'batch': {
      const others = s.batches.filter((b) => b.id !== m.batch.id);
      useFleet.setState({ batches: [m.batch, ...others].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50) });
      break;
    }
    case 'event':
      useFleet.setState({ events: [m.event, ...s.events].slice(0, 500) });
      break;
    case 'instances':
      useFleet.getState().setInstances(m.instances);
      break;
    case 'forced_chunks':
      useFleet.setState({ forcedChunks: m.chunks });
      break;
    case 'job':
      useFleet.setState({ jobs: { ...s.jobs, [m.job.id]: m.job } });
      break;
    case 'job_removed': {
      const { [m.id]: _j, ...jobs } = s.jobs;
      useFleet.setState({ jobs });
      break;
    }
    case 'depot':
      useFleet.setState({ depots: { ...s.depots, [m.depot.id]: m.depot } });
      break;
    case 'depot_removed': {
      const { [m.id]: _d, ...depots } = s.depots;
      useFleet.setState({ depots });
      break;
    }
    case 'map':
      if (m.world === s.world && m.dimension === s.dimension) {
        mapCache.put(m.blocks);
        useFleet.setState({ mapVersion: s.mapVersion + 1 });
      }
      break;
  }
}

let socket: WebSocket | undefined;
let retry = 1000;
let stopped = false;

export function connectLive() {
  stopped = false;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/ui`;
  useFleet.setState({ live: 'connecting' });
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    retry = 1000;
    useFleet.setState({ live: 'live' });
    // The map may have missed deltas while disconnected; refetch what is on screen.
    mapCache.reset();
    useFleet.setState({ mapVersion: useFleet.getState().mapVersion + 1 });
  };
  ws.onmessage = (e) => apply(JSON.parse(e.data));
  ws.onclose = () => {
    if (socket !== ws) return;
    useFleet.setState({ live: 'down' });
    // Refused because the session ended (expired, logged out elsewhere)? A protected call
    // answers 401 and the login screen shows, instead of retrying here forever.
    api.info().catch(() => {});
    // Checked again when the timer fires: logging out in between stops the retries.
    if (!stopped) setTimeout(() => !stopped && connectLive(), retry);
    retry = Math.min(retry * 2, 15000);
  };
}

export function disconnectLive() {
  stopped = true;
  socket?.close();
  socket = undefined;
}

// ------------------------------------------------------------------ helpers

export function selectionTargets(): Targets {
  return { turtleIds: useFleet.getState().selection };
}

/** Run an API call that returns a batch, show it in the results panel, toast errors. */
export async function runBatch(p: Promise<BatchView>) {
  try {
    const b = await p;
    useFleet.getState().setActiveBatch(b.id);
    const s = useFleet.getState();
    if (!s.batches.find((x) => x.id === b.id)) useFleet.setState({ batches: [b, ...s.batches] });
    return b;
  } catch (e) {
    useFleet.getState().toast('error', (e as Error).message);
    return undefined;
  }
}

// ------------------------------------------------------------------ map cache

const BAND = 16;

/**
 * Client-side cache of observed blocks, indexed by Y level. Data is loaded per
 * 16x16 chunk column and 16-block Y band as the viewport needs it, then kept up to
 * date by incremental `map` messages — the server never resends the whole map.
 */
class MapCache {
  byY = new Map<number, Map<string, MapBlock>>();
  private loaded = new Set<string>();
  private inflight = new Set<string>();
  private generation = 0;
  /** Bumped per chunk (and its edge neighbours) whenever blocks there change. */
  private versions = new Map<string, number>();
  private versionBase = 0;

  reset() {
    this.byY.clear();
    this.loaded.clear();
    this.inflight.clear();
    this.generation++;
    // Everything changed: versions restart above any number handed out before.
    this.versionBase += 1_000_000;
    this.versions.clear();
  }

  put(blocks: MapBlock[]) {
    for (const b of blocks) {
      let layer = this.byY.get(b.y);
      if (!layer) this.byY.set(b.y, (layer = new Map()));
      layer.set(`${b.x},${b.z}`, b);
    }
    for (const k of chunksTouched(blocks)) this.versions.set(k, (this.versions.get(k) ?? this.versionBase) + 1);
  }

  /** Changes whenever blocks in (or at the edge of) this chunk change. */
  version(chunk: string): number {
    return this.versions.get(chunk) ?? this.versionBase;
  }

  layer(y: number) {
    return this.byY.get(y);
  }

  /** Ensure chunks covering [x0,x1]x[z0,z1] are loaded for the band containing y (and y-1). */
  ensure(world: string, dimension: string, x0: number, x1: number, z0: number, z1: number, y: number, onLoaded: () => void) {
    // The current level, the floor hint below it, and ±8 levels for the ore overlay.
    this.load(world, dimension, x0, x1, z0, z1, new Set([Math.floor(y / BAND), Math.floor((y - 8) / BAND), Math.floor((y + 8) / BAND)]), onLoaded);
  }

  /** Ensure everything in the box [x0,x1]x[y0,y1]x[z0,z1] is loaded (3D view). */
  ensureBox(world: string, dimension: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, onLoaded: () => void) {
    const bands = new Set<number>();
    for (let b = Math.floor(y0 / BAND); b <= Math.floor(y1 / BAND); b++) bands.add(b);
    this.load(world, dimension, x0, x1, z0, z1, bands, onLoaded);
  }

  private load(world: string, dimension: string, x0: number, x1: number, z0: number, z1: number, bands: Set<number>, onLoaded: () => void) {
    const cx0 = Math.floor(x0 / CHUNK);
    const cx1 = Math.floor(x1 / CHUNK);
    const cz0 = Math.floor(z0 / CHUNK);
    const cz1 = Math.floor(z1 / CHUNK);
    if ((cx1 - cx0 + 1) * (cz1 - cz0 + 1) > 4096) return; // zoomed out too far to load more
    for (const band of bands) {
      const missing: { cx: number; cz: number }[] = [];
      for (let cx = cx0; cx <= cx1; cx++)
        for (let cz = cz0; cz <= cz1; cz++) {
          const k = `${cx},${cz},${band}`;
          if (!this.loaded.has(k) && !this.inflight.has(k)) missing.push({ cx, cz });
        }
      // Small requests: one big one could pass the server's row limit and come back cut
      // short, yet be marked loaded.
      for (const t of tiles(missing)) {
        const keys = t.chunks.map((c) => `${c.cx},${c.cz},${band}`);
        keys.forEach((k) => this.inflight.add(k));
        const gen = this.generation;
        api
          .mapBlocks({ world, dimension, x0: t.cx0 * CHUNK, x1: t.cx1 * CHUNK + CHUNK - 1, z0: t.cz0 * CHUNK, z1: t.cz1 * CHUNK + CHUNK - 1, y0: band * BAND, y1: band * BAND + BAND - 1 })
          .then((r) => {
            if (gen !== this.generation) return;
            this.put(r.blocks);
            keys.forEach((k) => {
              this.inflight.delete(k);
              // A cut-short answer stays unloaded, so it is asked again (in smaller parts if needed).
              if (!r.truncated) this.loaded.add(k);
            });
            onLoaded();
          })
          .catch(() => keys.forEach((k) => this.inflight.delete(k)));
      }
    }
  }
}

export const mapCache = new MapCache();

// ------------------------------------------------------------------ chosen instance (per browser)
// (Keys written out: these run while the store above is being created.)

/** The instance last shown in this browser, if any. */
export function savedInstance(): string | undefined {
  try {
    return localStorage.getItem('ccf.instance') ?? undefined;
  } catch {
    return undefined;
  }
}

/** Instances this browser has shown (offered on the login screen, before the server list is readable). */
export function knownInstances(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem('ccf.instances') ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** The server's list replaces the remembered one, so renamed and deleted instances drop off the login screen. */
function rememberServerInstances(list: InstanceView[]): void {
  try {
    const current = localStorage.getItem('ccf.instance');
    localStorage.setItem('ccf.instances', JSON.stringify([...new Set([...(current ? [current] : []), ...list.map((i) => i.name)])].slice(0, 30)));
  } catch {
    /* private mode: not remembered */
  }
}

export function rememberInstance(name: string, others: string[] = []): void {
  try {
    localStorage.setItem('ccf.instance', name);
    localStorage.setItem('ccf.instances', JSON.stringify([...new Set([name, ...others, ...knownInstances()])].slice(0, 30)));
  } catch {
    /* private mode: not remembered */
  }
}
