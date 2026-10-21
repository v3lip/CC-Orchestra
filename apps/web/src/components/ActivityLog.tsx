import { useMemo } from 'react';
import { useFleet } from '../lib/store';
import { needsAttention } from './FleetList';

/** Actionable alerts derived from live turtle state, plus the server's event log. */
export function ActivityLog() {
  const allEvents = useFleet((s) => s.events);
  const turtles = useFleet((s) => s.turtles);
  const allTurtles = useFleet((s) => s.allTurtles);
  // Events of turtles in other instances are not shown; fleet-wide ones are.
  const events = useMemo(() => allEvents.filter((e) => !e.turtleId || !allTurtles[e.turtleId] || turtles[e.turtleId]), [allEvents, allTurtles, turtles]);
  const focus = useFleet((s) => s.focus);

  const alerts = useMemo(() => {
    const out: { id: string; text: string; tone: 'red' | 'amber' }[] = [];
    for (const t of Object.values(turtles)) {
      if (!needsAttention(t)) continue;
      const st = t.state;
      if (t.pendingStop) out.push({ id: t.id, tone: 'amber', text: `${t.name}: stop pending — offline, not yet delivered` });
      if (t.connection === 'stale') out.push({ id: t.id, tone: 'amber', text: `${t.name}: stale — no heartbeat recently` });
      if (st?.pose.position === 'uncertain') out.push({ id: t.id, tone: 'red', text: `${t.name}: position uncertain — reconcile with GPS or calibrate` });
      else if (st && st.pose.position === 'unknown') out.push({ id: t.id, tone: 'amber', text: `${t.name}: position unknown — calibrate` });
      if (st && st.pose.headingConfidence !== 'known' && st.pose.position !== 'unknown') out.push({ id: t.id, tone: 'amber', text: `${t.name}: heading ${st.pose.headingConfidence} — calibrate` });
      if (typeof st?.fuel === 'number' && st.fuel < 100) out.push({ id: t.id, tone: 'red', text: `${t.name}: low fuel (${st.fuel})` });
      if (t.status === 'blocked') out.push({ id: t.id, tone: 'amber', text: `${t.name}: blocked — ${st?.lastError?.message ?? ''}` });
    }
    return out;
  }, [turtles]);

  return (
    <div className="flex h-full flex-col text-xs">
      {alerts.length > 0 && (
        <ul className="max-h-[40%] shrink-0 overflow-y-auto border-b border-edge p-1">
          {alerts.map((a, i) => (
            <li key={i}>
              <button onClick={() => focus(a.id, true)} className={`w-full rounded px-2 py-1 text-left hover:bg-panel-2 ${a.tone === 'red' ? 'text-red-300' : 'text-amber-300'}`}>
                ⚠ {a.text}
              </button>
            </li>
          ))}
        </ul>
      )}
      <ul className="flex-1 overflow-y-auto p-1">
        {events.map((e) => (
          <li key={e.id} className="flex gap-2 px-2 py-0.5">
            <span className="num shrink-0 text-slate-600">{new Date(e.ts).toLocaleTimeString()}</span>
            <span className={e.level === 'error' ? 'text-red-300' : e.level === 'warn' ? 'text-amber-200' : 'text-slate-300'}>
              {e.turtleId && turtles[e.turtleId] ? (
                <button className="hover:underline" onClick={() => focus(e.turtleId, true)}>
                  {e.message}
                </button>
              ) : (
                e.message
              )}
            </span>
          </li>
        ))}
        {events.length === 0 && <li className="p-2 text-slate-600">No activity yet.</li>}
      </ul>
    </div>
  );
}
