import { useEffect } from 'react';
import type { Op } from '@ccfleet/protocol';
import { api } from '../lib/api';
import { runBatch, useFleet } from '../lib/store';
import { DRIVE_KEYS, isTyping } from '../lib/keys';
import { STATUS_COLOR, hasScanner, statusOf } from '../lib/status';

/**
 * Contextual command toolbar. The target strip always shows exactly which turtles a
 * button will affect, and which of them will not receive it.
 */
export function CommandBar() {
  const turtles = useFleet((s) => s.turtles);
  const selection = useFleet((s) => s.selection);
  const targets = selection.map((id) => turtles[id]).filter(Boolean);
  const offline = targets.filter((t) => t.connection === 'offline');
  const held = targets.filter((t) => t.connection !== 'offline' && t.state?.hold);
  const none = targets.length === 0;
  const ids = targets.map((t) => t.id);

  const send = (op: Op, args: Record<string, unknown> = {}) => runBatch(api.command({ turtleIds: ids }, op, args));

  // Keyboard driving for the current selection (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const sel = useFleet.getState().selection;
      if (e.key === 'Escape') return useFleet.getState().select([]);
      const op = DRIVE_KEYS[e.key.toLowerCase()];
      if (op && sel.length) {
        e.preventDefault();
        runBatch(api.command({ turtleIds: sel }, op));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="border-t border-edge bg-panel">
      {/* Target strip */}
      <div className="flex items-center gap-2 border-b border-edge px-3 py-1.5 text-xs">
        <span className={`shrink-0 rounded px-1.5 py-0.5 font-bold ${none ? 'bg-slate-800 text-slate-500' : 'bg-cyan-500 text-slate-950'}`}>
          {none ? 'NO TARGET' : `${targets.length} TARGET${targets.length > 1 ? 'S' : ''}`}
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap gap-1 overflow-hidden" style={{ maxHeight: 44 }}>
          {targets.slice(0, 40).map((t) => (
            <span key={t.id} className={`flex items-center gap-1 rounded bg-panel-2 px-1.5 py-0.5 ${t.connection === 'offline' ? 'text-slate-500 line-through' : ''}`}>
              <i className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS_COLOR[statusOf(t)] }} />
              {t.name}
            </span>
          ))}
          {targets.length > 40 && <span className="text-dim">+{targets.length - 40} more</span>}
          {none && <span className="text-slate-500">Select turtles on the map or in the fleet list. Commands only go to selected turtles.</span>}
        </div>
        {offline.length > 0 && <span className="shrink-0 text-amber-400">{offline.length} offline — will not receive commands</span>}
        {held.length > 0 && <span className="shrink-0 text-amber-300">{held.length} paused — resume before moving</span>}
      </div>

      <div className="flex flex-wrap items-stretch gap-3 px-3 py-2">
        <Group title="Move  (W/S/A/D, R/F)">
          <Btn disabled={none} onClick={() => send('turnLeft')} title="Turn left (A)">⟲</Btn>
          <Btn disabled={none} onClick={() => send('forward')} title="Forward (W)">▲</Btn>
          <Btn disabled={none} onClick={() => send('turnRight')} title="Turn right (D)">⟳</Btn>
          <Btn disabled={none} onClick={() => send('back')} title="Back (S)">▼</Btn>
          <Btn disabled={none} onClick={() => send('up')} title="Up (R)">Up</Btn>
          <Btn disabled={none} onClick={() => send('down')} title="Down (F)">Dn</Btn>
        </Group>
        <Group title="Dig (explicit)">
          <Btn tone="amber" disabled={none} onClick={() => send('dig')} title="Dig the block in front">Front</Btn>
          <Btn tone="amber" disabled={none} onClick={() => send('digUp')} title="Dig the block above">Up</Btn>
          <Btn tone="amber" disabled={none} onClick={() => send('digDown')} title="Dig the block below">Down</Btn>
        </Group>
        <Group title="Inspect">
          <Btn disabled={none} onClick={() => send('inspect')}>Front</Btn>
          <Btn disabled={none} onClick={() => send('inspectUp')}>Up</Btn>
          <Btn disabled={none} onClick={() => send('inspectDown')}>Down</Btn>
        </Group>
        <Group title="Utility">
          <Btn disabled={none} onClick={() => send('gpsLocate')} title="GPS position fix (needs GPS hosts in range; never sets heading)">GPS fix</Btn>
          <Btn
            disabled={none}
            onClick={() => {
              const slot = Number(prompt('Select which slot (1-16)?', '1'));
              if (slot >= 1 && slot <= 16) send('select', { slot });
            }}
          >
            Slot…
          </Btn>
          <Btn disabled={none} onClick={() => send('refuel')} title="Refuel from the selected slot">Refuel</Btn>
          <Btn
            disabled={!targets.some(hasScanner)}
            onClick={() => runBatch(api.command({ turtleIds: targets.filter(hasScanner).map((t) => t.id) }, 'geoScan', { radius: 8 }))}
            title="Geo Scanner (Advanced Peripherals): map every block within 8 blocks, free. Right-click a turtle for radius 16 (costs fuel)."
          >
            Geo scan
          </Btn>
        </Group>
        <Group title="Control">
          <Btn disabled={none} onClick={() => runBatch(api.stop({ turtleIds: ids }, 'pause'))} title="Pause after the current atomic action">Pause</Btn>
          <Btn disabled={none} onClick={() => runBatch(api.resume({ turtleIds: ids }))}>Resume</Btn>
          <Btn disabled={none} onClick={() => runBatch(api.cancel({ turtleIds: ids }))} title="Cancel queued commands">Cancel</Btn>
          <Btn
            disabled={targets.length !== 1}
            title="Drive one turtle to a coordinate through known space, without digging, giving way to other turtles"
            onClick={() => {
              const t = targets[0];
              const p = t?.state?.pose.pos;
              const input = prompt(`Send ${t.name} to x y z:`, p ? `${p.x} ${p.y} ${p.z}` : '');
              const c = input?.trim().split(/[\s,]+/).map(Number);
              if (!c || c.length !== 3 || c.some((n) => !Number.isInteger(n))) return;
              api.goto(t.id, { x: c[0], y: c[1], z: c[2] }).catch((e) => useFleet.getState().toast('error', (e as Error).message));
            }}
          >
            Go to…
          </Btn>
          <Btn onClick={() => useFleet.getState().setRightTab('jobs')} title="Mining jobs (return, unloading and refuelling happen inside jobs)">
            Jobs…
          </Btn>
        </Group>
        <button
          disabled={none}
          onClick={() => runBatch(api.stop({ turtleIds: ids }, 'estop'))}
          className="ml-auto rounded-md border border-red-500 bg-red-600 px-4 text-sm font-black tracking-wide text-white shadow-[0_0_12px_rgba(239,68,68,0.35)] hover:bg-red-500 disabled:border-red-950 disabled:bg-red-950/40 disabled:text-red-900 disabled:shadow-none"
          title="Emergency stop the selected turtles after their current atomic action"
        >
          E-STOP {none ? '' : `(${targets.length})`}
        </button>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-dim">{title}</div>
      <div className="flex gap-1">{children}</div>
    </div>
  );
}

function Btn({ tone, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'amber' }) {
  const base = tone === 'amber' ? 'border-amber-700/70 bg-amber-900/30 text-amber-100 hover:bg-amber-800/50' : 'border-edge bg-panel-2 hover:bg-slate-700/60';
  return <button {...props} className={`min-w-9 rounded border px-2 py-1 text-xs ${base} disabled:cursor-not-allowed disabled:opacity-35`} />;
}
