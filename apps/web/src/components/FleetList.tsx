import { useMemo, useState } from 'react';
import type { TurtleView } from '@ccfleet/protocol';
import { api } from '../lib/api';
import { useFleet } from '../lib/store';
import { STATUS_COLOR, STATUS_LABEL, fuelFraction, isChunky, statusOf } from '../lib/status';

type Filter = 'all' | 'online' | 'offline' | 'attention' | 'real' | 'sim';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'online', label: 'Online' },
  { id: 'offline', label: 'Offline' },
  { id: 'attention', label: 'Attention' },
  { id: 'real', label: 'Real' },
  { id: 'sim', label: 'Sim' },
];

export function needsAttention(t: TurtleView): boolean {
  const st = t.state;
  return (
    t.connection === 'stale' ||
    t.pendingStop ||
    statusOf(t) === 'error' ||
    statusOf(t) === 'blocked' ||
    st?.pose.position !== 'known' ||
    st?.pose.headingConfidence !== 'known' ||
    (typeof st?.fuel === 'number' && st.fuel < 100)
  );
}

export function FleetList({ onEnroll }: { onEnroll: () => void }) {
  const turtles = useFleet((s) => s.turtles);
  const allTurtles = useFleet((s) => s.allTurtles);
  const groups = useFleet((s) => s.groups);
  const selection = useFleet((s) => s.selection);
  const focusId = useFleet((s) => s.focusId);
  const select = useFleet((s) => s.select);
  const focus = useFleet((s) => s.focus);
  const toast = useFleet((s) => s.toast);
  const world = useFleet((s) => s.world);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [groupFilter, setGroupFilter] = useState<string>('');
  const [lastClicked, setLastClicked] = useState<string>();

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const g = groups.find((x) => x.id === groupFilter);
    return Object.values(turtles)
      .filter((t) => !needle || t.name.toLowerCase().includes(needle) || t.id.toLowerCase().includes(needle) || (t.label ?? '').toLowerCase().includes(needle) || String(t.computerId) === needle)
      .filter((t) => !g || g.memberIds.includes(t.id))
      .filter((t) => {
        switch (filter) {
          case 'online':
            return t.connection !== 'offline';
          case 'offline':
            return t.connection === 'offline';
          case 'attention':
            return needsAttention(t);
          case 'real':
            return !t.simulated;
          case 'sim':
            return t.simulated;
          default:
            return true;
        }
      })
      .sort((a, b) => Number(a.connection === 'offline') - Number(b.connection === 'offline') || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [turtles, groups, q, filter, groupFilter]);
  const elsewhere = Object.values(allTurtles).filter((t) => t.world !== world).length;

  const sel = new Set(selection);
  const allVisibleSelected = list.length > 0 && list.every((t) => sel.has(t.id));

  const onRowClick = (e: React.MouseEvent, t: TurtleView) => {
    if (e.shiftKey && lastClicked) {
      const i = list.findIndex((x) => x.id === lastClicked);
      const j = list.findIndex((x) => x.id === t.id);
      if (i >= 0 && j >= 0) {
        const [a, b] = i < j ? [i, j] : [j, i];
        select(list.slice(a, b + 1).map((x) => x.id), 'add');
        return;
      }
    }
    setLastClicked(t.id);
    select([t.id], e.ctrlKey || e.metaKey ? 'toggle' : 'replace');
    if (!(e.ctrlKey || e.metaKey)) focus(t.id);
  };

  const groupAction = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  const newGroup = () => {
    const name = prompt(`Name for a new group with ${selection.length} selected turtle(s):`);
    if (name) groupAction(() => api.createGroup(name, selection));
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-dim">
          Fleet <span className="num text-ink">{Object.keys(turtles).length}</span>
        </h2>
        <button onClick={onEnroll} className="rounded bg-cyan-700/40 px-2 py-0.5 text-xs text-cyan-200 hover:bg-cyan-600/50">
          + Add turtle
        </button>
      </div>

      <div className="space-y-2 border-b border-edge p-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, id, label, #computer"
          className="w-full rounded border border-edge bg-panel-2 px-2 py-1 text-sm placeholder:text-slate-600"
        />
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`rounded px-1.5 py-0.5 text-[11px] ${filter === f.id ? 'bg-cyan-800/60 text-cyan-100' : 'bg-panel-2 text-dim hover:text-ink'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Groups */}
      <div className="border-b border-edge p-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wider text-dim">Groups</span>
          <button disabled={!selection.length} onClick={newGroup} className="text-[11px] text-cyan-300 hover:underline disabled:text-slate-600 disabled:no-underline">
            + from selection
          </button>
        </div>
        {groups.length === 0 && <p className="text-[11px] text-slate-600">No groups yet. Select turtles, then “+ from selection”.</p>}
        <div className="space-y-0.5">
          {groups.map((g) => (
            <div key={g.id} className={`group flex items-center gap-1 rounded px-1 py-0.5 text-xs ${groupFilter === g.id ? 'bg-panel-2' : ''}`}>
              <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: g.color }} />
              <button className="flex-1 truncate text-left hover:text-white" title="Select all members" onClick={() => select(g.memberIds)}>
                {g.name} <span className="num text-dim">({g.memberIds.filter((m) => turtles[m]).length})</span>
              </button>
              <span className="hidden gap-1 group-hover:flex">
                <IconBtn title="Show only this group in the list" onClick={() => setGroupFilter(groupFilter === g.id ? '' : g.id)}>
                  ⧩
                </IconBtn>
                <IconBtn title="Add selected turtles" disabled={!selection.length} onClick={() => groupAction(() => api.setMembers(g.id, [...g.memberIds, ...selection]))}>
                  +
                </IconBtn>
                <IconBtn title="Remove selected turtles" disabled={!selection.length} onClick={() => groupAction(() => api.setMembers(g.id, g.memberIds.filter((m) => !sel.has(m))))}>
                  −
                </IconBtn>
                <IconBtn
                  title="Rename"
                  onClick={() => {
                    const n = prompt('Rename group', g.name);
                    if (n) groupAction(() => api.renameGroup(g.id, n));
                  }}
                >
                  ✎
                </IconBtn>
                <IconBtn title="Delete group (turtles are kept)" onClick={() => confirm(`Delete group "${g.name}"? Turtles are not affected.`) && groupAction(() => api.deleteGroup(g.id))}>
                  ×
                </IconBtn>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-edge px-3 py-1 text-[11px] text-dim">
        <input
          type="checkbox"
          checked={allVisibleSelected}
          onChange={() => select(allVisibleSelected ? [] : list.map((t) => t.id))}
          aria-label="Select all listed turtles"
        />
        <span>{allVisibleSelected ? 'Deselect' : 'Select'} all listed ({list.length})</span>
        {groupFilter && (
          <button className="ml-auto text-cyan-300" onClick={() => setGroupFilter('')}>
            clear group filter
          </button>
        )}
      </div>

      <ul className="flex-1 overflow-y-auto">
        {list.map((t) => {
          const status = statusOf(t);
          const ff = fuelFraction(t);
          const pos = t.state?.pose.pos;
          return (
            <li
              key={t.id}
              onClick={(e) => onRowClick(e, t)}
              onDoubleClick={() => focus(t.id, true)}
              className={`cursor-pointer border-l-2 px-2 py-1.5 text-xs ${sel.has(t.id) ? 'border-cyan-400 bg-cyan-950/40' : 'border-transparent hover:bg-panel-2'} ${focusId === t.id ? 'ring-1 ring-inset ring-white/20' : ''}`}
            >
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={sel.has(t.id)} onClick={(e) => e.stopPropagation()} onChange={() => select([t.id], 'toggle')} aria-label={`Select ${t.name}`} />
                <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS_COLOR[status] }} />
                <span className={`truncate font-medium ${t.connection === 'offline' ? 'text-slate-500' : ''}`}>{t.name}</span>
                {t.simulated && <span className="rounded bg-violet-900/60 px-1 text-[9px] font-bold text-violet-200">SIM</span>}
                {isChunky(t) && (
                  <span className="rounded bg-emerald-900/60 px-1 text-[9px] font-bold text-emerald-200" title="Chunk Controller equipped: keeps its own chunk loaded">
                    CHUNK
                  </span>
                )}
                {needsAttention(t) && <span className="text-amber-400" title="Needs attention">!</span>}
                {t.queue && (
                  <span className="rounded bg-violet-900/60 px-1 text-[9px] font-bold text-violet-200" title={`${t.queue.count} job(s) queued; next: "${t.queue.next.name}"`}>
                    +{t.queue.count}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-dim">{STATUS_LABEL[status]}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 pl-6 text-[10px] text-dim">
                <span className="num">{pos ? `${pos.x} ${pos.y} ${pos.z}` : 'pos unknown'}</span>
                {t.state?.pose.position === 'uncertain' && <span className="text-amber-400">uncertain</span>}
                {t.queueLength > 0 && <span className="num text-cyan-300">q{t.queueLength}</span>}
                <span className="ml-auto flex items-center gap-1">
                  {ff !== undefined ? (
                    <span className="h-1 w-10 overflow-hidden rounded bg-slate-800">
                      <span className="block h-full" style={{ width: `${ff * 100}%`, background: ff < 0.05 ? '#f87171' : '#facc15' }} />
                    </span>
                  ) : (
                    t.state?.fuel === 'unlimited' && <span>∞ fuel</span>
                  )}
                </span>
              </div>
            </li>
          );
        })}
        {list.length === 0 && (
          <li className="p-4 text-center text-xs text-slate-600">
            {Object.keys(allTurtles).length === 0 ? 'No turtles yet. Start the simulator or add a turtle.' : elsewhere && !Object.keys(turtles).length ? `No turtles in "${world}" yet. Add a turtle to pair one into it.` : 'Nothing matches.'}
          </li>
        )}
        {elsewhere > 0 && (
          <li className="px-3 py-2 text-[11px] text-slate-500" title="Switch instance at the top of the page">
            {elsewhere} turtle{elsewhere === 1 ? '' : 's'} in other instances
          </li>
        )}
      </ul>
    </div>
  );
}

function IconBtn(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className="w-4 text-center text-dim hover:text-white disabled:text-slate-700" />;
}
