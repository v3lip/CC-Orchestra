import { useEffect, useState } from 'react';
import type { JobView } from '@ccfleet/protocol';
import { api } from '../lib/api';
import { useFleet } from '../lib/store';
import { JobForm } from './JobForm';
import { isChunky, shortItem } from '../lib/status';

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

function results(rs: { ok: boolean; error?: string }[], verb: string) {
  const ok = rs.filter((r) => r.ok).length;
  const skipped = rs.length - ok;
  useFleet.getState().toast('info', `${verb} ${ok} job(s)${skipped ? `; ${skipped} not applicable` : ''}`);
}

export function JobsPanel() {
  const jobMap = useFleet((s) => s.jobs);
  const selection = useFleet((s) => s.selection);
  const [creating, setCreating] = useState(false);
  // "New job starting here…" from the map opens the form.
  const prefill = useFleet((s) => s.jobPrefill);
  useEffect(() => {
    if (prefill) setCreating(true);
  }, [prefill]);
  const jobs = Object.values(jobMap).sort((a, b) => b.createdAt - a.createdAt);
  if (creating) return <JobForm onDone={() => setCreating(false)} />;

  // Campaigns (jobs created together) are shown as one card; the rest individually.
  const groups: { key: string; campaign?: string; jobs: JobView[] }[] = [];
  for (const j of jobs) {
    const g = j.campaignId ? groups.find((x) => x.campaign === j.campaignId) : undefined;
    if (g) g.jobs.push(j);
    else groups.push({ key: j.campaignId ?? j.id, campaign: j.campaignId, jobs: [j] });
  }
  const selectedWithJobs = selection.filter((id) => jobs.some((j) => j.turtleId === id && !['completed', 'cancelled'].includes(j.status)));

  return (
    <div className="space-y-2 p-3 text-xs">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-dim">Jobs</h3>
        <button onClick={() => setCreating(true)} className="rounded bg-cyan-700/40 px-2 py-0.5 text-cyan-200 hover:bg-cyan-600/50">
          + New job
        </button>
      </div>
      {selectedWithJobs.length > 0 && (
        <div className="flex items-center gap-1 rounded border border-edge bg-panel-2 px-2 py-1">
          <span className="flex-1 text-dim">Jobs of {selectedWithJobs.length} selected turtle(s):</span>
          <Btn tone="go" onClick={() => act(api.turtlesJobs(selection, 'start').then((r) => results(r, 'Resumed')))}>
            Resume
          </Btn>
          <Btn onClick={() => act(api.turtlesJobs(selection, 'pause').then((r) => results(r, 'Pausing')))}>Pause</Btn>
        </div>
      )}
      {jobs.length === 0 && <p className="text-slate-500">No jobs yet. Create a depot first, then a tunnel job.</p>}
      {groups.map((g) => (g.campaign ? <CampaignCard key={g.key} id={g.campaign} jobs={g.jobs} /> : <JobCard key={g.key} job={g.jobs[0]} />))}
    </div>
  );
}

function CampaignCard({ id, jobs }: { id: string; jobs: JobView[] }) {
  const [open, setOpen] = useState(false);
  const done = jobs.reduce((n, j) => n + j.progress.unitsDone, 0);
  const total = jobs.reduce((n, j) => n + j.progress.unitsTotal, 0);
  const count = (st: JobView['status']) => jobs.filter((j) => j.status === st).length;
  const attention = jobs.filter((j) => j.error).length;
  const finished = jobs.every((j) => j.status === 'completed' || j.status === 'cancelled');
  return (
    <div className="rounded border border-cyan-900/70 bg-panel-2 p-2">
      <div className="flex items-center gap-2">
        <button onClick={() => setOpen(!open)} className="text-dim hover:text-ink" aria-label="Show jobs">
          {open ? '▾' : '▸'}
        </button>
        <span className="truncate font-semibold">{jobs[0].campaignName ?? 'Campaign'}</span>
        <span className="text-[10px] text-dim">
          {jobs.length} turtles{jobs[0].lane ? ' · split lanes' : ''}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-slate-800">
        <div className="h-full bg-cyan-500" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </div>
      <div className="num mt-1 flex flex-wrap gap-x-3 text-[10px] text-dim">
        {count('running') > 0 && <span className="text-emerald-300">{count('running')} running</span>}
        {count('pausing') + count('paused') > 0 && <span className="text-amber-300">{count('pausing') + count('paused')} paused</span>}
        {count('ready') > 0 && <span>{count('ready')} ready</span>}
        {count('completed') > 0 && <span className="text-sky-300">{count('completed')} done</span>}
        {attention > 0 && <span className="text-red-300">{attention} need attention</span>}
        <span>{jobs.reduce((n, j) => n + j.progress.cellsCleared, 0)} cells</span>
        <span>{jobs.reduce((n, j) => n + j.progress.itemsUnloaded, 0)} items</span>
      </div>
      {!finished && (
        <div className="mt-1.5 flex gap-2">
          <Btn tone="go" onClick={() => act(api.campaignAction(id, 'start').then((r) => results(r, 'Started')))}>
            {count('ready') === jobs.length ? 'Start all' : 'Resume all'}
          </Btn>
          <Btn onClick={() => act(api.campaignAction(id, 'pause').then((r) => results(r, 'Pausing')))}>Pause all</Btn>
          <Btn onClick={() => confirm('Cancel every job in this campaign?') && act(api.campaignAction(id, 'cancel').then((r) => results(r, 'Cancelled')))}>Cancel all</Btn>
        </div>
      )}
      {(open || attention > 0) && (
        <div className="mt-2 space-y-1.5">
          {jobs
            .filter((j) => open || j.error)
            .map((j) => (
              <JobCard key={j.id} job={j} />
            ))}
        </div>
      )}
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
        · {describe(job)} · depot {depot?.name ?? '?'}
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
        {(p.veinBlocks ?? 0) > 0 && <span className="text-sky-300">{p.veinBlocks} from veins</span>}
        {(p.scans ?? 0) > 0 && <span className="text-cyan-200">{p.scans} scans</span>}
        {(p.torchesPlaced ?? 0) + (p.torchesMissed ?? 0) > 0 && (
          <span className="text-amber-200" title="Torches placed (and spots left dark because the turtle had none)">
            {p.torchesPlaced ?? 0} torches{p.torchesMissed ? `, ${p.torchesMissed} missed` : ''}
          </span>
        )}
        <span>{p.trips} trips</span>
        <span>{p.itemsUnloaded} items unloaded</span>
      </div>
      {job.note && active && <div className="mt-1 text-sky-300">{job.note}</div>}
      {p.finds && Object.keys(p.finds).length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {Object.entries(p.finds)
            .sort((a, b) => b[1] - a[1])
            .map(([name, n]) => (
              <span key={name} className="rounded bg-sky-950/70 px-1.5 py-0.5 text-[10px] text-sky-200">
                ◆ {shortItem(name)} ×{n}
              </span>
            ))}
        </div>
      )}
      {turtle && !isChunky(turtle) && job.status !== 'completed' && job.status !== 'cancelled' && (
        <div className="mt-1 text-[11px] text-dim" title="Without a Chunk Controller the turtle's chunk unloads when no player is near, and the job pauses (turtle offline).">
          No Chunk Controller: runs only while a player is near.
        </div>
      )}
      {job.pauseReason && job.status === 'paused' && !job.error && <div className="mt-1 text-amber-300">Paused: {job.pauseReason}</div>}
      {job.policy.autoResume && job.status === 'paused' && job.pauseReason?.startsWith('turtle went offline') && (
        <div className="mt-0.5 text-[11px] text-sky-300">Will resume by itself if the turtle reconnects within 15 min.</div>
      )}
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


/** One-line summary of a job's shape. */
function describe(job: JobView): string {
  const p = job.params as unknown as Record<string, number | string>;
  if (job.strategy === 'branch') return `branch mine ${p.length} long, branches ${p.branchLength} every ${p.spacing}`;
  if (job.strategy === 'quarry') return `quarry ${p.width}×${p.length}, ${p.depth} deep`;
  if (job.strategy === 'grid') return `grid mine ${p.width}×${p.length}, tunnels every ${p.spacing}`;
  return `tunnel ${p.width}×${p.height}×${p.length}`;
}
