import { useMemo } from 'react';
import { type BatchItem, reasonHint } from '@ccfleet/protocol';
import { useFleet } from '../lib/store';

const TONE: Record<string, string> = {
  succeeded: 'bg-emerald-900/60 text-emerald-200',
  stopped: 'bg-emerald-900/60 text-emerald-200',
  released: 'bg-emerald-900/60 text-emerald-200',
  acknowledged: 'bg-sky-900/60 text-sky-200',
  queued: 'bg-slate-800 text-slate-300',
  sent: 'bg-slate-800 text-slate-300',
  running: 'bg-sky-900/60 text-sky-200',
  failed: 'bg-red-900/60 text-red-200',
  rejected: 'bg-orange-900/60 text-orange-200',
  expired: 'bg-orange-900/60 text-orange-200',
  cancelled: 'bg-slate-700 text-slate-300',
  undeliverable: 'bg-zinc-800 text-zinc-300',
  unreachable: 'bg-amber-900/70 text-amber-100',
  unknown: 'bg-fuchsia-900/60 text-fuchsia-200',
};

const STATUS_HELP: Record<string, string> = {
  undeliverable: 'Turtle was offline. Nothing was sent.',
  unreachable: 'Turtle was offline. It did NOT receive this.',
  unknown: 'Sent, but the result never arrived. The turtle reports back when it reconnects.',
  acknowledged: 'Received. Stops once the current atomic action finishes.',
};

/** Per-turtle results of a command batch. Partial failures are shown per turtle. */
export function ResultsPanel() {
  const allBatches = useFleet((s) => s.batches);
  const activeId = useFleet((s) => s.activeBatchId);
  const turtles = useFleet((s) => s.turtles);
  // Only rows for turtles of the instance shown (STOP ALL covers every instance).
  const batches = useMemo(
    () => allBatches.map((b) => ({ ...b, items: b.items.filter((i) => turtles[i.turtleId]) })).filter((b) => b.items.length),
    [allBatches, turtles],
  );
  const setActive = useFleet((s) => s.setActiveBatch);
  const focus = useFleet((s) => s.focus);
  const batch = batches.find((b) => b.id === activeId) ?? batches[0];

  if (!batch) return <div className="p-3 text-xs text-slate-600">Command results will appear here, one row per turtle.</div>;

  const counts = batch.items.reduce<Record<string, number>>((acc, i) => ((acc[i.status] = (acc[i.status] ?? 0) + 1), acc), {});

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-1.5">
        <select value={batch.id} onChange={(e) => setActive(e.target.value)} className="min-w-0 flex-1 rounded border border-edge bg-panel-2 px-1 py-0.5 text-xs">
          {batches.map((b) => (
            <option key={b.id} value={b.id}>
              {new Date(b.createdAt).toLocaleTimeString()} — {b.label} ({b.items.length})
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap gap-1 px-3 py-1.5">
        {Object.entries(counts).map(([s, n]) => (
          <span key={s} className={`rounded px-1.5 py-0.5 text-[10px] ${TONE[s] ?? ''}`}>
            {n} {s}
          </span>
        ))}
      </div>
      <ul className="flex-1 overflow-y-auto px-1">
        {batch.items.map((i: BatchItem) => (
          <li key={i.turtleId} className="flex items-start gap-2 rounded px-2 py-1 hover:bg-panel-2">
            <button className="w-28 shrink-0 truncate text-left font-medium hover:underline" onClick={() => focus(i.turtleId, true)}>
              {turtles[i.turtleId]?.name ?? i.turtleId}
            </button>
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${TONE[i.status] ?? ''}`} title={STATUS_HELP[i.status]}>
              {i.status}
            </span>
            <span className="min-w-0 flex-1 text-dim">
              {i.code && <span className="num text-orange-300">[{i.code}] </span>}
              {i.reason ?? STATUS_HELP[i.status] ?? ''}
              {reasonHint(i.reason) && <span className="block text-amber-200/80">{reasonHint(i.reason)}</span>}
              {i.data && <span className="num block truncate text-slate-400">{JSON.stringify(i.data)}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
