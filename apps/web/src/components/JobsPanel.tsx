import { useEffect, useMemo, useState } from 'react';
import type { Heading, JobEstimate, JobInput, JobView, TunnelParams } from '@ccfleet/protocol';
import { HEADING_VECTORS } from '@ccfleet/protocol';
import { api } from '../lib/api';
import { useFleet } from '../lib/store';
import { Field } from './DepotsPanel';

const STATUS_TONE: Record<JobView['status'], string> = {
  ready: 'bg-slate-700 text-slate-200',
  running: 'bg-emerald-900/70 text-emerald-200',
  pausing: 'bg-amber-900/70 text-amber-200',
  paused: 'bg-amber-900/70 text-amber-200',
  completed: 'bg-sky-900/70 text-sky-200',
  cancelled: 'bg-zinc-800 text-zinc-300',
};

async function act(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    useFleet.getState().toast('error', (e as Error).message);
  }
}

export function JobsPanel() {
  const jobMap = useFleet((s) => s.jobs);
  const [creating, setCreating] = useState(false);
  const jobs = Object.values(jobMap).sort((a, b) => b.createdAt - a.createdAt);
  if (creating) return <JobForm onDone={() => setCreating(false)} />;
  return (
    <div className="space-y-2 p-3 text-xs">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-dim">Jobs</h3>
        <button onClick={() => setCreating(true)} className="rounded bg-cyan-700/40 px-2 py-0.5 text-cyan-200 hover:bg-cyan-600/50">
          + New tunnel
        </button>
      </div>
      {jobs.length === 0 && <p className="text-slate-500">No jobs yet. Create a depot first, then a tunnel job.</p>}
      {jobs.map((j) => (
        <JobCard key={j.id} job={j} />
      ))}
    </div>
  );
}

function JobCard({ job }: { job: JobView }) {
  const turtle = useFleet((s) => s.turtles[job.turtleId]);
  const depot = useFleet((s) => s.depots[job.depotId]);
  const focus = useFleet((s) => s.focus);
  const p = job.progress;
  const pct = p.unitsTotal ? Math.round((p.unitsDone / p.unitsTotal) * 100) : 0;
  const active = job.status === 'running' || job.status === 'pausing';
  return (
    <div className="rounded border border-edge bg-panel-2 p-2">
      <div className="flex items-center gap-2">
        <span className="truncate font-semibold">{job.name}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${STATUS_TONE[job.status]}`}>{job.status}</span>
        {active && <span className="text-[10px] text-dim">{job.phase}</span>}
      </div>
      <div className="mt-0.5 text-[11px] text-dim">
        <button className="hover:underline" onClick={() => focus(job.turtleId, true)}>
          {turtle?.name ?? 'removed turtle'}
        </button>{' '}
        · tunnel {job.params.width}×{job.params.height}×{job.params.length} · depot {depot?.name ?? '?'}
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-slate-800">
        <div className="h-full bg-cyan-500" style={{ width: `${pct}%` }} />
      </div>
      <div className="num mt-1 flex flex-wrap gap-x-3 text-[10px] text-dim">
        <span>
          slice {p.unitsDone}/{p.unitsTotal}
        </span>
        <span>{p.cellsCleared} cells</span>
        {p.cellsSkipped > 0 && <span className="text-amber-300">{p.cellsSkipped} skipped</span>}
        <span>{p.trips} trips</span>
        <span>{p.itemsUnloaded} items unloaded</span>
      </div>
      {job.pauseReason && job.status === 'paused' && !job.error && <div className="mt-1 text-amber-300">Paused: {job.pauseReason}</div>}
      {job.error && (
        <div className="mt-1 rounded border border-red-900/60 bg-red-950/30 p-1.5 text-red-200">
          <span className="num">[{job.error.code}]</span> {job.error.message}
        </div>
      )}
      <div className="mt-1.5 flex gap-2">
        {(job.status === 'ready' || job.status === 'paused') && (
          <Btn tone="go" onClick={() => act(api.startJob(job.id))}>
            {job.status === 'ready' ? 'Start' : 'Resume'}
          </Btn>
        )}
        {job.status === 'running' && <Btn onClick={() => act(api.pauseJob(job.id))}>Pause</Btn>}
        {(job.status === 'ready' || job.status === 'running' || job.status === 'paused' || job.status === 'pausing') && (
          <Btn onClick={() => confirm(`Cancel "${job.name}"? Progress is kept on the map but the job ends.`) && act(api.cancelJob(job.id))}>Cancel</Btn>
        )}
        {(job.status === 'completed' || job.status === 'cancelled' || job.status === 'ready' || job.status === 'paused') && (
          <Btn onClick={() => confirm(`Delete "${job.name}"?`) && act(api.deleteJob(job.id))}>Delete</Btn>
        )}
      </div>
    </div>
  );
}

function Btn({ tone, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'go' }) {
  return (
    <button
      {...props}
      className={`rounded border px-2 py-0.5 text-[11px] ${tone === 'go' ? 'border-emerald-700 bg-emerald-900/40 text-emerald-100 hover:bg-emerald-800/50' : 'border-edge bg-panel hover:bg-slate-700/60'}`}
    />
  );
}

function JobForm({ onDone }: { onDone: () => void }) {
  const turtles = useFleet((s) => s.turtles);
  const depotMap = useFleet((s) => s.depots);
  const focusId = useFleet((s) => s.focusId);
  const setJobDraft = useFleet((s) => s.setJobDraft);
  const depots = Object.values(depotMap);
  const [v, setV] = useState(() => ({
    name: 'Tunnel',
    turtleId: focusId ?? '',
    depotId: depots[0]?.id ?? '',
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
  const [est, setEst] = useState<{ estimate: JobEstimate; warnings: string[] }>();
  const [err, setErr] = useState<string>();

  const input = useMemo((): JobInput | undefined => {
    const n = (s: string) => Number(s);
    const ints = [v.x, v.y, v.z, v.width, v.height, v.length].map(n);
    if (ints.some((i) => !Number.isInteger(i)) || !v.turtleId || !v.depotId || [v.x, v.y, v.z].some((s) => s.trim() === '')) return undefined;
    return {
      name: v.name || 'Tunnel',
      strategy: 'tunnel',
      params: { origin: { x: ints[0], y: ints[1], z: ints[2] }, heading: n(v.heading) as Heading, width: ints[3], height: ints[4], length: ints[5] },
      depotId: v.depotId,
      turtleId: v.turtleId,
      policy: {
        minFreeSlots: n(v.minFreeSlots),
        fuelSlot: n(v.fuelSlot),
        keepSlots: v.keepSlots
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number),
        fuelReserve: n(v.fuelReserve),
        refuelTarget: n(v.refuelTarget),
        returnHomeWhenDone: v.returnHomeWhenDone,
      },
    };
  }, [v]);

  // Preview on the map and refresh the estimate as the form changes.
  useEffect(() => {
    setJobDraft(input?.params as TunnelParams | undefined);
    if (!input) return setEst(undefined);
    const t = setTimeout(() => {
      api.estimateJob(input).then(setEst, (e) => setErr((e as Error).message));
    }, 250);
    return () => clearTimeout(t);
  }, [input, setJobDraft]);
  useEffect(() => () => setJobDraft(undefined), [setJobDraft]);

  const fromTurtle = () => {
    const t = turtles[v.turtleId];
    const p = t?.state?.pose;
    if (!p?.pos || p.heading === undefined) return setErr('That turtle has no known position and heading.');
    const f = HEADING_VECTORS[p.heading];
    setV({ ...v, x: String(p.pos.x + f.x), y: String(p.pos.y), z: String(p.pos.z + f.z), heading: String(p.heading) });
  };

  const create = async (start: boolean) => {
    if (!input) return setErr('Fill in the origin, sizes, turtle and depot.');
    setErr(undefined);
    try {
      const job = await api.createJob(input);
      if (start) await api.startJob(job.id);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });

  return (
    <div className="space-y-2 p-3 text-xs">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-dim">New tunnel job</h3>
      {depots.length === 0 && <p className="rounded border border-amber-800 bg-amber-950/40 p-1.5 text-amber-200">Create a depot first (Depots tab).</p>}
      <Field label="Name">
        <input value={v.name} maxLength={60} onChange={set('name')} className="inp" />
      </Field>
      <div className="grid grid-cols-2 gap-1">
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
      <button onClick={fromTurtle} disabled={!v.turtleId} className="w-full rounded border border-cyan-800 bg-cyan-950/50 py-1 text-cyan-200 hover:bg-cyan-900/50 disabled:opacity-40">
        Start the tunnel in front of the turtle, at its level, in its facing
      </button>
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
      <p className="text-[11px] text-dim">
        The origin is the bottom-left cell of the first slice when looking along the direction. Width extends to the right, height upwards. Only cells inside this volume are ever dug.
      </p>
      <details className="rounded border border-edge bg-panel-2 p-1.5">
        <summary className="cursor-pointer text-dim">Return, fuel and slot policy</summary>
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
          Fuel slot items are kept when unloading (if they are fuel) and only burned when needed to continue. The turtle heads back when it is about to run low: estimated distance home + reserve.
        </p>
      </details>
      {est && (
        <div className="rounded border border-edge bg-panel-2 p-2">
          <div className="num grid grid-cols-3 gap-1 text-[11px]">
            <span>~{est.estimate.cells} blocks</span>
            <span>~{est.estimate.fuel} fuel</span>
            <span>~{Math.round(est.estimate.seconds / 60)} min</span>
            <span>~{est.estimate.trips} trip(s)</span>
            <span>~{est.estimate.moves} moves</span>
          </div>
          <p className="mt-1 text-[10px] text-slate-500">{est.estimate.note}</p>
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
        <button onClick={() => create(false)} disabled={!input} className="rounded border border-edge px-2 py-1 hover:bg-slate-700/60 disabled:opacity-40">
          Create
        </button>
        <button onClick={() => create(true)} disabled={!input} className="rounded bg-cyan-600 px-3 py-1 font-semibold text-slate-950 hover:bg-cyan-500 disabled:opacity-40">
          Create &amp; start
        </button>
      </div>
    </div>
  );
}
