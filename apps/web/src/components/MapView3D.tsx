import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MapBlock, TunnelParams, Vec3 } from '@ccfleet/protocol';
import { HEADING_VECTORS, isOreBlock, sectionBox } from '@ccfleet/protocol';
import { mapCache, useFleet } from '../lib/store';
import { STATUS_COLOR, blockColor, shortItem, statusOf } from '../lib/status';

/** Blocks loaded and drawn around the centre: ±R across, BELOW under and ABOVE over it. */
const R = 40;
const BELOW = 28;
const ABOVE = 12;

const NEIGHBOURS: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** CSS colour (incl. "hsl(h s% l%)") to a three.js colour. */
function color(css: string): THREE.Color {
  const m = /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/.exec(css);
  return m ? new THREE.Color().setHSL(Number(m[1]) / 360, Number(m[2]) / 100, Number(m[3]) / 100, THREE.SRGBColorSpace) : new THREE.Color(css);
}

interface Scene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  blocks: THREE.Group;
  overlays: THREE.Group;
  /** Instanced meshes with the block behind each instance, for picking. */
  pickable: { mesh: THREE.InstancedMesh; cells: MapBlock[] }[];
  turtleMeshes: THREE.Object3D[];
  labels: Map<string, { el: HTMLDivElement; pos: THREE.Vector3 }>;
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
  const [stats, setStats] = useState({ blocks: 0, ores: 0 });

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
    scene.fog = new THREE.Fog('#070b12', 90, 180);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.15;
    controls.screenSpacePanning = true;
    scene.add(new THREE.HemisphereLight('#dbe7ff', '#202430', 1.6));
    const sun = new THREE.DirectionalLight('#ffffff', 1.6);
    sun.position.set(0.6, 1, 0.35);
    scene.add(sun);
    const blocks = new THREE.Group();
    const overlays = new THREE.Group();
    scene.add(blocks, overlays);
    s3.current = { renderer, scene, camera, controls, blocks, overlays, pickable: [], turtleMeshes: [], labels: new Map() };

    const resize = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      renderer.setSize(w, h);
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

  useEffect(() => {
    const s = s3.current;
    if (!s) return;
    const x0 = center.x - R;
    const x1 = center.x + R;
    const z0 = center.z - R;
    const z1 = center.z + R;
    const y0 = center.y - BELOW;
    const y1 = cut ? Math.min(center.y + ABOVE, y) : center.y + ABOVE;
    const at = (x: number, yy: number, z: number) => (yy > y1 || yy < y0 ? undefined : mapCache.layer(yy)?.get(`${x},${z}`));
    const solids: MapBlock[] = [];
    const ores: MapBlock[] = [];
    const fluids: MapBlock[] = [];
    for (let yy = y0; yy <= y1; yy++) {
      const layer = mapCache.layer(yy);
      if (!layer) continue;
      for (const b of layer.values()) {
        if (b.x < x0 || b.x > x1 || b.z < z0 || b.z > z1 || b.cell === 'empty') continue;
        if (b.cell === 'fluid') {
          fluids.push(b);
          continue;
        }
        if (isOreBlock(b.block)) {
          ores.push(b);
          continue;
        }
        // Skip blocks with a solid block on every side: they can't be seen.
        if (NEIGHBOURS.every(([dx, dy, dz]) => at(b.x + dx, b.y + dy, b.z + dz)?.cell === 'solid')) continue;
        solids.push(b);
      }
    }

    for (const c of [...s.blocks.children]) {
      s.blocks.remove(c);
      const m = c as THREE.InstancedMesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    s.pickable = [];
    const box = new THREE.BoxGeometry(1, 1, 1);
    const add = (cells: MapBlock[], material: THREE.Material, size = 1, tint?: (c: THREE.Color) => THREE.Color) => {
      if (!cells.length) return;
      const mesh = new THREE.InstancedMesh(box.clone(), material, cells.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const sc = new THREE.Vector3(size, size, size);
      cells.forEach((b, i) => {
        mesh.setMatrixAt(i, m.compose(new THREE.Vector3(b.x + 0.5, b.y + 0.5, b.z + 0.5), q, sc));
        const c = color(b.cell === 'fluid' ? (b.block?.includes('lava') ? '#c2410c' : '#1d4ed8') : blockColor(b.block ?? ''));
        mesh.setColorAt(i, tint ? tint(c) : c);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      s.blocks.add(mesh);
      s.pickable.push({ mesh, cells });
    };
    add(solids, xray ? new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.09, depthWrite: false }) : new THREE.MeshLambertMaterial());
    add(fluids, new THREE.MeshLambertMaterial({ transparent: true, opacity: xray ? 0.12 : 0.55, depthWrite: false }));
    // Ores unlit in their own colour (lightened so dark ones like coal still show), outlined.
    const white = new THREE.Color('#ffffff');
    add(ores, new THREE.MeshBasicMaterial(), xray ? 0.8 : 1.002, (c) => c.lerp(white, 0.25));
    if (ores.length) {
      const pts: number[] = [];
      const e = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.04, 1.04, 1.04)).getAttribute('position');
      for (const b of ores.slice(0, 4000)) for (let i = 0; i < e.count; i++) pts.push(e.getX(i) + b.x + 0.5, e.getY(i) + b.y + 0.5, e.getZ(i) + b.z + 0.5);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      s.blocks.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.7 })));
    }
    box.dispose();
    setStats({ blocks: solids.length + fluids.length + ores.length, ores: ores.length });
  }, [mapVersion, center, xray, cut, y, world, dimension]);

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

  const ray = useRef(new THREE.Raycaster());
  const pick = (e: React.PointerEvent | React.MouseEvent) => {
    const s = s3.current!;
    const r = s.renderer.domElement.getBoundingClientRect();
    ray.current.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), s.camera);
    return ray.current;
  };
  const pickBlock = (e: React.PointerEvent | React.MouseEvent) => {
    const s = s3.current;
    if (!s) return undefined;
    const rc = pick(e);
    let best: { block: MapBlock; d: number } | undefined;
    for (const { mesh, cells } of s.pickable) {
      // In x-ray, faded blocks don't get in the way of picking ores.
      if (xray && (mesh.material as THREE.Material).transparent) continue;
      const hit = rc.intersectObject(mesh)[0];
      if (hit?.instanceId !== undefined && (!best || hit.distance < best.d)) best = { block: cells[hit.instanceId], d: hit.distance };
    }
    return best?.block;
  };
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
    if (!d || Math.abs(d.x - e.clientX) + Math.abs(d.y - e.clientY) > 4 || e.button !== 0) return;
    const s = s3.current;
    if (!s) return;
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
        <span className="ml-1 font-mono">
          {stats.blocks} blocks · {stats.ores} ores · centre {center.x} {center.y} {center.z}
        </span>
      </div>
      <div className="pointer-events-none absolute bottom-3 left-3 rounded bg-black/55 px-2 py-1 font-mono text-[10px] text-dim">
        left-drag: orbit · right-drag: pan · wheel: zoom · click: select turtle · double-click: look at block
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
