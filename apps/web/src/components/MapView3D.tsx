import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MapBlock, TunnelParams, Vec3 } from '@ccfleet/protocol';
import { HEADING_VECTORS, sectionBox } from '@ccfleet/protocol';
import { mapCache, useFleet } from '../lib/store';
import { STATUS_COLOR, blockColor, shortItem, statusOf } from '../lib/status';
import { type Visible, cellsIn, classify, surface } from '../lib/visible3d';
import { MAX_INSTANCES, chunkOrder, chunkWork, lodFull } from '../lib/chunks';
import { type Frame, fromInset, overviewFrame, toInset } from '../lib/overview';

/** Blocks loaded and drawn around the centre: ±R across, BELOW under and ABOVE over it. */
const R = 128;
const BELOW = 28;
const ABOVE = 12;


/** CSS colour (incl. "hsl(h s% l%)") to a three.js colour. */
function color(css: string): THREE.Color {
  const m = /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/.exec(css);
  return m ? new THREE.Color().setHSL(Number(m[1]) / 360, Number(m[2]) / 100, Number(m[3]) / 100, THREE.SRGBColorSpace) : new THREE.Color(css);
}

/** Colours by block name, parsed once (a rebuild colours every visible block). */
const blockColors = new Map<string, THREE.Color>();
function colorOf(b: MapBlock): THREE.Color {
  const name = b.cell === 'fluid' ? (b.block?.includes('lava') ? '#c2410c' : '#1d4ed8') : (b.block ?? '');
  let c = blockColors.get(name);
  if (!c) blockColors.set(name, (c = color(b.cell === 'fluid' ? name : blockColor(name))));
  return c;
}

/** Map updates arrive up to 10 times a second while turtles work: rebuild at most this often. */
const MAP_REBUILD_MS = 300;
/** Size of the overview inset: a third of the view's shorter side, within these bounds (CSS pixels). */
const OVERVIEW_MIN = 90;
const OVERVIEW_MAX = 180;
const overviewSize = (w: number, h: number) => Math.round(Math.max(OVERVIEW_MIN, Math.min(OVERVIEW_MAX, Math.min(w, h) / 3)));
/** Time a full rebuild may take per animation frame. */
const FRAME_BUDGET_MS = 10;
/** Outline of one ore block, reused for every ore. */
const ORE_EDGES = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.04, 1.04, 1.04)).getAttribute('position');

interface Scene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  blocks: THREE.Group;
  overlays: THREE.Group;
  /** Block meshes per chunk column "cx,cz", with the map version they were built from. */
  chunks: Map<string, ChunkMesh>;
  /** Shared by all chunk meshes; replaced when x-ray changes. */
  materials?: Materials;
  turtleMeshes: THREE.Object3D[];
  labels: Map<string, { el: HTMLDivElement; pos: THREE.Vector3 }>;
}

interface ChunkMesh {
  group: THREE.Group;
  /** Instanced meshes with the block behind each instance, for picking. */
  pickable: { mesh: THREE.InstancedMesh; cells: MapBlock[] }[];
  version: number;
  blocks: number;
  ores: number;
  /** Drawn as the top surface only (far away, or to stay under the instance cap). */
  surface: boolean;
  /** Surface only because of the cap, though near enough for full detail. */
  capped: boolean;
}

interface Materials {
  xray: boolean;
  solid: THREE.Material;
  fluid: THREE.Material;
  ore: THREE.Material;
  edge: THREE.LineBasicMaterial;
}

const BOX = new THREE.BoxGeometry(1, 1, 1);
const WHITE = new THREE.Color('#ffffff');

function makeMaterials(xray: boolean): Materials {
  return {
    xray,
    solid: xray ? new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.09, depthWrite: false }) : new THREE.MeshLambertMaterial(),
    fluid: new THREE.MeshLambertMaterial({ transparent: true, opacity: xray ? 0.12 : 0.55, depthWrite: false }),
    ore: new THREE.MeshBasicMaterial(),
    edge: new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.7 }),
  };
}

function disposeMaterials(m: Materials): void {
  for (const x of [m.solid, m.fluid, m.ore, m.edge]) x.dispose();
}

/** The meshes for one chunk column's visible blocks (materials and box geometry shared). */
function buildChunkMesh(v: Visible, mats: Materials, version: number, surface = false, capped = false): ChunkMesh {
  const group = new THREE.Group();
  const pickable: ChunkMesh['pickable'] = [];
  const add = (cells: MapBlock[], material: THREE.Material, size = 1, tint?: (c: THREE.Color) => THREE.Color) => {
    if (!cells.length) return;
    const mesh = new THREE.InstancedMesh(BOX, material, cells.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3(size, size, size);
    cells.forEach((b, i) => {
      mesh.setMatrixAt(i, m.compose(new THREE.Vector3(b.x + 0.5, b.y + 0.5, b.z + 0.5), q, sc));
      const c = colorOf(b);
      mesh.setColorAt(i, tint ? tint(c.clone()) : c);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
    pickable.push({ mesh, cells });
  };
  add(v.solids, mats.solid);
  add(v.fluids, mats.fluid);
  // Ores unlit in their own colour (lightened so dark ones like coal still show), outlined.
  add(v.ores, mats.ore, mats.xray ? 0.8 : 1.002, (c) => c.lerp(WHITE, 0.25));
  if (v.ores.length) {
    const pts: number[] = [];
    const e = ORE_EDGES;
    for (const b of v.ores) for (let i = 0; i < e.count; i++) pts.push(e.getX(i) + b.x + 0.5, e.getY(i) + b.y + 0.5, e.getZ(i) + b.z + 0.5);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    group.add(new THREE.LineSegments(g, mats.edge));
  }
  return { group, pickable, version, blocks: v.solids.length + v.fluids.length + v.ores.length, ores: v.ores.length, surface, capped };
}

/** Free a chunk's GPU buffers (the shared box geometry and materials stay). */
function disposeChunk(c: ChunkMesh): void {
  for (const o of c.group.children) {
    if (o instanceof THREE.InstancedMesh) o.dispose();
    else if (o instanceof THREE.LineSegments) o.geometry.dispose();
  }
}

/**
 * 3D view of what the turtles have seen around a centre point: solid blocks as cubes
 * (fully enclosed ones skipped), ores highlighted, turtles, job areas, routes and
 * depots. X-ray fades ordinary blocks; "cut above Y" hides everything over the Y level.
 */
export default function MapView3D() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const s3 = useRef<Scene | undefined>(undefined);
  const [hover, setHover] = useState<{ block: MapBlock; sx: number; sy: number }>();
  const [xray, setXray] = useState(false);
  const [cut, setCut] = useState(true);
  const [stats, setStats] = useState({ blocks: 0, ores: 0, capped: 0, building: 0 });

  const world = useFleet((s) => s.world);
  const dimension = useFleet((s) => s.dimension);
  const y = useFleet((s) => s.y);
  const mapVersion = useFleet((s) => s.mapVersion);
  const turtles = useFleet((s) => s.turtles);
  const selection = useFleet((s) => s.selection);
  const focusId = useFleet((s) => s.focusId);
  const jobs = useFleet((s) => s.jobs);
  const depots = useFleet((s) => s.depots);
  const jobDraft = useFleet((s) => s.jobDraft);
  const centerTarget = useFleet((s) => s.centerTarget);

  // The centre of the loaded box: the focused turtle, else any turtle here, else a depot.
  const initial = (): Vec3 => {
    const st = useFleet.getState();
    const f = st.focusId ? st.turtles[st.focusId] : undefined;
    const here = (t?: (typeof st.turtles)[string]) => t && t.world === st.world && t.dimension === st.dimension && t.state?.pose.pos;
    const p = here(f) || Object.values(st.turtles).map(here).find(Boolean) || Object.values(st.depots).find((d) => d.world === st.world)?.dock;
    return p ? { ...p } : { x: 0, y: st.y, z: 0 };
  };
  const [center, setCenter] = useState<Vec3>(initial);

  // Re-centre on the focused turtle when it changes, and on "show on map" requests.
  useEffect(() => {
    const p = focusId ? turtles[focusId]?.state?.pose.pos : undefined;
    if (p && turtles[focusId!]?.world === world) setCenter((c) => (Math.abs(c.x - p.x) + Math.abs(c.z - p.z) > R / 2 || Math.abs(c.y - p.y) > 8 ? { ...p } : c));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);
  useEffect(() => {
    if (centerTarget) setCenter({ x: centerTarget.x, y: useFleet.getState().y, z: centerTarget.z });
  }, [centerTarget]);

  // ------------------------------------------------------------------ set-up

  useEffect(() => {
    const wrap = wrapRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor('#070b12');
    wrap.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog('#070b12', R * 1.2, R * 2.4);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.15;
    controls.screenSpacePanning = true;
    controls.addEventListener('change', () => drawOverview.current());
    scene.add(new THREE.HemisphereLight('#dbe7ff', '#202430', 1.6));
    const sun = new THREE.DirectionalLight('#ffffff', 1.6);
    sun.position.set(0.6, 1, 0.35);
    scene.add(sun);
    const blocks = new THREE.Group();
    const overlays = new THREE.Group();
    scene.add(blocks, overlays);
    s3.current = { renderer, scene, camera, controls, blocks, overlays, chunks: new Map(), turtleMeshes: [], labels: new Map() };

    const resize = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      renderer.setSize(w, h);
      setOvPx(overviewSize(w, h));
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    let raf = 0;
    const v = new THREE.Vector3();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
      // HTML name tags follow their turtles.
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      for (const { el, pos } of s3.current!.labels.values()) {
        v.copy(pos).project(camera);
        const visible = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
        el.style.display = visible ? 'block' : 'none';
        if (visible) el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -150%)`;
      }
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      for (const c of s3.current?.chunks.values() ?? []) disposeChunk(c);
      if (s3.current?.materials) disposeMaterials(s3.current.materials);
      renderer.dispose();
      wrap.removeChild(renderer.domElement);
      s3.current = undefined;
    };
  }, []);

  // Point the camera at a new centre (keeping the viewing angle).
  useEffect(() => {
    const s = s3.current;
    if (!s) return;
    const target = new THREE.Vector3(center.x + 0.5, center.y + 0.5, center.z + 0.5);
    const offset = s.camera.position.clone().sub(s.controls.target);
    if (offset.lengthSq() < 1) offset.set(22, 26, 30);
    s.controls.target.copy(target);
    s.camera.position.copy(target).add(offset);
  }, [center]);

  // ------------------------------------------------------------------ blocks

  useEffect(() => {
    mapCache.ensureBox(world, dimension, center.x - R, center.x + R, center.y - BELOW, center.y + ABOVE, center.z - R, center.z + R, () =>
      useFleet.setState({ mapVersion: useFleet.getState().mapVersion + 1 }),
    );
  }, [world, dimension, center]);

  // Rebuilt when the view changes (all chunks, nearest first, a few per frame) and,
  // throttled, for map updates (only chunks whose map data changed).
  const pass = useRef<{ queue: string[]; used: number; frame: number } | undefined>(undefined);
  const rebuild = useRef<(full: boolean) => void>(() => {});
  rebuild.current = (full) => {
    const s = s3.current;
    if (!s) return;
    const view = { x0: center.x - R, x1: center.x + R, z0: center.z - R, z1: center.z + R, y0: center.y - BELOW, y1: cut ? Math.min(center.y + ABOVE, y) : center.y + ABOVE };
    const layer = (yy: number) => mapCache.layer(yy);
    const ccx = Math.floor(center.x / 16);
    const ccz = Math.floor(center.z / 16);
    if (!s.materials || s.materials.xray !== xray) {
      if (s.materials) disposeMaterials(s.materials);
      s.materials = makeMaterials(xray);
      full = true;
    }
    const inView = chunkOrder(view, ccx, ccz);
    const drop = (k: string) => {
      const c = s.chunks.get(k);
      if (!c) return;
      s.blocks.remove(c.group);
      disposeChunk(c);
      s.chunks.delete(k);
    };
    /** Build one chunk; `used` = instances already drawn by nearer chunks. Returns its count. */
    const build = (k: string, used: number) => {
      const [cx, cz] = k.split(',').map(Number);
      const box = { ...view, x0: Math.max(view.x0, cx * 16), x1: Math.min(view.x1, cx * 16 + 15), z0: Math.max(view.z0, cz * 16), z1: Math.min(view.z1, cz * 16 + 15) };
      const cells = cellsIn(layer, box);
      const near = lodFull(cx, cz, ccx, ccz);
      let v = near ? classify(cells, layer, view) : surface(cells);
      const capped = near && used + v.solids.length + v.fluids.length + v.ores.length > MAX_INSTANCES;
      if (capped) v = surface(cells);
      const c = buildChunkMesh(v, s.materials!, mapCache.version(k), !near || capped, capped);
      drop(k);
      s.chunks.set(k, c);
      s.blocks.add(c.group);
      return c.blocks;
    };
    const updateStats = () => {
      let blocks = 0;
      let ores = 0;
      let capped = 0;
      for (const c of s.chunks.values()) {
        blocks += c.blocks;
        ores += c.ores;
        if (c.capped) capped++;
      }
      setStats({ blocks, ores, capped, building: pass.current?.queue.length ?? 0 });
    };

    if (full) {
      // Chunks out of view go now; the rest are replaced nearest first, the old meshes
      // staying on screen until then, so the view never freezes or goes blank.
      if (pass.current) cancelAnimationFrame(pass.current.frame);
      const keep = new Set(inView);
      for (const k of [...s.chunks.keys()]) if (!keep.has(k)) drop(k);
      const p = { queue: [...inView], used: 0, frame: 0 };
      pass.current = p;
      const step = () => {
        const t0 = performance.now();
        while (p.queue.length && performance.now() - t0 < FRAME_BUDGET_MS) p.used += build(p.queue.shift()!, p.used);
        updateStats();
        if (p.queue.length) p.frame = requestAnimationFrame(step);
        else if (pass.current === p) {
          pass.current = undefined;
          updateStats();
        }
      };
      step();
    } else {
      const versions = new Map([...s.chunks].map(([k, c]) => [k, c.version]));
      // Chunks a running full pass hasn't reached yet are rebuilt by it anyway.
      const pending = new Set(pass.current?.queue ?? []);
      const work = chunkWork(inView, versions, (k) => mapCache.version(k));
      for (const k of work.drop) drop(k);
      for (const k of work.rebuild) {
        if (pending.has(k)) continue;
        const others = [...s.chunks].reduce((n, [ok, c]) => (ok === k ? n : n + c.blocks), 0);
        build(k, others);
      }
      updateStats();
    }
    lastBuild.current = performance.now();
  };
  const lastBuild = useRef(0);
  const pendingBuild = useRef<number | undefined>(undefined);
  useEffect(() => rebuild.current(true), [center, xray, cut, y, world, dimension]);
  useEffect(() => {
    if (pendingBuild.current !== undefined) return;
    const wait = Math.max(0, MAP_REBUILD_MS - (performance.now() - lastBuild.current));
    pendingBuild.current = window.setTimeout(() => {
      pendingBuild.current = undefined;
      rebuild.current(false);
    }, wait);
  }, [mapVersion]);
  useEffect(
    () => () => {
      window.clearTimeout(pendingBuild.current);
      if (pass.current) cancelAnimationFrame(pass.current.frame);
    },
    [],
  );

  // ------------------------------------------------------------------ turtles, jobs, depots

  useEffect(() => {
    const s = s3.current;
    if (!s) return;
    for (const c of [...s.overlays.children]) {
      s.overlays.remove(c);
      c.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose?.();
      });
    }
    s.turtleMeshes = [];
    const box = (b: { min: Vec3; max: Vec3 }, col: string, opacity = 1) => {
      const g = new THREE.BoxGeometry(b.max.x - b.min.x + 1, b.max.y - b.min.y + 1, b.max.z - b.min.z + 1);
      const line = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: col, transparent: opacity < 1, opacity }));
      g.dispose();
      line.position.set((b.min.x + b.max.x + 1) / 2, (b.min.y + b.max.y + 1) / 2, (b.min.z + b.max.z + 1) / 2);
      s.overlays.add(line);
    };
    const path = (cells: Vec3[], col: string) => {
      if (cells.length < 2) return;
      const g = new THREE.BufferGeometry().setFromPoints(cells.map((c) => new THREE.Vector3(c.x + 0.5, c.y + 0.5, c.z + 0.5)));
      s.overlays.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: col })));
    };

    // Job areas (running brighter) and the draft being set up in the job form.
    for (const j of Object.values(jobs)) {
      if (j.world !== world || j.dimension !== dimension || j.status === 'completed' || j.status === 'cancelled') continue;
      const running = j.status === 'running' || j.status === 'pausing';
      const segs = (j.segments ?? []).map(sectionBox);
      // A quarry's layers stack into one box: draw its outline once.
      const parts = j.strategy === 'quarry' && segs.length ? [segs.reduce((a, b) => ({ min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y), z: Math.min(a.min.z, b.min.z) }, max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y), z: Math.max(a.max.z, b.max.z) } }))] : segs;
      for (const b of parts) box(b, running ? '#22d3ee' : '#64748b', running ? 0.9 : 0.5);
      const pos = turtles[j.turtleId]?.state?.pose.pos;
      if (running && j.route?.length) path(pos ? [pos, ...j.route] : j.route, '#facc15');
    }
    for (const seg of (jobDraft ?? []) as TunnelParams[]) box(sectionBox(seg), '#f59e0b');
    for (const d of Object.values(depots)) {
      if (d.world !== world || d.dimension !== dimension) continue;
      box({ min: d.dock, max: d.dock }, '#4ade80');
      for (const w of d.waiting) box({ min: w, max: w }, '#4ade80', 0.4);
    }

    // Turtles: a body in the status colour with a nose showing the heading.
    const keep = new Set<string>();
    for (const t of Object.values(turtles)) {
      const p = t.state?.pose.pos;
      if (!p || t.world !== world || t.dimension !== dimension) continue;
      keep.add(t.id);
      const g = new THREE.Group();
      g.position.set(p.x + 0.5, p.y + 0.5, p.z + 0.5);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.78, 0.78), new THREE.MeshLambertMaterial({ color: color(STATUS_COLOR[statusOf(t)]), emissive: '#ffffff', emissiveIntensity: 0.12 }));
      body.userData.turtleId = t.id;
      g.add(body);
      const h = t.state?.pose.heading;
      if (h !== undefined) {
        const nose = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.45, 12), new THREE.MeshLambertMaterial({ color: '#f8fafc' }));
        const v = HEADING_VECTORS[h];
        nose.position.set(v.x * 0.55, 0, v.z * 0.55);
        nose.rotation.set(v.z * Math.PI / 2, 0, -v.x * Math.PI / 2);
        nose.userData.turtleId = t.id;
        g.add(nose);
      }
      if (selection.includes(t.id)) {
        const sel = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.02, 1.02, 1.02)), new THREE.LineBasicMaterial({ color: '#ffffff' }));
        g.add(sel);
      }
      s.overlays.add(g);
      s.turtleMeshes.push(body);
      // Name tag.
      let tag = s.labels.get(t.id);
      if (!tag) {
        const el = document.createElement('div');
        el.className = 'pointer-events-none absolute left-0 top-0 whitespace-nowrap rounded bg-black/70 px-1 text-[10px] text-slate-100';
        labelRef.current?.appendChild(el);
        tag = { el, pos: new THREE.Vector3() };
        s.labels.set(t.id, tag);
      }
      tag.el.textContent = t.name;
      tag.el.style.outline = selection.includes(t.id) ? '1px solid #22d3ee' : '';
      tag.pos.set(p.x + 0.5, p.y + 1.1, p.z + 0.5);
    }
    for (const [id, tag] of s.labels) {
      if (keep.has(id)) continue;
      tag.el.remove();
      s.labels.delete(id);
    }
  }, [turtles, jobs, depots, jobDraft, selection, world, dimension]);

  // ------------------------------------------------------------------ mouse

  // ------------------------------------------------------------------ overview inset

  const overviewRef = useRef<HTMLCanvasElement>(null);
  const [ovPx, setOvPx] = useState(OVERVIEW_MAX);
  const [showOverview, setShowOverview] = useState(() => {
    try {
      return localStorage.getItem('ccf.overview3d') !== 'off';
    } catch {
      return true;
    }
  });
  const toggleOverview = () => {
    setShowOverview((v) => {
      try {
        localStorage.setItem('ccf.overview3d', v ? 'off' : 'on');
      } catch {
        /* private mode: just not remembered */
      }
      return !v;
    });
  };
  const frameRef = useRef<Frame | undefined>(undefined);
  const drawOverview = useRef<() => void>(() => {});
  drawOverview.current = () => {
    const canvas = overviewRef.current;
    const s = s3.current;
    if (!canvas || !s) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    if (canvas.width !== ovPx * dpr) {
      canvas.width = ovPx * dpr;
      canvas.height = ovPx * dpr;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const box = { x0: center.x - R, x1: center.x + R, z0: center.z - R, z1: center.z + R };
    const here = Object.values(turtles).filter((t) => t.world === world && t.dimension === dimension && t.state?.pose.pos);
    const docks = Object.values(depots).filter((d) => d.world === world && d.dimension === dimension);
    const f = overviewFrame(box, [...here.map((t) => t.state!.pose.pos!), ...docks.map((d) => d.dock)]);
    frameRef.current = f;
    const at = (x: number, z: number) => toInset(f, ovPx, x, z);
    const rect = (x0: number, z0: number, x1: number, z1: number) => {
      const a = at(x0, z0);
      const b = at(x1 + 1, z1 + 1);
      return [a.px, a.py, b.px - a.px, b.py - a.py] as const;
    };
    ctx.clearRect(0, 0, ovPx, ovPx);
    ctx.fillStyle = 'rgba(7, 11, 18, 0.88)';
    ctx.fillRect(0, 0, ovPx, ovPx);
    // Chunks in the 3D area that have something mapped.
    ctx.fillStyle = 'rgba(148, 163, 184, 0.35)';
    for (const [k, c] of s.chunks) {
      if (!c.blocks) continue;
      const [cx, cz] = k.split(',').map(Number);
      ctx.fillRect(...rect(cx * 16, cz * 16, cx * 16 + 15, cz * 16 + 15));
    }
    // Job areas.
    for (const j of Object.values(jobs)) {
      if (j.world !== world || j.dimension !== dimension || j.status === 'completed' || j.status === 'cancelled') continue;
      ctx.strokeStyle = j.status === 'running' || j.status === 'pausing' ? 'rgba(34, 211, 238, 0.8)' : 'rgba(100, 116, 139, 0.8)';
      ctx.lineWidth = 1;
      for (const seg of j.segments ?? []) {
        const b = sectionBox(seg);
        ctx.strokeRect(...rect(b.min.x, b.min.z, b.max.x, b.max.z));
      }
    }
    // The 3D area.
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(...rect(box.x0, box.z0, box.x1, box.z1));
    // Depots and turtles.
    for (const d of docks) {
      const p = at(d.dock.x + 0.5, d.dock.z + 0.5);
      ctx.fillStyle = '#4ade80';
      ctx.fillRect(p.px - 2.5, p.py - 2.5, 5, 5);
    }
    for (const t of here) {
      const pos = t.state!.pose.pos!;
      const p = at(pos.x + 0.5, pos.z + 0.5);
      ctx.beginPath();
      ctx.arc(p.px, p.py, 3, 0, Math.PI * 2);
      ctx.fillStyle = STATUS_COLOR[statusOf(t)];
      ctx.fill();
      if (selection.includes(t.id)) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    // Where the camera looks.
    const dir = s.controls.target.clone().sub(s.camera.position);
    const len = Math.hypot(dir.x, dir.z);
    if (len > 0.01) {
      const c = at(s.controls.target.x, s.controls.target.z);
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(c.px - (dir.x / len) * 10, c.py - (dir.z / len) * 10);
      ctx.lineTo(c.px + (dir.x / len) * 8, c.py + (dir.z / len) * 8);
      ctx.stroke();
    }
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px system-ui';
    ctx.fillText('N', ovPx / 2 - 3, 11);
    ctx.fillText(`${Math.round(f.half * 2)} m`, 4, ovPx - 4);
  };
  useEffect(() => drawOverview.current(), [center, turtles, depots, jobs, selection, stats, world, dimension, ovPx, showOverview]);
  const onOverviewClick = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const f = frameRef.current;
    if (!f) return;
    const r = e.currentTarget.getBoundingClientRect();
    const p = fromInset(f, ovPx, ((e.clientX - r.left) / r.width) * ovPx, ((e.clientY - r.top) / r.height) * ovPx);
    setCenter((c) => ({ x: p.x, y: c.y, z: p.z }));
  };

  const ray = useRef(new THREE.Raycaster());
  const pick = (e: React.PointerEvent | React.MouseEvent) => {
    const s = s3.current!;
    const r = s.renderer.domElement.getBoundingClientRect();
    ray.current.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), s.camera);
    return ray.current;
  };
  /** The nearest block under the mouse, with the face it was hit on. */
  const pickHit = (e: React.PointerEvent | React.MouseEvent) => {
    const s = s3.current;
    if (!s) return undefined;
    const rc = pick(e);
    let best: { block: MapBlock; d: number; normal?: THREE.Vector3 } | undefined;
    for (const { mesh, cells } of [...s.chunks.values()].flatMap((c) => c.pickable)) {
      // In x-ray, faded blocks don't get in the way of picking ores.
      if (xray && (mesh.material as THREE.Material).transparent) continue;
      const hit = rc.intersectObject(mesh)[0];
      if (hit?.instanceId !== undefined && (!best || hit.distance < best.d)) best = { block: cells[hit.instanceId], d: hit.distance, normal: hit.face?.normal };
    }
    return best;
  };
  const pickBlock = (e: React.PointerEvent | React.MouseEvent) => pickHit(e)?.block;
  const down = useRef<{ x: number; y: number } | undefined>(undefined);
  const onMove = (e: React.PointerEvent) => {
    if (e.buttons) return setHover(undefined);
    const b = pickBlock(e);
    const r = wrapRef.current!.getBoundingClientRect();
    setHover(b ? { block: b, sx: e.clientX - r.left, sy: e.clientY - r.top } : undefined);
  };
  const onUp = (e: React.PointerEvent) => {
    const d = down.current;
    down.current = undefined;
    if (!d || Math.abs(d.x - e.clientX) + Math.abs(d.y - e.clientY) > 4) return;
    const s = s3.current;
    if (!s) return;
    if (e.button === 2) {
      // Right-click (not a pan): the menu for the turtle or block under the mouse.
      const th = pick(e).intersectObjects(s.turtleMeshes, false)[0];
      const bh = pickHit(e);
      const turtleId = th && (!bh || th.distance <= bh.d) ? (th.object.userData.turtleId as string) : undefined;
      // The open cell on the side of the block that was clicked.
      const n = bh?.normal;
      const cell = bh && n ? { x: bh.block.x + Math.round(n.x), y: bh.block.y + Math.round(n.y), z: bh.block.z + Math.round(n.z) } : undefined;
      setHover(undefined);
      useFleet.getState().setContextMenu({ x: e.clientX, y: e.clientY, view: '3d', cell, block: bh?.block, turtleId });
      return;
    }
    if (e.button !== 0) return;
    const hit = pick(e).intersectObjects(s.turtleMeshes, false)[0];
    const id = hit?.object.userData.turtleId as string | undefined;
    const st = useFleet.getState();
    if (id) {
      st.select([id], e.shiftKey ? 'toggle' : 'replace');
      st.focus(id);
    } else if (!e.shiftKey) st.select([]);
  };
  const onDouble = (e: React.MouseEvent) => {
    const b = pickBlock(e);
    const s = s3.current;
    if (b && s) s.controls.target.set(b.x + 0.5, b.y + 0.5, b.z + 0.5);
  };

  return (
    <div className="absolute inset-0">
      <div
        ref={wrapRef}
        className="absolute inset-0"
        onPointerDown={(e) => (down.current = { x: e.clientX, y: e.clientY })}
        onPointerUp={onUp}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(undefined)}
        onDoubleClick={onDouble}
      />
      <div ref={labelRef} className="pointer-events-none absolute inset-0 overflow-hidden" />
      {showOverview && (
        <canvas
          ref={overviewRef}
          onPointerDown={onOverviewClick}
          className="absolute right-3 top-3 cursor-crosshair rounded border border-edge shadow-lg shadow-black/50"
          style={{ width: ovPx, height: ovPx }}
          title="Overview: the cyan frame is the 3D area. Click to move it there."
        />
      )}
      <div className="absolute left-3 top-3 flex flex-wrap items-center gap-1 rounded bg-black/60 px-2 py-1 text-[10px] text-dim">
        <button onClick={() => setXray(!xray)} className={`rounded border px-2 py-0.5 ${xray ? 'border-sky-600 bg-sky-950/70 text-sky-200' : 'border-edge text-dim'}`} title="Fade ordinary blocks so ores and tunnels stand out">
          X-ray {xray ? 'on' : 'off'}
        </button>
        <button onClick={() => setCut(!cut)} className={`rounded border px-2 py-0.5 ${cut ? 'border-sky-600 bg-sky-950/70 text-sky-200' : 'border-edge text-dim'}`} title="Hide everything above the Y level (the slider on the right)">
          Cut above Y {y}
        </button>
        <button onClick={() => setCenter(initial())} className="rounded border border-edge px-2 py-0.5 text-dim hover:text-ink" title="Centre on the focused turtle">
          Re-centre
        </button>
        <button onClick={toggleOverview} className={`rounded border px-2 py-0.5 ${showOverview ? 'border-sky-600 bg-sky-950/70 text-sky-200' : 'border-edge text-dim'}`} title="Show or hide the top-down overview">
          Overview {showOverview ? 'on' : 'off'}
        </button>
        <span className="ml-1 font-mono">
          {stats.blocks} blocks · {stats.ores} ores · centre {center.x} {center.y} {center.z}
          {stats.building > 0 && <span className="text-sky-300"> · loading {stats.building} chunks</span>}
          {stats.capped > 0 && (
            <span className="text-amber-300" title={`Over ${MAX_INSTANCES.toLocaleString()} blocks: the farthest of the near chunks show only their top surface and ores`}>
              {' '}
              · detail reduced in {stats.capped} chunks
            </span>
          )}
        </span>
      </div>
      <div className="pointer-events-none absolute bottom-3 left-3 rounded bg-black/55 px-2 py-1 font-mono text-[10px] text-dim">
        left-drag: orbit · right-drag: pan · right-click: menu · wheel: zoom · click: select turtle · double-click: look at block
      </div>
      {hover && (
        <div className="pointer-events-none absolute rounded bg-black/80 px-2 py-1 text-[11px] text-ink" style={{ left: hover.sx + 14, top: hover.sy + 10 }}>
          <div>{shortItem(hover.block.block ?? hover.block.cell)}</div>
          <div className="font-mono text-[10px] text-dim">
            {hover.block.x} {hover.block.y} {hover.block.z}
          </div>
        </div>
      )}
    </div>
  );
}
