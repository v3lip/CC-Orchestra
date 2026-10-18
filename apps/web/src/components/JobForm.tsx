import { useEffect, useMemo, useState } from 'react';
import type { Heading, JobEstimate, JobInput, TunnelParams, TurtleView } from '@ccfleet/protocol';
import { HEADING_VECTORS } from '@ccfleet/protocol';
import { api } from '../lib/api';
import { useFleet } from '../lib/store';
import { Field } from './DepotsPanel';

type Box = { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };

function tunnelBox(p: TunnelParams): Box {
  const f = HEADING_VECTORS[p.heading];
  const r = HEADING_VECTORS[(p.heading + 1) % 4];
  const end = { x: p.origin.x + f.x * (p.length - 1) + r.x * (p.width - 1), z: p.origin.z + f.z * (p.length - 1) + r.z * (p.width - 1) };
  return {
    min: { x: Math.min(p.origin.x, end.x), y: p.origin.y, z: Math.min(p.origin.z, end.z) },
    max: { x: Math.max(p.origin.x, end.x), y: p.origin.y + p.height - 1, z: Math.max(p.origin.z, end.z) },
  };
}
const overlap = (a: Box, b: Box) =>
  a.min.x <= b.max.x && b.min.x <= a.max.x && a.min.y <= b.max.y && b.min.y <= a.max.y && a.min.z <= b.max.z && b.min.z <= a.max.z;

/** The tunnel origin "in front of the turtle, at its level, in its facing". */
function frontOf(t: TurtleView): { origin: { x: number; y: number; z: number }; heading: Heading } | undefined {
  const p = t.state?.pose;
  if (!p?.pos || p.heading === undefined || p.position !== 'known' || p.headingConfidence !== 'known') return undefined;
  const f = HEADING_VECTORS[p.heading];
  return { origin: { x: p.pos.x + f.x, y: p.pos.y, z: p.pos.z + f.z }, heading: p.heading as Heading };
}

/**
 * New tunnel job(s). With several turtles selected it creates one tunnel per turtle,
 * each starting in front of its turtle, all the same size.
 */
export function JobForm({ onDone }: { onDone: () => void }) {
  const turtles = useFleet((s) => s.turtles);
  const depotMap = useFleet((s) => s.depots);
  const jobs = useFleet((s) => s.jobs);
  const selection = useFleet((s) => s.selection);
  const focusId = useFleet((s) => s.focusId);
  const setJobDraft = useFleet((s) => s.setJobDraft);
  const depots = Object.values(depotMap);
  const multi = selection.length > 1;

  const [v, setV] = useState(() => ({
    name: 'Tunnel',
    turtleId: focusId ?? selection[0] ?? '',
    depotId: depots[0]?.id ?? '',
    originMode: 'front' as 'front' | 'manual',
    x: '',
    y: '',
    z: '',
    heading: '0',
    width: '1',
    height: '2',
    length: '32',
    minFreeSlots: '1',
    fuelSlot: '16',
    keepSlots: '',
    fuelReserve: '100',
    refuelTarget: '2000',
    returnHomeWhenDone: true,
  }));
  const [est, setEst] = useState<{ cells: number; fuel: number; seconds: number; trips: number; note: string; warnings: string[] }>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });

  const targetIds = multi ? selection : v.turtleId ? [v.turtleId] : [];
  const mode = multi ? 'front' : v.originMode;

  // One draft per turtle that can take a job; the rest are listed with the reason.
  const { drafts, skipped } = useMemo(() => {
    const n = (s: string) => Number(s);
    const dims = [v.width, v.height, v.length].map(n);
    const skipped: { name: string; why: string }[] = [];
    const drafts: { turtle: TurtleView; params: TunnelParams }[] = [];
    if (dims.some((d) => !Number.isInteger(d) || d < 1)) return { drafts, skipped };
    for (const id of targetIds) {
      const t = turtles[id];
      if (!t) continue;
      if (t.job) {
        skipped.push({ name: t.name, why: `already has job "${t.job.name}"` });
        continue;
      }
      let origin: TunnelParams['origin'];
      let heading: Heading;
      if (mode === 'front') {
        const f = frontOf(t);
        if (!f) {
          skipped.push({ name: t.name, why: 'position or heading not known' });
          continue;
        }
        ({ origin, heading } = f);
      } else {
        const c = [v.x, v.y, v.z].map(n);
        if ([v.x, v.y, v.z].some((s) => s.trim() === '') || c.some((x) => !Number.isInteger(x))) continue;
        origin = { x: c[0], y: c[1], z: c[2] };
        heading = n(v.heading) as Heading;
      }
      drafts.push({ turtle: t, params: { origin, heading, width: dims[0], height: dims[1], length: dims[2] } });
    }
    return { drafts, skipped };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turtles, targetIds.join(','), mode, v.x, v.y, v.z, v.heading, v.width, v.height, v.length]);

  // Overlaps between the new tunnels, and with unfinished jobs.
  const conflicts = useMemo(() => {
    const out: string[] = [];
    drafts.forEach((a, i) => {
      const ba = tunnelBox(a.params);
      drafts.slice(i + 1).forEach((b) => {
        if (overlap(ba, tunnelBox(b.params))) out.push(`${a.turtle.name} and ${b.turtle.name} would dig the same cells`);
      });
      for (const j of Object.values(jobs)) {
        if (j.status === 'completed' || j.status === 'cancelled') continue;
        if (overlap(ba, tunnelBox(j.params))) out.push(`${a.turtle.name}'s tunnel overlaps job "${j.name}"`);
      }
    });
    return out;
  }, [drafts, jobs]);

  const inputs = useMemo(
    (): JobInput[] =>
      drafts.map((d) => ({
        name: multi ? `${v.name || 'Tunnel'} · ${d.turtle.name}` : v.name || 'Tunnel',
        strategy: 'tunnel',
        params: d.params,
        depotId: v.depotId,
        turtleId: d.turtle.id,
        policy: {
          minFreeSlots: Number(v.minFreeSlots),
          fuelSlot: Number(v.fuelSlot),
          keepSlots: v.keepSlots
            .split(/[\s,]+/)
            .filter(Boolean)
            .map(Number),
          fuelReserve: Number(v.fuelReserve),
          refuelTarget: Number(v.refuelTarget),
          returnHomeWhenDone: v.returnHomeWhenDone,
        },
      })),
    [drafts, multi, v],
  );

  // Preview on the map; refresh estimates as the form changes.
  useEffect(() => {
    setJobDraft(drafts.length ? drafts.map((d) => d.params) : undefined);
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
          setErr(undefined);
        },
        (e2) => setErr((e2 as Error).message),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [inputs, drafts, v.depotId, setJobDraft]);
  useEffect(() => () => setJobDraft(undefined), [setJobDraft]);

  const create = async (start: boolean) => {
    if (!inputs.length) return setErr('Nothing to create: check the turtles and sizes.');
    setErr(undefined);
    setBusy(true);
    const failures: string[] = [];
    for (const input of inputs) {
      try {
        const job = await api.createJob(input);
        if (start) await api.startJob(job.id);
      } catch (e) {
        failures.push(`${turtles[input.turtleId]?.name ?? input.turtleId}: ${(e as Error).message}`);
      }
    }
    setBusy(false);
    if (failures.length) setErr(`Not created: ${failures.join(' · ')}`);
    else {
      if (inputs.length > 1) useFleet.getState().toast('info', `Created ${inputs.length} jobs${start ? ' and started them' : ''}`);
      onDone();
    }
  };

  const count = inputs.length;
  const sharedDepot = count > 1;

  return (
    <div className="space-y-2 p-3 text-xs">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-dim">{multi ? `New tunnels for ${selection.length} turtles` : 'New tunnel job'}</h3>
      {depots.length === 0 && <p className="rounded border border-amber-800 bg-amber-950/40 p-1.5 text-amber-200">Create a depot first (Depots tab).</p>}
      <Field label="Name">
        <input value={v.name} maxLength={50} onChange={set('name')} className="inp" />
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

      {!multi && (
        <div className="flex gap-1 text-[11px]">
          {(['front', 'manual'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setV({ ...v, originMode: m })}
              className={`flex-1 rounded border px-2 py-1 ${v.originMode === m ? 'border-cyan-600 bg-cyan-950/60 text-cyan-100' : 'border-edge text-dim hover:text-ink'}`}
            >
              {m === 'front' ? 'Start in front of the turtle' : 'Enter coordinates'}
            </button>
          ))}
        </div>
      )}
      {mode === 'front' ? (
        <p className="text-[11px] text-dim">
          {multi ? 'Each tunnel starts' : 'The tunnel starts'} in the cell in front of {multi ? 'its' : 'the'} turtle, at {multi ? 'its' : 'the'} level, going the way {multi ? 'it faces' : 'it faces'}. Point
          turtles at the rock before creating.
        </p>
      ) : (
        <div className="grid grid-cols-4 gap-1">
          <Field label="Origin X">
            <input value={v.x} onChange={set('x')} className="inp num" />
          </Field>
          <Field label="Y (floor)">
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

      {(drafts.length > 1 || skipped.length > 0) && (
        <ul className="space-y-0.5 rounded border border-edge bg-panel-2 p-1.5 text-[11px]">
          {drafts.map((d) => (
            <li key={d.turtle.id} className="num flex justify-between gap-2">
              <span className="truncate text-ink">{d.turtle.name}</span>
              <span className="text-dim">
                from {d.params.origin.x} {d.params.origin.y} {d.params.origin.z} {['N', 'E', 'S', 'W'][d.params.heading]}
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
        </div>
        <p className="mt-1 text-[11px] text-dim">
          Fuel-slot items are kept when unloading and only burned when needed. Turtles head back before running low (estimated way home + reserve).
        </p>
      </details>

      {sharedDepot && (
        <p className="text-[11px] text-dim">
          Turtles share the depot one at a time: a turtle takes the dock before leaving its tunnel and frees it when it is back. Others keep mining and wait in their tunnels (shown as <i>waiting</i>).
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
          <p className="mt-1 text-[10px] text-slate-500">
            {est.note}
            {count > 1 ? ' Time assumes the turtles rarely wait for the dock.' : ''}
          </p>
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
