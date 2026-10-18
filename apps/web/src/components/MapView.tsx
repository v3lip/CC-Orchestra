import { useEffect, useRef, useState } from 'react';
import type { DepotView, JobView, TunnelParams, TurtleView } from '@ccfleet/protocol';
import { HEADING_VECTORS } from '@ccfleet/protocol';
import { mapCache, useFleet } from '../lib/store';
import { STATUS_COLOR, blockColor, shortItem, statusOf } from '../lib/status';

interface Camera {
  x: number; // block coords at the screen centre
  z: number;
  scale: number; // pixels per block
}

const MIN_SCALE = 2;
const MAX_SCALE = 48;

/**
 * 2D slice map: one Y level at a time, north (-Z) up, east (+X) right.
 * Only observed cells are drawn; everything else is visibly "unknown".
 */
export function MapView() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cam = useRef<Camera>({ x: 0, z: 0, scale: 14 });
  const drag = useRef<{ kind: 'pan' | 'box'; sx: number; sy: number; cx: number; cz: number; ex: number; ey: number; additive: boolean } | null>(null);
  const [hover, setHover] = useState<{ x: number; z: number } | null>(null);
  const [, force] = useState(0);
  const redraw = useRef<() => void>(() => {});

  const turtles = useFleet((s) => s.turtles);
  const selection = useFleet((s) => s.selection);
  const focusId = useFleet((s) => s.focusId);
  const world = useFleet((s) => s.world);
  const dimension = useFleet((s) => s.dimension);
  const y = useFleet((s) => s.y);
  const mapVersion = useFleet((s) => s.mapVersion);
  const centerTarget = useFleet((s) => s.centerTarget);
  const jobs = useFleet((s) => s.jobs);
  const depots = useFleet((s) => s.depots);
  const jobDraft = useFleet((s) => s.jobDraft);

  const visibleTurtles = Object.values(turtles).filter((t) => t.world === world && t.dimension === dimension && t.state?.pose.pos);

  useEffect(() => {
    if (!centerTarget) return;
    cam.current.x = centerTarget.x + 0.5;
    cam.current.z = centerTarget.z + 0.5;
    redraw.current();
  }, [centerTarget]);

  // ------------------------------------------------------------------ drawing

  redraw.current = () => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { x: cx, z: cz, scale: s } = cam.current;
    const toSx = (x: number) => (x - cx) * s + w / 2;
    const toSy = (z: number) => (z - cz) * s + h / 2;
    const x0 = Math.floor(cx - w / 2 / s) - 1;
    const x1 = Math.ceil(cx + w / 2 / s) + 1;
    const z0 = Math.floor(cz - h / 2 / s) - 1;
    const z1 = Math.ceil(cz + h / 2 / s) + 1;

    mapCache.ensure(world, dimension, x0, x1, z0, z1, y, () => force((n) => n + 1));

    // Unknown space: dark with a faint hatch so it never reads as "air".
    ctx.fillStyle = '#080c13';
    ctx.fillRect(0, 0, w, h);
    if (s >= 6) {
      ctx.strokeStyle = 'rgba(80,100,130,0.07)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = x0; x <= x1; x++) {
        const sx = Math.round(toSx(x)) + 0.5;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, h);
      }
      for (let z = z0; z <= z1; z++) {
        const sy = Math.round(toSy(z)) + 0.5;
        ctx.moveTo(0, sy);
        ctx.lineTo(w, sy);
      }
      ctx.stroke();
    }

    const cell = Math.ceil(s);
    // Floor hint: what was seen one level below, where this level is unknown.
    const here = mapCache.layer(y);
    const below = mapCache.layer(y - 1);
    if (below) {
      ctx.globalAlpha = 0.22;
      for (const b of below.values()) {
        if (b.x < x0 || b.x > x1 || b.z < z0 || b.z > z1 || here?.has(`${b.x},${b.z}`) || !b.block) continue;
        ctx.fillStyle = blockColor(b.block);
        ctx.fillRect(Math.floor(toSx(b.x)), Math.floor(toSy(b.z)), cell, cell);
      }
      ctx.globalAlpha = 1;
    }
    if (here) {
      for (const b of here.values()) {
        if (b.x < x0 || b.x > x1 || b.z < z0 || b.z > z1) continue;
        const sx = Math.floor(toSx(b.x));
        const sy = Math.floor(toSy(b.z));
        if (b.cell === 'empty') {
          ctx.fillStyle = '#16233a'; // known traversable space
          ctx.fillRect(sx, sy, cell, cell);
        } else {
          ctx.fillStyle = blockColor(b.block!);
          ctx.fillRect(sx, sy, cell, cell);
          if (s >= 10 && b.cell === 'solid') {
            ctx.fillStyle = 'rgba(0,0,0,0.18)';
            ctx.fillRect(sx, sy + cell - 2, cell, 2);
          }
        }
      }
    }

    // Origin axes, for orientation.
    ctx.strokeStyle = 'rgba(34,211,238,0.15)';
    ctx.beginPath();
    ctx.moveTo(toSx(0), 0);
    ctx.lineTo(toSx(0), h);
    ctx.moveTo(0, toSy(0));
    ctx.lineTo(w, toSy(0));
    ctx.stroke();

    // Depots, job volumes, planned routes.
    for (const d of Object.values(depots)) if (d.world === world && d.dimension === dimension) drawDepot(ctx, d, toSx, toSy, s, y);
    for (const j of Object.values(jobs)) {
      if (j.world !== world || j.dimension !== dimension || j.status === 'completed' || j.status === 'cancelled') continue;
      drawTunnel(ctx, j.params, toSx, toSy, s, y, j.progress.unitsDone, false);
      if (j.route?.length) drawRoute(ctx, j, toSx, toSy, y);
    }
    for (const d of jobDraft ?? []) drawTunnel(ctx, d, toSx, toSy, s, y, 0, true);

    // Turtles.
    const sel = new Set(selection);
    for (const t of visibleTurtles) drawTurtle(ctx, t, toSx, toSy, s, y, sel.has(t.id), t.id === focusId);

    // Box selection.
    const d = drag.current;
    if (d?.kind === 'box') {
      ctx.fillStyle = 'rgba(34,211,238,0.08)';
      ctx.strokeStyle = 'rgba(34,211,238,0.8)';
      ctx.setLineDash([4, 3]);
      const rx = Math.min(d.sx, d.ex);
      const ry = Math.min(d.sy, d.ey);
      ctx.fillRect(rx, ry, Math.abs(d.ex - d.sx), Math.abs(d.ey - d.sy));
      ctx.strokeRect(rx + 0.5, ry + 0.5, Math.abs(d.ex - d.sx), Math.abs(d.ey - d.sy));
      ctx.setLineDash([]);
    }
  };

  useEffect(() => {
    redraw.current();
  });
  useEffect(() => {
    const ro = new ResizeObserver(() => redraw.current());
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);
  void mapVersion;

  // ------------------------------------------------------------------ interaction

  const toWorld = (clientX: number, clientY: number) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const { x, z, scale } = cam.current;
    return { x: (clientX - r.left - r.width / 2) / scale + x, z: (clientY - r.top - r.height / 2) / scale + z };
  };

  const turtleAt = (clientX: number, clientY: number): TurtleView | undefined => {
    const p = toWorld(clientX, clientY);
    let best: TurtleView | undefined;
    let bestD = 0.75;
    for (const t of visibleTurtles) {
      const pos = t.state!.pose.pos!;
      const dist = Math.hypot(pos.x + 0.5 - p.x, pos.z + 0.5 - p.z);
      // Prefer the turtle on the current level when several share a column.
      const penalty = pos.y === y ? 0 : 0.3;
      if (dist + penalty < bestD) {
        bestD = dist + penalty;
        best = t;
      }
    }
    return best;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const r = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    if (e.button === 1 || e.button === 2) {
      drag.current = { kind: 'pan', sx, sy, cx: cam.current.x, cz: cam.current.z, ex: sx, ey: sy, additive: false };
      return;
    }
    if (e.button === 0) drag.current = { kind: 'box', sx, sy, cx: 0, cz: 0, ex: sx, ey: sy, additive: e.shiftKey || e.ctrlKey };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toWorld(e.clientX, e.clientY);
    setHover({ x: Math.floor(p.x), z: Math.floor(p.z) });
    const d = drag.current;
    if (!d) return;
    const r = canvasRef.current!.getBoundingClientRect();
    d.ex = e.clientX - r.left;
    d.ey = e.clientY - r.top;
    if (d.kind === 'pan') {
      cam.current.x = d.cx - (d.ex - d.sx) / cam.current.scale;
      cam.current.z = d.cz - (d.ey - d.sy) / cam.current.scale;
    }
    redraw.current();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.kind !== 'box') return redraw.current();
    const st = useFleet.getState();
    const moved = Math.abs(d.ex - d.sx) + Math.abs(d.ey - d.sy) > 4;
    if (!moved) {
      const t = turtleAt(e.clientX, e.clientY);
      if (t) st.select([t.id], e.shiftKey || e.ctrlKey ? 'toggle' : 'replace');
      else if (!d.additive) st.select([]);
    } else {
      const r = canvasRef.current!.getBoundingClientRect();
      const a = toWorld(Math.min(d.sx, d.ex) + r.left, Math.min(d.sy, d.ey) + r.top);
      const b = toWorld(Math.max(d.sx, d.ex) + r.left, Math.max(d.sy, d.ey) + r.top);
      const ids = visibleTurtles
        .filter((t) => {
          const p = t.state!.pose.pos!;
          return p.x + 0.5 >= a.x && p.x + 0.5 <= b.x && p.z + 0.5 >= a.z && p.z + 0.5 <= b.z;
        })
        .map((t) => t.id);
      st.select(ids, d.additive ? 'add' : 'replace');
    }
    redraw.current();
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const t = turtleAt(e.clientX, e.clientY);
    if (t) useFleet.getState().focus(t.id, true);
  };

  useEffect(() => {
    const el = canvasRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.altKey) {
        // Alt+wheel steps through Y levels.
        const st = useFleet.getState();
        st.setFollowY(false);
        st.setY(st.y + (e.deltaY < 0 ? 1 : -1));
        return;
      }
      const before = toWorld(e.clientX, e.clientY);
      const c = cam.current;
      c.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, c.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      const after = toWorld(e.clientX, e.clientY);
      c.x += before.x - after.x;
      c.z += before.z - after.z;
      redraw.current();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const hoverBlock = hover ? mapCache.layer(y)?.get(`${hover.x},${hover.z}`) : undefined;

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden select-none">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 cursor-crosshair"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="pointer-events-none absolute left-3 bottom-3 rounded bg-black/60 px-2 py-1 text-xs text-dim num">
        {hover ? (
          <>
            X {hover.x} · Y {y} · Z {hover.z} —{' '}
            {hoverBlock ? (hoverBlock.block ? shortItem(hoverBlock.block) : 'known empty') : <span className="text-slate-500">unknown</span>}
          </>
        ) : (
          'drag: select · right-drag: pan · wheel: zoom · alt+wheel: Y level · double-click: focus'
        )}
      </div>
      <div className="pointer-events-none absolute right-3 top-3 flex flex-col items-center rounded bg-black/50 px-2 py-1 text-[10px] text-dim">
        <span className="text-ink font-semibold">N</span>
        <span>−Z</span>
      </div>
      <Legend />
    </div>
  );
}

function drawTurtle(
  ctx: CanvasRenderingContext2D,
  t: TurtleView,
  toSx: (x: number) => number,
  toSy: (z: number) => number,
  s: number,
  y: number,
  selected: boolean,
  focused: boolean,
) {
  const pose = t.state!.pose;
  const pos = pose.pos!;
  const status = statusOf(t);
  const color = STATUS_COLOR[status];
  const sameLevel = pos.y === y;
  const r = Math.max(4, s * 0.42);
  const cx = toSx(pos.x + 0.5);
  const cy = toSy(pos.z + 0.5);
  const offline = t.connection === 'offline';

  ctx.save();
  ctx.globalAlpha = sameLevel ? 1 : 0.4;

  // Uncertain position: mark every cell the turtle might be in.
  if (pose.position === 'uncertain') {
    ctx.strokeStyle = '#fbbf24';
    ctx.setLineDash([3, 3]);
    for (const c of pose.candidates ?? [pos]) ctx.strokeRect(toSx(c.x) + 1, toSy(c.z) + 1, s - 2, s - 2);
    ctx.setLineDash([]);
  }

  if (selected) {
    ctx.strokeStyle = focused ? '#ffffff' : '#22d3ee';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Body: a triangle pointing along the heading; a circle if the heading is unknown.
  ctx.fillStyle = offline ? 'rgba(75,85,99,0.35)' : color;
  ctx.strokeStyle = offline ? '#9ca3af' : 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 1.5;
  if (offline) ctx.setLineDash([3, 2]);
  ctx.beginPath();
  if (pose.heading !== undefined && pose.headingConfidence !== 'unknown') {
    const angle = [-Math.PI / 2, 0, Math.PI / 2, Math.PI][pose.heading];
    for (let i = 0; i < 3; i++) {
      const a = angle + (i * 2 * Math.PI) / 3;
      const rr = i === 0 ? r * 1.15 : r * 0.85;
      const px = cx + Math.cos(a) * rr;
      const py = cy + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  } else {
    ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);

  if (pose.headingConfidence === 'uncertain' || pose.position === 'uncertain') {
    ctx.fillStyle = '#fbbf24';
    ctx.font = `bold ${Math.max(9, r)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText('?', cx + r + 4, cy - r);
  }

  if (s >= 9 || selected) {
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    const label = `${t.name}${sameLevel ? '' : pos.y > y ? ` ↑${pos.y - y}` : ` ↓${y - pos.y}`}${t.simulated ? ' ·sim' : ''}`;
    const tw = ctx.measureText(label).width;
    ctx.fillRect(cx - tw / 2 - 3, cy + r + 3, tw + 6, 14);
    ctx.fillStyle = offline ? '#9ca3af' : '#e2e8f0';
    ctx.fillText(label, cx, cy + r + 14);
  }
  ctx.restore();
}

function Legend() {
  return (
    <div className="pointer-events-none absolute left-3 top-3 flex gap-3 rounded bg-black/55 px-2 py-1 text-[10px] text-dim">
      <span className="flex items-center gap-1">
        <i className="inline-block h-2.5 w-2.5 border border-slate-700 bg-[#080c13]" /> unknown
      </span>
      <span className="flex items-center gap-1">
        <i className="inline-block h-2.5 w-2.5 bg-[#16233a]" /> known empty
      </span>
      <span className="flex items-center gap-1">
        <i className="inline-block h-2.5 w-2.5 bg-[#6b7280]" /> observed block
      </span>
      <span className="flex items-center gap-1">
        <i className="inline-block h-2.5 w-2.5 border border-dashed border-gray-400" /> offline (still an obstacle)
      </span>
      <span className="flex items-center gap-1 text-amber-300">? uncertain pose</span>
    </div>
  );
}

function tunnelCorner(p: TunnelParams, d: number, w: number) {
  const f = HEADING_VECTORS[p.heading];
  const r = HEADING_VECTORS[(p.heading + 1) % 4];
  return { x: p.origin.x + f.x * d + r.x * w, z: p.origin.z + f.z * d + r.z * w };
}

/** Outline of a tunnel at this Y level; finished slices shaded; drafts dashed. */
function drawTunnel(ctx: CanvasRenderingContext2D, p: TunnelParams, toSx: (x: number) => number, toSy: (z: number) => number, s: number, y: number, done: number, draft: boolean) {
  const onLevel = y >= p.origin.y && y < p.origin.y + p.height;
  const rect = (d0: number, d1: number) => {
    const a = tunnelCorner(p, d0, 0);
    const b = tunnelCorner(p, d1, p.width - 1);
    const x0 = Math.min(a.x, b.x);
    const z0 = Math.min(a.z, b.z);
    return [toSx(x0), toSy(z0), (Math.abs(a.x - b.x) + 1) * s, (Math.abs(a.z - b.z) + 1) * s] as const;
  };
  ctx.save();
  if (done > 0 && onLevel) {
    ctx.fillStyle = 'rgba(34,211,238,0.10)';
    ctx.fillRect(...rect(0, done - 1));
  }
  ctx.strokeStyle = draft ? '#e879f9' : '#22d3ee';
  ctx.globalAlpha = onLevel ? 0.9 : 0.3;
  ctx.lineWidth = 1.5;
  ctx.setLineDash(draft ? [6, 4] : onLevel ? [] : [2, 4]);
  const [rx, ry, rw, rh] = rect(0, p.length - 1);
  ctx.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
  // Arrow at the entrance showing the digging direction.
  const o = tunnelCorner(p, 0, 0);
  const f = HEADING_VECTORS[p.heading];
  const cx = toSx(o.x + 0.5 - f.x);
  const cy = toSy(o.z + 0.5 - f.z);
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + f.x * s * 0.9, cy + f.z * s * 0.9);
  ctx.stroke();
  ctx.restore();
}

function drawRoute(ctx: CanvasRenderingContext2D, j: JobView, toSx: (x: number) => number, toSy: (z: number) => number, y: number) {
  ctx.save();
  ctx.strokeStyle = '#a3e635';
  ctx.setLineDash([2, 3]);
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  j.route!.forEach((c, i) => {
    const px = toSx(c.x + 0.5);
    const py = toSy(c.z + 0.5);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
  ctx.restore();
  void y;
}

function drawDepot(ctx: CanvasRenderingContext2D, d: DepotView, toSx: (x: number) => number, toSy: (z: number) => number, s: number, y: number) {
  const at = (dir?: string) => {
    if (!dir) return undefined;
    if (dir === 'up') return { ...d.dock, y: d.dock.y + 1 };
    if (dir === 'down') return { ...d.dock, y: d.dock.y - 1 };
    const h = HEADING_VECTORS[d.dockHeading];
    return { x: d.dock.x + h.x, y: d.dock.y, z: d.dock.z + h.z };
  };
  ctx.save();
  ctx.globalAlpha = d.dock.y === y ? 1 : 0.4;
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 2;
  ctx.strokeRect(toSx(d.dock.x) + 1, toSy(d.dock.z) + 1, s - 2, s - 2);
  const markers: [string | undefined, string, string][] = [
    [d.unloadDir, '#d97706', 'C'],
    [d.fuelDir, '#57534e', 'F'],
  ];
  for (const [dir, color, letter] of markers) {
    const c = at(dir);
    if (!c) continue;
    ctx.globalAlpha = c.y === y ? 1 : 0.45;
    ctx.fillStyle = color;
    const inset = dir === 'front' ? 1 : s * 0.25; // chests above/below: smaller marker
    ctx.fillRect(toSx(c.x) + inset, toSy(c.z) + inset, s - 2 * inset, s - 2 * inset);
    if (s >= 12) {
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.min(12, s * 0.6)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.fillText(letter, toSx(c.x + 0.5), toSy(c.z + 0.5) + 4);
    }
  }
  if (s >= 10) {
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#67e8f9';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(d.name, toSx(d.dock.x + 0.5), toSy(d.dock.z) - 3);
  }
  ctx.restore();
}
