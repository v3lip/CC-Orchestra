import { useEffect, useMemo, useState } from 'react';
import type { Box, Heading, JobEstimate, JobInput, Strategy, StrategyInput, TunnelParams, TurtleView } from '@ccfleet/protocol';
import { HEADING_VECTORS, ORE_PRESETS, sectionBox, segmentsFor } from '@ccfleet/protocol';
import { api } from '../lib/api';
import { useFleet } from '../lib/store';
import { Field } from './DepotsPanel';

const overlap = (a: Box, b: Box) =>
  a.min.x <= b.max.x && b.min.x <= a.max.x && a.min.y <= b.max.y && b.min.y <= a.max.y && a.min.z <= b.max.z && b.min.z <= a.max.z;
const segsOverlap = (a: TunnelParams[], b: TunnelParams[]) => a.some((x) => b.some((y) => overlap(sectionBox(x), sectionBox(y))));

const STRATEGIES: { id: Strategy; label: string; help: string }[] = [
  { id: 'tunnel', label: 'Tunnel', help: 'A straight tunnel: width × height × length.' },
  { id: 'branch', label: 'Branch', help: 'Branch mine: a main corridor with side branches every few blocks — the efficient way to find ores.' },
  { id: 'quarry', label: 'Quarry', help: 'Clear a box from the top down, layer by layer (also for flattening).' },
  { id: 'grid', label: 'Grid', help: 'Grid mine: parallel tunnels across an area at one level, a few blocks apart — exposes every block of the area for the fewest blocks dug. Best with wall scanning on.' },
];

type Area = { origin: { x: number; y: number; z: number }; heading: Heading; width: number };

/** Same lane split as the server: one lane per turtle, assigned left to right. */
function splitLanes<T extends Area>(p: T, ts: TurtleView[]): { lanes: { turtle: TurtleView; params: T }[]; left: TurtleView[] } {
  const n = Math.min(ts.length, p.width);
  if (n === 0) return { lanes: [], left: ts };
  const r = HEADING_VECTORS[(p.heading + 1) % 4];
  const along = (t: TurtleView) => {
    const q = t.state?.pose.pos;
    return q ? (q.x - p.origin.x) * r.x + (q.z - p.origin.z) * r.z : Infinity;
  };
  const ordered = [...ts].sort((a, b) => along(a) - along(b));
  const base = Math.floor(p.width / n);
  const extra = p.width % n;
  const lanes: { turtle: TurtleView; params: T }[] = [];
  let offset = 0;
  for (let i = 0; i < n; i++) {
    const width = base + (i < extra ? 1 : 0);
    lanes.push({ turtle: ordered[i], params: { ...p, origin: { x: p.origin.x + r.x * offset, y: p.origin.y, z: p.origin.z + r.z * offset }, width } });
    offset += width;
  }
  return { lanes, left: ordered.slice(n) };
}

/** The cell in front of the turtle, at its level, in its facing. */
function frontOf(t: TurtleView): { origin: { x: number; y: number; z: number }; heading: Heading } | undefined {
  const p = t.state?.pose;
  if (!p?.pos || p.heading === undefined || p.position !== 'known' || p.headingConfidence !== 'known') return undefined;
  const f = HEADING_VECTORS[p.heading];
  return { origin: { x: p.pos.x + f.x, y: p.pos.y, z: p.pos.z + f.z }, heading: p.heading as Heading };
}

type Form = ReturnType<typeof initialForm>;

/** Sizes each strategy starts with when its tab is picked. */
const SIZE_DEFAULTS: Record<Strategy, { width: string; height: string; length: string }> = {
  tunnel: { width: '1', height: '2', length: '32' },
  branch: { width: '1', height: '2', length: '32' },
  quarry: { width: '8', height: '2', length: '8' },
  grid: { width: '16', height: '2', length: '32' },
};
function initialForm(turtleId: string, depotId: string) {
  return {
    name: '',
    strategy: 'tunnel' as Strategy,
    turtleId,
    depotId,
    originMode: 'front' as 'front' | 'manual',
    layout: 'each' as 'each' | 'split',
    x: '',
    y: '',
    z: '',
    heading: '0',
    width: '1',
    height: '2',
    length: '32',
    spacing: '3',
    branchLength: '16',
    sides: 'both' as 'both' | 'left' | 'right',
    depth: '16',
    // policy
    minFreeSlots: '1',
    fuelSlot: '16',
    keepSlots: '',
    fuelReserve: '100',
    refuelTarget: '2000',
    returnHomeWhenDone: true,
    autoResume: false,
    scanWalls: false,
    veinOres: [] as string[],
    customOres: '',
    veinMax: '48',
    veinReach: '6',
    torches: false,
    torchSpacing: '10',
  };
}

/** Build a strategy from the form for a given start cell and heading. */
function buildStrategy(v: Form, origin: { x: number; y: number; z: number }, heading: Heading): StrategyInput | undefined {
  const n = (s: string) => Number(s);
  const ok = (...xs: string[]) => xs.every((s) => Number.isInteger(n(s)) && n(s) >= 1);
  if (v.strategy === 'tunnel') {
    if (!ok(v.width, v.height, v.length)) return undefined;
    return { strategy: 'tunnel', params: { origin, heading, width: n(v.width), height: n(v.height), length: n(v.length) } };
  }
  if (v.strategy === 'branch') {
    if (!ok(v.width, v.height, v.length, v.spacing, v.branchLength)) return undefined;
    return {
      strategy: 'branch',
      params: { origin, heading, width: Math.min(3, n(v.width)), height: Math.min(3, n(v.height)), length: n(v.length), spacing: Math.max(2, n(v.spacing)), branchLength: n(v.branchLength), sides: v.sides },
    };
  }
  if (v.strategy === 'grid') {
    if (!ok(v.width, v.height, v.length, v.spacing)) return undefined;
    return {
      strategy: 'grid',
      params: { origin, heading, width: n(v.width), height: Math.min(3, n(v.height)), length: n(v.length), spacing: Math.min(8, Math.max(2, n(v.spacing))) },
    };
  }
  if (!ok(v.width, v.length, v.depth)) return undefined;
  return { strategy: 'quarry', params: { origin, heading, width: n(v.width), length: n(v.length), depth: n(v.depth) } };
}

/**
 * New job(s): tunnel, branch mine or quarry. With several turtles selected it creates
 * one per turtle (each in front of its turtle), or splits one tunnel/quarry into lanes.
 */
export function JobForm({ onDone }: { onDone: () => void }) {
  const turtles = useFleet((s) => s.turtles);
  const depotMap = useFleet((s) => s.depots);
  const jobs = useFleet((s) => s.jobs);
  const selection = useFleet((s) => s.selection);
  const focusId = useFleet((s) => s.focusId);
  const setJobDraft = useFleet((s) => s.setJobDraft);
  const setDraftChunks = useFleet((s) => s.setDraftChunks);
  const depots = Object.values(depotMap);
  const multi = selection.length > 1;

  const [v, setV] = useState(() => initialForm(focusId ?? selection[0] ?? '', depots[0]?.id ?? ''));
  // A start position picked on the map ("New job starting here…").
  const prefill = useFleet((s) => s.jobPrefill);
  useEffect(() => {
    if (!prefill) return;
    const o = prefill.origin;
    setV((cur) => ({ ...cur, originMode: 'manual', x: String(o.x), y: String(o.y), z: String(o.z), heading: String(prefill.heading ?? cur.heading) }));
    useFleet.getState().clearJobPrefill();
  }, [prefill]);
  const [est, setEst] = useState<{ cells: number; fuel: number; seconds: number; trips: number; note: string; warnings: string[] }>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });

  const canSplit = v.strategy === 'tunnel' || v.strategy === 'quarry';
  const split = multi && canSplit && v.layout === 'split';
  const mode = multi && !split ? 'front' : v.originMode;
  const targetIds = multi ? selection : v.turtleId ? [v.turtleId] : [];
  const defaultName = STRATEGIES.find((s) => s.id === v.strategy)!.label;

  // A shared area starts in front of the leftmost selected turtle (seen along its facing).
  const anchorId = useMemo(() => {
    const base = turtles[focusId && selection.includes(focusId) ? focusId : selection[0]];
    const h = base?.state?.pose.heading;
    if (h === undefined) return base?.id;
    const r = HEADING_VECTORS[(h + 1) % 4];
    let best = base;
    let bestAlong = Infinity;
    for (const id of selection) {
      const p = turtles[id]?.state?.pose;
      if (!p?.pos || p.heading !== h) continue;
      const along = p.pos.x * r.x + p.pos.z * r.z;
      if (along < bestAlong) {
        bestAlong = along;
        best = turtles[id];
      }
    }
    return best?.id;
  }, [turtles, selection, focusId]);

  const manualStart = (): { origin: { x: number; y: number; z: number }; heading: Heading } | undefined => {
    const c = [v.x, v.y, v.z].map(Number);
    if ([v.x, v.y, v.z].some((s) => s.trim() === '') || c.some((x) => !Number.isInteger(x))) return undefined;
    return { origin: { x: c[0], y: c[1], z: c[2] }, heading: Number(v.heading) as Heading };
  };

  // One draft per turtle that can take a job; the rest are listed with the reason.
  const { drafts, skipped, whole } = useMemo(() => {
    const skipped: { name: string; why: string }[] = [];
    const drafts: { turtle: TurtleView; strategy: StrategyInput }[] = [];
    const eligible: TurtleView[] = [];
    for (const id of targetIds) {
      const t = turtles[id];
      if (!t) continue;
      if (t.job) skipped.push({ name: t.name, why: `already has job "${t.job.name}"` });
      else eligible.push(t);
    }
    if (split) {
      const start = mode === 'front' ? turtles[anchorId] && frontOf(turtles[anchorId]) : manualStart();
      const all = start && buildStrategy(v, start.origin, start.heading);
      if (!all || (all.strategy !== 'tunnel' && all.strategy !== 'quarry')) return { drafts, skipped, whole: undefined };
      const s = splitLanes(all.params as Area & typeof all.params, eligible);
      for (const t of s.left) skipped.push({ name: t.name, why: 'more turtles than columns' });
      for (const l of s.lanes) drafts.push({ turtle: l.turtle, strategy: { strategy: all.strategy, params: l.params } as StrategyInput });
      return { drafts, skipped, whole: all };
    }
    for (const t of eligible) {
      const start = mode === 'front' ? frontOf(t) : manualStart();
      if (!start) {
        skipped.push({ name: t.name, why: mode === 'front' ? 'position or heading not known' : 'enter the start coordinates' });
        continue;
      }
      const s = buildStrategy(v, start.origin, start.heading);
      if (s) drafts.push({ turtle: t, strategy: s });
    }
    return { drafts, skipped, whole: undefined };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turtles, targetIds.join(','), mode, split, anchorId, v]);

  const segmentsOf = useMemo(() => drafts.map((d) => segmentsFor(d.strategy)), [drafts]);

  // Overlaps between the new jobs, and with unfinished jobs.
  const conflicts = useMemo(() => {
    const out: string[] = [];
    drafts.forEach((a, i) => {
      drafts.slice(i + 1).forEach((b, j) => {
        if (segsOverlap(segmentsOf[i], segmentsOf[i + 1 + j])) out.push(`${a.turtle.name} and ${b.turtle.name} would dig the same cells`);
      });
      for (const j of Object.values(jobs)) {
        if (j.status === 'completed' || j.status === 'cancelled') continue;
        if (segsOverlap(segmentsOf[i], j.segments ?? [])) out.push(`${a.turtle.name}'s work area overlaps job "${j.name}"`);
      }
    });
    return out;
  }, [drafts, segmentsOf, jobs]);

  const policy = useMemo(
    () => ({
      minFreeSlots: Number(v.minFreeSlots),
      fuelSlot: Number(v.fuelSlot),
      keepSlots: v.keepSlots
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number),
      fuelReserve: Number(v.fuelReserve),
      refuelTarget: Number(v.refuelTarget),
      returnHomeWhenDone: v.returnHomeWhenDone,
      autoResume: v.autoResume,
      scanWalls: v.scanWalls,
      veins: {
        ores: [...v.veinOres, ...v.customOres.split(/[,;\n]+/).map((s) => s.trim()).filter((s) => s.length >= 2)],
        maxBlocks: Number(v.veinMax) || 48,
        reach: Number(v.veinReach) || 6,
      },
      torches: { enabled: v.torches, spacing: Math.min(32, Math.max(4, Number(v.torchSpacing) || 10)) },
    }),
    [v],
  );

  const torchWarnings: string[] = [];
  if (v.torches) {
    if (v.depotId && !depotMap[v.depotId]?.fuelDir) torchWarnings.push("This depot has no fuel chest to take torches from: give the turtle torches yourself before starting.");
    if (v.strategy !== 'quarry' && Number(v.height) < 2) torchWarnings.push("A 1-high tunnel has no floor beside the turtle's path for torches: make it at least 2 high.");
  }

  const inputs = useMemo(
    (): JobInput[] =>
      drafts.map((d) => ({
        name: multi ? `${v.name || defaultName} · ${d.turtle.name}` : v.name || defaultName,
        depotId: v.depotId,
        turtleId: d.turtle.id,
        policy,
        ...d.strategy,
      })),
    [drafts, multi, v.name, v.depotId, defaultName, policy],
  );

  // Preview on the map; refresh estimates as the form changes.
  useEffect(() => {
    setJobDraft(segmentsOf.length ? segmentsOf.flat() : undefined);
    if (!inputs.length || !v.depotId) return setEst(undefined);
    const t = setTimeout(() => {
      Promise.all(inputs.map((i) => api.estimateJob(i))).then(
        (rs) => {
          const e = (k: keyof JobEstimate) => rs.map((r) => r.estimate[k] as number);
          setEst({
            cells: e('cells').reduce((a, b) => a + b, 0),
            fuel: Math.max(...e('fuel')),
            seconds: Math.max(...e('seconds')),
            trips: e('trips').reduce((a, b) => a + b, 0),
            note: rs[0].estimate.note,
            warnings: [...new Set(rs.flatMap((r) => r.warnings))],
          });
          const needed = new Map<string, { cx: number; cz: number; forced: boolean }>();
          for (const r of rs) for (const c of r.chunks) needed.set(`${c.cx},${c.cz}`, c);
          setDraftChunks([...needed.values()]);
          setErr(undefined);
        },
        (e2) => setErr((e2 as Error).message),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [inputs, segmentsOf, v.depotId, setJobDraft, setDraftChunks]);
  useEffect(
    () => () => {
      setJobDraft(undefined);
      setDraftChunks(undefined);
    },
    [setJobDraft, setDraftChunks],
  );

  const create = async (start: boolean) => {
    if (!inputs.length) return setErr('Nothing to create: check the turtles and sizes.');
    setErr(undefined);
    setBusy(true);
    try {
      if (multi) {
        // A campaign: every job is checked on the server before any is created.
        const name = v.name || defaultName;
        const r = await api.createCampaign(
          split && whole
            ? { name, depotId: v.depotId, policy, start, split: { ...(whole as Extract<StrategyInput, { strategy: 'tunnel' | 'quarry' }>), turtleIds: drafts.map((d) => d.turtle.id) } }
            : { name, depotId: v.depotId, policy, start, jobs: drafts.map((d) => ({ turtleId: d.turtle.id, ...d.strategy })) },
        );
        useFleet.getState().toast('info', `Created ${r.jobs.length} jobs${start ? ' and started them' : ''}${r.skipped.length ? `; skipped ${r.skipped.join(', ')}` : ''}`);
      } else {
        const job = await api.createJob(inputs[0]);
        if (start) await api.startJob(job.id);
      }
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const count = inputs.length;
  const toggleOre = (m: string) => setV({ ...v, veinOres: v.veinOres.includes(m) ? v.veinOres.filter((x) => x !== m) : [...v.veinOres, m] });
  const tab = (active: boolean) => `flex-1 rounded border px-2 py-1 ${active ? 'border-cyan-600 bg-cyan-950/60 text-cyan-100' : 'border-edge text-dim hover:text-ink'}`;

  return (
    <div className="space-y-2 p-3 text-xs">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-dim">{multi ? `New jobs for ${selection.length} turtles` : 'New job'}</h3>
      {depots.length === 0 && <p className="rounded border border-amber-800 bg-amber-950/40 p-1.5 text-amber-200">Create a depot first (Depots tab).</p>}

      <div className="flex gap-1 text-[11px]">
        {STRATEGIES.map((s) => (
          <button key={s.id} onClick={() => v.strategy !== s.id && setV({ ...v, strategy: s.id, ...SIZE_DEFAULTS[s.id] })} className={tab(v.strategy === s.id)}>
            {s.label}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-dim">{STRATEGIES.find((s) => s.id === v.strategy)!.help}</p>

      <Field label="Name">
        <input value={v.name} placeholder={defaultName} maxLength={50} onChange={set('name')} className="inp" />
      </Field>
      <div className="grid grid-cols-2 gap-1">
        {multi ? (
          <Field label="Turtles">
            <div className="rounded border border-edge bg-panel px-1.5 py-0.5 text-xs text-ink">{selection.length} selected</div>
          </Field>
        ) : (
          <Field label="Turtle">
            <select value={v.turtleId} onChange={set('turtleId')} className="inp">
              <option value="">choose…</option>
              {Object.values(turtles).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.simulated ? ' (sim)' : ''}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Depot">
          <select value={v.depotId} onChange={set('depotId')} className="inp">
            {depots.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {multi && (
        <div className="flex gap-1 text-[11px]">
          <button onClick={() => setV({ ...v, layout: 'each' })} className={tab(!split)}>
            One each
          </button>
          <button
            disabled={!canSplit}
            onClick={() => setV({ ...v, layout: 'split' })}
            className={`${tab(split)} disabled:opacity-40`}
            title={canSplit ? 'One wide area split side by side into one lane per turtle' : 'Branch mines are one per turtle'}
          >
            Share one (lanes)
          </button>
        </div>
      )}
      {(!multi || split) && (
        <div className="flex gap-1 text-[11px]">
          <button onClick={() => setV({ ...v, originMode: 'front' })} className={tab(v.originMode === 'front')}>
            Start in front of {split ? (turtles[anchorId]?.name ?? 'the leftmost turtle') : 'the turtle'}
          </button>
          <button onClick={() => setV({ ...v, originMode: 'manual' })} className={tab(v.originMode === 'manual')}>
            Enter coordinates
          </button>
        </div>
      )}
      {mode === 'front' ? (
        <p className="text-[11px] text-dim">
          {split
            ? 'The area is divided side by side into one lane per turtle, assigned left to right by where they stand.'
            : `Starts in the cell in front of ${multi ? 'each' : 'the'} turtle, at its level, going the way it faces.`}{' '}
          {v.strategy === 'quarry' ? 'The quarry goes down from that level.' : ''}
        </p>
      ) : (
        <div className="grid grid-cols-4 gap-1">
          <Field label="Start X">
            <input value={v.x} onChange={set('x')} className="inp num" />
          </Field>
          <Field label={v.strategy === 'quarry' ? 'Y (top)' : 'Y (floor)'}>
            <input value={v.y} onChange={set('y')} className="inp num" />
          </Field>
          <Field label="Z">
            <input value={v.z} onChange={set('z')} className="inp num" />
          </Field>
          <Field label="Direction">
            <select value={v.heading} onChange={set('heading')} className="inp">
              <option value="0">N (−Z)</option>
              <option value="1">E (+X)</option>
              <option value="2">S (+Z)</option>
              <option value="3">W (−X)</option>
            </select>
          </Field>
        </div>
      )}

      {v.strategy === 'tunnel' && (
        <div className="grid grid-cols-3 gap-1">
          <Field label="Width →">
            <input value={v.width} onChange={set('width')} className="inp num" />
          </Field>
          <Field label="Height ↑">
            <input value={v.height} onChange={set('height')} className="inp num" />
          </Field>
          <Field label="Length">
            <input value={v.length} onChange={set('length')} className="inp num" />
          </Field>
        </div>
      )}
      {v.strategy === 'branch' && (
        <>
          <div className="grid grid-cols-3 gap-1">
            <Field label="Corridor width">
              <input value={v.width} onChange={set('width')} className="inp num" />
            </Field>
            <Field label="Height">
              <input value={v.height} onChange={set('height')} className="inp num" />
            </Field>
            <Field label="Corridor length">
              <input value={v.length} onChange={set('length')} className="inp num" />
            </Field>
            <Field label="Branch every">
              <input value={v.spacing} onChange={set('spacing')} className="inp num" />
            </Field>
            <Field label="Branch length">
              <input value={v.branchLength} onChange={set('branchLength')} className="inp num" />
            </Field>
            <Field label="Branches">
              <select value={v.sides} onChange={set('sides')} className="inp">
                <option value="both">both sides</option>
                <option value="left">left only</option>
                <option value="right">right only</option>
              </select>
            </Field>
          </div>
          <p className="text-[11px] text-dim">"Branch every 3" leaves two solid blocks between branches; every block between them is still exposed to a tunnel face. Width and height max 3.</p>
        </>
      )}
      {v.strategy === 'grid' && (
        <>
          <div className="grid grid-cols-4 gap-1">
            <Field label="Width →">
              <input value={v.width} onChange={set('width')} className="inp num" />
            </Field>
            <Field label="Length">
              <input value={v.length} onChange={set('length')} className="inp num" />
            </Field>
            <Field label="Height">
              <input value={v.height} onChange={set('height')} className="inp num" />
            </Field>
            <Field label="Tunnel every">
              <input value={v.spacing} onChange={set('spacing')} className="inp num" />
            </Field>
          </div>
          <p className="text-[11px] text-dim">
            {Number(v.width) >= 1 && Number(v.spacing) >= 2 ? `${Math.floor((Number(v.width) - 1) / Math.max(2, Number(v.spacing))) + 1} tunnels, joined at alternate ends. ` : ''}
            "Every 3" leaves two solid columns between tunnels, so every block of the area touches a tunnel.
          </p>
        </>
      )}
      {v.strategy === 'quarry' && (
        <div className="grid grid-cols-3 gap-1">
          <Field label="Width →">
            <input value={v.width} onChange={set('width')} className="inp num" />
          </Field>
          <Field label="Length">
            <input value={v.length} onChange={set('length')} className="inp num" />
          </Field>
          <Field label="Depth ↓">
            <input value={v.depth} onChange={set('depth')} className="inp num" />
          </Field>
        </div>
      )}

      <div className="rounded border border-edge bg-panel-2 p-2">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-dim">Finding ores</div>
        <label className="flex items-start gap-1 text-[11px]">
          <input type="checkbox" className="mt-0.5" checked={v.scanWalls} onChange={(e) => setV({ ...v, scanWalls: e.target.checked })} />
          <span>
            Scan the walls as it goes <span className="text-dim">(looks at every block around the work area — walls, ceiling, floor — so the map shows what's there; about doubles the time and adds some fuel)</span>
          </span>
        </label>
        <div className="mt-1.5 text-[11px] text-dim">Follow veins of:</div>
        <div className="mt-0.5 flex flex-wrap gap-1">
          {ORE_PRESETS.map((o) => (
            <button
              key={o.match}
              onClick={() => toggleOre(o.match)}
              className={`rounded border px-1.5 py-0.5 text-[11px] ${v.veinOres.includes(o.match) ? 'border-sky-500 bg-sky-900/60 text-sky-100' : 'border-edge text-dim hover:text-ink'}`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <input
          value={v.customOres}
          onChange={set('customOres')}
          placeholder="other ores, comma separated: tin, Silver Ore, thermal:tin_ore"
          className="mt-1 w-full rounded border border-edge bg-panel px-1.5 py-0.5 text-[11px] text-ink placeholder:text-slate-600"
        />
        {policy.veins.ores.length > 0 && (
          <div className="mt-1 grid grid-cols-2 gap-1">
            <Field label="Max blocks per vein">
              <input value={v.veinMax} onChange={set('veinMax')} className="inp num" />
            </Field>
            <Field label="Max distance from the area">
              <input value={v.veinReach} onChange={set('veinReach')} className="inp num" />
            </Field>
          </div>
        )}
        <p className="mt-1 text-[11px] text-dim">
          When it sees a matching ore near the work area, it mines the whole connected vein (looking around at every block), then goes back and continues. Outside the work area it only ever digs the
          matching ore. {policy.veins.ores.length > 0 && !v.scanWalls ? 'Tip: turn on wall scanning, or it only sees ores in front, above and below.' : ''}
        </p>
      </div>

      <div className="rounded border border-edge bg-panel-2 p-2">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-dim">Lighting</div>
        <label className="flex items-start gap-1 text-[11px]">
          <input type="checkbox" className="mt-0.5" checked={v.torches} onChange={(e) => setV({ ...v, torches: e.target.checked })} />
          <span>
            Place torches <span className="text-dim">(on the floor, out of the turtle's way, so mobs don't spawn in the tunnels)</span>
          </span>
        </label>
        {v.torches && (
          <>
            <div className="mt-1 grid grid-cols-2 gap-1">
              <Field label="Blocks between torches">
                <input value={v.torchSpacing} onChange={set('torchSpacing')} className="inp num" />
              </Field>
            </div>
            <p className="mt-1 text-[11px] text-dim">
              Put torches in the depot's <b>fuel chest</b>, next to the fuel: the turtle takes what the job needs (up to a stack) before it starts and on every trip, and never unloads them.
              {v.strategy === 'quarry' && ' In a quarry only the bottom floor gets torches: the floors above are dug away.'}
            </p>
            {torchWarnings.map((w) => (
              <p key={w} className="mt-1 text-[11px] text-amber-300">
                {w}
              </p>
            ))}
          </>
        )}
      </div>

      {(drafts.length > 1 || skipped.length > 0) && (
        <ul className="space-y-0.5 rounded border border-edge bg-panel-2 p-1.5 text-[11px]">
          {drafts.map((d) => (
            <li key={d.turtle.id} className="num flex justify-between gap-2">
              <span className="truncate text-ink">{d.turtle.name}</span>
              <span className="text-dim">
                from {d.strategy.params.origin.x} {d.strategy.params.origin.y} {d.strategy.params.origin.z} {['N', 'E', 'S', 'W'][d.strategy.params.heading]}
                {split ? ` · ${d.strategy.params.width} wide` : ''}
              </span>
            </li>
          ))}
          {skipped.map((s) => (
            <li key={s.name} className="flex justify-between gap-2 text-amber-300">
              <span className="truncate">{s.name}</span>
              <span>skipped: {s.why}</span>
            </li>
          ))}
        </ul>
      )}

      <details className="rounded border border-edge bg-panel-2 p-1.5">
        <summary className="cursor-pointer text-dim">Return, fuel and slot policy{multi ? ' (same for all)' : ''}</summary>
        <div className="mt-1 grid grid-cols-2 gap-1">
          <Field label="Return when free slots ≤">
            <input value={v.minFreeSlots} onChange={set('minFreeSlots')} className="inp num" />
          </Field>
          <Field label="Fuel slot (0 = none)">
            <input value={v.fuelSlot} onChange={set('fuelSlot')} className="inp num" />
          </Field>
          <Field label="Keep slots (e.g. 15)">
            <input value={v.keepSlots} onChange={set('keepSlots')} className="inp num" />
          </Field>
          <Field label="Fuel reserve">
            <input value={v.fuelReserve} onChange={set('fuelReserve')} className="inp num" />
          </Field>
          <Field label="Refuel target at depot">
            <input value={v.refuelTarget} onChange={set('refuelTarget')} className="inp num" />
          </Field>
          <label className="mt-3 flex items-center gap-1 text-[11px] text-dim">
            <input type="checkbox" checked={v.returnHomeWhenDone} onChange={(e) => setV({ ...v, returnHomeWhenDone: e.target.checked })} />
            return &amp; unload when done
          </label>
          <label
            className="col-span-2 flex items-start gap-1 text-[11px] text-dim"
            title="Only when the job paused because the turtle dropped: back within 15 min, at most 3 times an hour, with a known position and heading, and not stopped. Never after you pause it yourself."
          >
            <input type="checkbox" className="mt-0.5" checked={v.autoResume} onChange={(e) => setV({ ...v, autoResume: e.target.checked })} />
            resume automatically if the turtle reconnects (within 15 min, max 3×/hour)
          </label>
        </div>
        <p className="mt-1 text-[11px] text-dim">
          Fuel-slot items are kept when unloading and only burned when needed. Turtles head back before running low (estimated way home + reserve).
        </p>
      </details>

      {count > 1 && (
        <p className="text-[11px] text-dim">
          Turtles share the dock one at a time; others wait on a free waiting spot (or where they are) and give way to each other on the way.
        </p>
      )}
      {conflicts.map((c) => (
        <p key={c} className="text-red-300">
          ✕ {c}
        </p>
      ))}
      {est && (
        <div className="rounded border border-edge bg-panel-2 p-2">
          <div className="num grid grid-cols-3 gap-1 text-[11px]">
            <span>~{est.cells} blocks</span>
            <span>~{est.fuel} fuel{count > 1 ? ' each' : ''}</span>
            <span>~{Math.max(1, Math.round(est.seconds / 60))} min</span>
            <span>~{est.trips} trip(s)</span>
          </div>
          <p className="mt-1 text-[10px] text-slate-500">{est.note}</p>
          {est.warnings.map((w) => (
            <p key={w} className="mt-1 text-amber-300">
              ⚠ {w}
            </p>
          ))}
        </div>
      )}
      {err && <p className="text-red-300">{err}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onDone} className="px-2 py-1 text-dim hover:text-ink">
          Cancel
        </button>
        <button onClick={() => create(false)} disabled={!count || conflicts.length > 0 || busy} className="rounded border border-edge px-2 py-1 hover:bg-slate-700/60 disabled:opacity-40">
          Create{count > 1 ? ` ${count}` : ''}
        </button>
        <button
          onClick={() => create(true)}
          disabled={!count || conflicts.length > 0 || busy}
          className="rounded bg-cyan-600 px-3 py-1 font-semibold text-slate-950 hover:bg-cyan-500 disabled:opacity-40"
        >
          Create &amp; start{count > 1 ? ` ${count} jobs` : ''}
        </button>
      </div>
    </div>
  );
}
