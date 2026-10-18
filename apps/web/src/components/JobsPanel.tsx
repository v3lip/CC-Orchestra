import { useState } from 'react';
import type { JobView } from '@ccfleet/protocol';
import { api } from '../lib/api';
import { useFleet } from '../lib/store';
import { JobForm } from './JobForm';
import { isChunky } from '../lib/status';

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
      {job.note && active && <div className="mt-1 text-sky-300">{job.note}</div>}
      {turtle && !isChunky(turtle) && job.status !== 'completed' && job.status !== 'cancelled' && (
        <div className="mt-1 text-[11px] text-dim" title="Without a Chunk Controller the turtle's chunk unloads when no player is near, and the job pauses (turtle offline).">
          No Chunk Controller: runs only while a player is near.
        </div>
      )}
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

