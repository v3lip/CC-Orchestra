import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MapBlock, Vec3 } from '@ccfleet/protocol';
import { oreMatches } from '@ccfleet/protocol';
import { api } from '../lib/api';
import { useFleet } from '../lib/store';
import { blockColor, shortItem } from '../lib/status';

interface Vein {
  block: string;
  cells: MapBlock[];
  /** The cell nearest the reference point. */
  near: MapBlock;
  dist: number;
}

const dist3 = (a: Vec3, b: Vec3) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);

/** Split ore blocks into veins: blocks of the same id that touch (face to face). */
function veinsOf(ores: MapBlock[], ref: Vec3 | undefined): Vein[] {
  const byKey = new Map(ores.map((o) => [`${o.x},${o.y},${o.z}`, o]));
  const seen = new Set<string>();
  const out: Vein[] = [];
  for (const o of ores) {
    const k0 = `${o.x},${o.y},${o.z}`;
    if (seen.has(k0)) continue;
    seen.add(k0);
    const cells: MapBlock[] = [];
    const stack = [o];
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      for (const [dx, dy, dz] of [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ]) {
        const k = `${c.x + dx},${c.y + dy},${c.z + dz}`;
        const n = byKey.get(k);
        if (n && !seen.has(k) && n.block === o.block) {
          seen.add(k);
          stack.push(n);
        }
      }
    }
    const near = ref ? cells.reduce((a, b) => (dist3(a, ref) <= dist3(b, ref) ? a : b)) : cells[0];
    out.push({ block: o.block!, cells, near, dist: ref ? dist3(near, ref) : 0 });
  }
  return out.sort((a, b) => a.dist - b.dist);
}

/**
 * Ores the turtles have seen (wall scans, vein following, inspections) and nobody has
 * mined yet, grouped by type and vein, nearest first. Click one to show it on the map.
 */
export function OresPanel() {
  const world = useFleet((s) => s.world);
  const dimension = useFleet((s) => s.dimension);
  const turtles = useFleet((s) => s.turtles);
  const focusId = useFleet((s) => s.focusId);
  const depots = useFleet((s) => s.depots);
  const centerOn = useFleet((s) => s.centerOn);
  const setFollowY = useFleet((s) => s.setFollowY);
  const [ores, setOres] = useState<MapBlock[]>();
  const [err, setErr] = useState<string>();
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const load = useCallback(() => {
    api
      .ores(world, dimension)
      .then((r) => {
        setOres(r.ores);
        setErr(undefined);
      })
      .catch((e) => setErr((e as Error).message));
  }, [world, dimension]);
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  // Distances from the focused turtle, else the first depot here.
  const focus = focusId ? turtles[focusId] : undefined;
  const depot = Object.values(depots).find((d) => d.world === world && d.dimension === dimension);
  const ref = (focus?.world === world && focus.state?.pose.pos) || depot?.dock;
  const refName = focus?.world === world && focus.state?.pose.pos ? focus.name : depot ? `depot ${depot.name}` : undefined;

  const groups = useMemo(() => {
    const shown = (ores ?? []).filter((o) => !filter.trim() || filter.split(',').some((f) => oreMatches(f, o.block)));
    const byBlock = new Map<string, MapBlock[]>();
    for (const o of shown) byBlock.set(o.block!, [...(byBlock.get(o.block!) ?? []), o]);
    return [...byBlock.entries()]
      .map(([block, list]) => ({ block, count: list.length, veins: veinsOf(list, ref) }))
      .sort((a, b) => shortItem(a.block).localeCompare(shortItem(b.block)));
  }, [ores, filter, ref]);

  const jump = (c: Vec3) => {
    setFollowY(false);
    centerOn(c.x, c.z, c.y);
  };

  return (
    <div className="space-y-2 p-3 text-xs">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-dim">Ores seen, not mined</h3>
        <button onClick={load} className="rounded border border-edge px-2 py-0.5 text-[11px] text-dim hover:text-ink">
          Refresh
        </button>
      </div>
      <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter: diamond, Coal Ore, any…" className="inp w-full" />
      <p className="text-[11px] text-dim">
        Found by wall scans, vein following and inspecting. {refName ? `Distances from ${refName}.` : ''} Click a vein to show it on the map.
      </p>
      {err && <p className="text-red-300">{err}</p>}
      {!ores && !err && <p className="text-dim">Loading…</p>}
      {ores && groups.length === 0 && <p className="text-dim">{ores.length ? 'Nothing matches the filter.' : 'No ores seen here yet. Turn on "Scan the walls" in a job to find them.'}</p>}
      {groups.map((g) => (
        <div key={g.block} className="rounded border border-edge bg-panel-2">
          <button onClick={() => setOpen({ ...open, [g.block]: !open[g.block] })} className="flex w-full items-center gap-2 px-2 py-1.5 text-left">
            <span className="text-dim">{open[g.block] ? '▾' : '▸'}</span>
            <span className="inline-block h-2.5 w-2.5 rotate-45" style={{ background: blockColor(g.block) }} />
            <span className="flex-1 truncate" title={g.block}>
              {shortItem(g.block)}
            </span>
            <span className="font-mono text-[11px] text-dim">
              {g.count} in {g.veins.length} vein{g.veins.length === 1 ? '' : 's'}
            </span>
          </button>
          {open[g.block] && (
            <div className="border-t border-edge">
              {g.veins.slice(0, 50).map((v) => (
                <button
                  key={`${v.near.x},${v.near.y},${v.near.z}`}
                  onClick={() => jump(v.near)}
                  className="flex w-full items-center gap-2 px-2 py-1 text-left font-mono text-[11px] hover:bg-black/30"
                  title="Show on the map"
                >
                  <span className="w-12 text-dim">{v.cells.length} blk</span>
                  <span className="flex-1">
                    {v.near.x} {v.near.y} {v.near.z}
                  </span>
                  {ref && <span className="text-dim">{v.dist} away</span>}
                </button>
              ))}
              {g.veins.length > 50 && <p className="px-2 py-1 text-[11px] text-dim">…and {g.veins.length - 50} more</p>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
