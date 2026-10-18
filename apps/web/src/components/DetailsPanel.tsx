import { useEffect, useState } from 'react';
import type { TurtleView } from '@ccfleet/protocol';
import { api } from '../lib/api';
import { runBatch, useFleet } from '../lib/store';
import { HEADING_SHORT, STATUS_COLOR, STATUS_LABEL, ago, chunkOf, fuelFraction, isChunky, shortItem, statusOf } from '../lib/status';

export function DetailsPanel() {
  const focusId = useFleet((s) => s.focusId);
  const t = useFleet((s) => (s.focusId ? s.turtles[s.focusId] : undefined));
  const groups = useFleet((s) => s.groups);
  const selectionCount = useFleet((s) => s.selection.length);

  if (!t) {
    return (
      <div className="p-4 text-xs text-slate-500">
        {focusId ? 'This turtle was removed.' : selectionCount > 1 ? `${selectionCount} turtles selected. Click one to see its details.` : 'Select a turtle to see its details.'}
      </div>
    );
  }
  const status = statusOf(t);
  const st = t.state;
  const pose = st?.pose;
  const ff = fuelFraction(t);

  return (
    <div className="space-y-3 p-3 text-xs">
      <div className="flex items-start gap-2">
        <i className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: STATUS_COLOR[status] }} />
        <div className="min-w-0 flex-1">
          <EditableName t={t} />
          <div className="text-[11px] text-dim">
            {STATUS_LABEL[status]} · {t.connection === 'offline' ? `last seen ${ago(t.lastSeen)}` : t.connection}
            {t.simulated ? ' · simulated' : ' · real turtle'}
          </div>
        </div>
        {t.simulated && <span className="rounded bg-violet-900/60 px-1.5 py-0.5 text-[10px] font-bold text-violet-200">SIM</span>}
      </div>

      {t.connection === 'offline' && (
        <Notice tone="gray">Offline. Its last known position is still treated as occupied until it reconnects and reports in.</Notice>
      )}
      {t.pendingStop && <Notice tone="amber">A stop was requested while offline. It will be delivered when the turtle reconnects — it has not received it yet.</Notice>}
      {st?.hold && <Notice tone="amber">{st.hold.reason === 'estop' ? 'Emergency-stopped' : 'Paused'}. Physical actions are refused until you press Resume.</Notice>}

      <Section title="Position">
        {pose?.pos ? (
          <div className="num text-sm">
            X {pose.pos.x} · Y {pose.pos.y} · Z {pose.pos.z} · {pose.heading !== undefined ? HEADING_SHORT[pose.heading] : '?'}
          </div>
        ) : (
          <div className="text-amber-300">Unknown — calibrate below.</div>
        )}
        <div className="mt-1 flex flex-wrap gap-1">
          <Badge ok={pose?.position === 'known'}>position {pose?.position ?? 'unknown'}</Badge>
          <Badge ok={pose?.headingConfidence === 'known'}>heading {pose?.headingConfidence ?? 'unknown'}</Badge>
          <Badge ok>source {pose?.source ?? 'none'}</Badge>
        </div>
        {pose?.position === 'uncertain' && (
          <p className="mt-1 text-amber-300">
            The turtle restarted mid-move and cannot tell whether the move happened. Possible cells:{' '}
            <span className="num">{(pose.candidates ?? []).map((c) => `(${c.x} ${c.y} ${c.z})`).join(' or ')}</span>. Use a GPS fix or calibrate manually.
          </p>
        )}
        <div className="mt-1 text-[11px] text-dim">
          World <span className="text-ink">{t.world}</span> · {t.dimension.replace('minecraft:', '')}
        </div>
        <Calibrate t={t} />
      </Section>

      <Section title="Upgrades & chunk loading">
        <Row k="Left" v={st?.upgrades?.left ?? 'tool / none'} />
        <Row k="Right" v={st?.upgrades?.right ?? 'tool / none'} />
        {pose?.pos && <Row k="Chunk" v={<span className="num">{`${chunkOf(pose.pos.x, pose.pos.z).cx}, ${chunkOf(pose.pos.x, pose.pos.z).cz}`}</span>} />}
        {isChunky(t) ? (
          <p className="mt-1 text-[11px] text-emerald-300">
            Chunk Controller: keeps the chunk it is in loaded (and moves the load with it), even with no player near — as long as the world is running. Expires if the turtle stops refreshing it for the
            configured time (600 s in your config).
          </p>
        ) : (
          st && (
            <p className="mt-1 text-[11px] text-dim">
              No Chunk Controller: it stops when no player is near. Craft a Chunky Turtle (turtle + Advanced Peripherals Chunk Controller) or equip one on a free side.
            </p>
          )
        )}
        {st && !st.upgrades && <p className="mt-1 text-[11px] text-amber-300">This agent doesn't report upgrades yet: run "install" on the turtle to update it.</p>}
      </Section>

      <Section title="Fuel">
        {st ? (
          st.fuel === 'unlimited' ? (
            <div>Unlimited (fuel disabled in server config)</div>
          ) : (
            <>
              <div className="num">
                {st.fuel.toLocaleString()} / {typeof st.fuelLimit === 'number' ? st.fuelLimit.toLocaleString() : '∞'}
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded bg-slate-800">
                <div className="h-full" style={{ width: `${(ff ?? 0) * 100}%`, background: (ff ?? 0) < 0.05 ? '#f87171' : '#facc15' }} />
              </div>
            </>
          )
        ) : (
          <div className="text-dim">No telemetry yet.</div>
        )}
      </Section>

      <Section title="Inventory">
        <div className="grid grid-cols-4 gap-1">
          {Array.from({ length: 16 }, (_, i) => {
            const item = st?.inventory.find((x) => x.slot === i + 1);
            const selected = st?.selectedSlot === i + 1;
            return (
              <button
                key={i}
                title={item ? `${item.name} ×${item.count} (slot ${i + 1})` : `Slot ${i + 1} (empty)`}
                onClick={() => t.connection !== 'offline' && runBatch(api.command({ turtleIds: [t.id] }, 'select', { slot: i + 1 }))}
                className={`relative h-11 rounded border text-left ${selected ? 'border-cyan-400' : 'border-edge'} bg-panel-2 p-1 hover:border-slate-500`}
              >
                <span className="absolute left-1 top-0.5 text-[9px] text-slate-600">{i + 1}</span>
                {item && (
                  <>
                    <span className="block truncate pt-2 text-[9px] leading-tight">{shortItem(item.name)}</span>
                    <span className="num absolute bottom-0.5 right-1 text-[10px] font-semibold">{item.count}</span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Activity">
        <Row k="Current command" v={st?.currentCommandId ? <span className="num">{st.currentCommandId}</span> : 'none'} />
        <Row k="Queued" v={<span className="num">{t.queueLength}</span>} />
        <Row
          k="Job"
          v={
            t.job ? (
              <button className="text-cyan-300 hover:underline" onClick={() => useFleet.getState().setRightTab('jobs')}>
                {t.job.name} · {t.job.status}
                {t.job.status === 'running' ? ` · ${t.job.phase}` : ''}
              </button>
            ) : (
              'none'
            )
          }
        />
        {st?.lastError && (
          <div className="mt-1 rounded border border-red-900/60 bg-red-950/30 p-1.5 text-red-200">
            Last error <span className="num">[{st.lastError.code}]</span> {st.lastError.message}
            {st.lastError.at && <span className="text-red-300/60"> · {ago(st.lastError.at)}</span>}
          </div>
        )}
      </Section>

      <Section title="Identity">
        <Row k="Turtle id" v={<span className="num">{t.id}</span>} />
        <Row k="Computer" v={<span className="num">#{t.computerId}</span>} />
        <Row k="Label" v={t.label ?? '—'} />
        <Row k="Agent" v={t.agentVersion ?? '—'} />
        <Row k="Groups" v={groups.filter((g) => g.memberIds.includes(t.id)).map((g) => g.name).join(', ') || '—'} />
        <Row k="Enrolled" v={new Date(t.createdAt).toLocaleString()} />
        <button
          className="mt-2 text-[11px] text-red-400 hover:underline"
          onClick={async () => {
            if (!confirm(`Remove ${t.name}? Its credentials are revoked and it must be paired again.`)) return;
            try {
              await api.removeTurtle(t.id);
            } catch (e) {
              useFleet.getState().toast('error', (e as Error).message);
            }
          }}
        >
          Remove turtle and revoke credentials
        </button>
      </Section>
    </div>
  );
}

function EditableName({ t }: { t: TurtleView }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(t.name);
  useEffect(() => setName(t.name), [t.name]);
  if (!editing)
    return (
      <button className="truncate text-left text-sm font-semibold hover:underline" title="Rename" onClick={() => setEditing(true)}>
        {t.name}
      </button>
    );
  const save = async () => {
    setEditing(false);
    if (name.trim() && name !== t.name) {
      try {
        await api.updateTurtle(t.id, { name: name.trim() });
      } catch (e) {
        useFleet.getState().toast('error', (e as Error).message);
      }
    }
  };
  return (
    <input
      autoFocus
      value={name}
      maxLength={40}
      onChange={(e) => setName(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && save()}
      className="w-full rounded border border-edge bg-panel-2 px-1 text-sm"
    />
  );
}

function Calibrate({ t }: { t: TurtleView }) {
  const pose = t.state?.pose;
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ x: '', y: '', z: '', heading: '0' });
  useEffect(() => {
    if (open) setV({ x: String(pose?.pos?.x ?? ''), y: String(pose?.pos?.y ?? ''), z: String(pose?.pos?.z ?? ''), heading: String(pose?.heading ?? 0) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const offline = t.connection === 'offline';
  if (!open)
    return (
      <div className="mt-2 flex gap-1">
        <SmallBtn disabled={offline} onClick={() => setOpen(true)}>
          Calibrate…
        </SmallBtn>
        <SmallBtn disabled={offline} onClick={() => runBatch(api.command({ turtleIds: [t.id] }, 'gpsLocate'))} title="Needs GPS hosts in range. Fixes position only, never heading.">
          GPS fix
        </SmallBtn>
      </div>
    );
  const valid = [v.x, v.y, v.z].every((s) => /^-?\d+$/.test(s.trim()));
  return (
    <div className="mt-2 space-y-1.5 rounded border border-edge bg-panel-2 p-2">
      <p className="text-[11px] text-dim">
        Enter the turtle's block coordinates (F3 screen while looking at it) and the direction its front faces. GPS can fix the position but never the heading.
      </p>
      <div className="grid grid-cols-4 gap-1">
        {(['x', 'y', 'z'] as const).map((k) => (
          <label key={k} className="text-[10px] uppercase text-dim">
            {k}
            <input value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} className="num w-full rounded border border-edge bg-panel px-1 py-0.5 text-xs text-ink" />
          </label>
        ))}
        <label className="text-[10px] uppercase text-dim">
          facing
          <select value={v.heading} onChange={(e) => setV({ ...v, heading: e.target.value })} className="w-full rounded border border-edge bg-panel px-1 py-0.5 text-xs text-ink">
            <option value="0">North (−Z)</option>
            <option value="1">East (+X)</option>
            <option value="2">South (+Z)</option>
            <option value="3">West (−X)</option>
          </select>
        </label>
      </div>
      <div className="flex gap-1">
        <SmallBtn
          disabled={!valid || offline}
          onClick={async () => {
            const b = await runBatch(api.command({ turtleIds: [t.id] }, 'calibrate', { x: Number(v.x), y: Number(v.y), z: Number(v.z), heading: Number(v.heading) }));
            if (b) setOpen(false);
          }}
        >
          Apply calibration
        </SmallBtn>
        <SmallBtn onClick={() => setOpen(false)}>Cancel</SmallBtn>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-dim">{title}</h3>
      {children}
    </section>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2 py-0.5">
      <span className="text-dim">{k}</span>
      <span className="truncate text-right">{v}</span>
    </div>
  );
}

function Badge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <span className={`rounded px-1.5 py-0.5 text-[10px] ${ok ? 'bg-emerald-950 text-emerald-300' : 'bg-amber-950 text-amber-300'}`}>{children}</span>;
}

function Notice({ tone, children }: { tone: 'amber' | 'gray'; children: React.ReactNode }) {
  return <div className={`rounded border p-1.5 text-[11px] ${tone === 'amber' ? 'border-amber-800 bg-amber-950/40 text-amber-200' : 'border-slate-700 bg-slate-900 text-slate-300'}`}>{children}</div>;
}

function SmallBtn(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className="rounded border border-edge bg-panel px-2 py-0.5 text-[11px] hover:bg-slate-700/60 disabled:opacity-40" />;
}
