import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { api, setUnauthorizedHandler } from './lib/api';
import { connectLive, disconnectLive, runBatch, useFleet } from './lib/store';
import { MapView } from './components/MapView';
import { FleetList } from './components/FleetList';
import { DetailsPanel } from './components/DetailsPanel';
import { CommandBar } from './components/CommandBar';
import { ResultsPanel } from './components/ResultsPanel';
import { ActivityLog } from './components/ActivityLog';
import { EnrollDialog } from './components/EnrollDialog';
import { JobsPanel } from './components/JobsPanel';
import { DepotsPanel } from './components/DepotsPanel';
import { OresPanel } from './components/OresPanel';
import { MapContextMenu } from './components/MapContextMenu';

export function App() {
  const [auth, setAuth] = useState<'checking' | 'in' | 'out'>('checking');
  useEffect(() => {
    setUnauthorizedHandler(() => setAuth('out'));
    api.me().then((r) => setAuth(r.loggedIn ? 'in' : 'out'), () => setAuth('out'));
  }, []);
  useEffect(() => {
    if (auth !== 'in') return;
    connectLive();
    return disconnectLive;
  }, [auth]);

  if (auth === 'checking') return <div className="grid h-full place-items-center text-dim">Connecting…</div>;
  if (auth === 'out') return <Login onDone={() => setAuth('in')} />;
  return <Dashboard onLogout={() => setAuth('out')} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string>();
  return (
    <div className="grid h-full place-items-center bg-[radial-gradient(ellipse_at_top,#0b2a3a,transparent_60%)]">
      <form
        className="w-80 space-y-3 rounded-lg border border-edge bg-panel p-6 shadow-2xl"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.login(pw);
            onDone();
          } catch (e2) {
            setErr((e2 as Error).message);
          }
        }}
      >
        <div>
          <h1 className="text-lg font-bold tracking-wide">CC FLEET</h1>
          <p className="text-xs text-dim">Turtle fleet control</p>
        </div>
        <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Dashboard password" className="w-full rounded border border-edge bg-panel-2 px-2 py-1.5 text-sm" />
        {err && <p className="text-xs text-red-300">{err}</p>}
        <button className="w-full rounded bg-cyan-600 py-1.5 text-sm font-semibold text-slate-950 hover:bg-cyan-500">Log in</button>
        <p className="text-[11px] text-slate-600">The password is ADMIN_PASSWORD in the backend's .env.</p>
      </form>
    </div>
  );
}

type BottomTab = 'results' | 'activity';

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [enrolling, setEnrolling] = useState(false);
  const [tab, setTab] = useState<BottomTab>('results');
  const live = useFleet((s) => s.live);
  const turtles = useFleet((s) => s.turtles);
  const toasts = useFleet((s) => s.toasts);
  const batches = useFleet((s) => s.batches);

  // Switch to results when a new batch is created.
  const latest = batches[0]?.id;
  useEffect(() => {
    if (latest) setTab('results');
  }, [latest]);

  const counts = useMemo(() => {
    const all = Object.values(turtles);
    return { total: all.length, online: all.filter((t) => t.connection !== 'offline').length, sim: all.filter((t) => t.simulated).length };
  }, [turtles]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-edge bg-panel px-3">
        <span className="font-bold tracking-wider">
          CC<span className="text-accent">FLEET</span>
        </span>
        <LiveBadge live={live} />
        <span className="num text-xs text-dim">
          {counts.online}/{counts.total} online{counts.sim ? ` · ${counts.sim} simulated` : ''}
        </span>
        <WorldPicker />
        <GoTo />
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={async () => {
              await api.logout().catch(() => {});
              onLogout();
            }}
            className="text-xs text-dim hover:text-ink"
          >
            Log out
          </button>
          <button
            onClick={() => runBatch(api.stop({ all: true }, 'estop'))}
            disabled={counts.total === 0}
            className="rounded border border-red-500 bg-red-700 px-3 py-1 text-xs font-black tracking-wider text-white hover:bg-red-600 disabled:opacity-40"
            title="Emergency-stop every turtle after its current atomic action. Offline turtles are listed as unreachable."
          >
            STOP ALL
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 border-r border-edge bg-panel">
          <FleetList onEnroll={() => setEnrolling(true)} />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <div className="relative min-w-0 flex-1">
              <MapArea />
            </div>
            <YSlider />
          </div>
          <CommandBar />
          <div className="h-52 shrink-0 border-t border-edge bg-panel">
            <div className="flex border-b border-edge text-xs">
              {(['results', 'activity'] as BottomTab[]).map((t) => (
                <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 capitalize ${tab === t ? 'border-b-2 border-cyan-400 text-ink' : 'text-dim hover:text-ink'}`}>
                  {t === 'results' ? 'Command results' : 'Activity & alerts'}
                </button>
              ))}
            </div>
            <div className="h-[calc(100%-29px)]">{tab === 'results' ? <ResultsPanel /> : <ActivityLog />}</div>
          </div>
        </main>

        <aside className="flex w-80 shrink-0 flex-col border-l border-edge bg-panel">
          <RightTabs />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <RightPanel />
          </div>
        </aside>
      </div>

      {enrolling && <EnrollDialog onClose={() => setEnrolling(false)} />}

      <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={`pointer-events-auto rounded border px-3 py-2 text-xs shadow-lg ${t.level === 'error' ? 'border-red-700 bg-red-950 text-red-100' : 'border-edge bg-panel-2'}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function LiveBadge({ live }: { live: 'connecting' | 'live' | 'down' }) {
  const cls = live === 'live' ? 'bg-emerald-500' : live === 'connecting' ? 'bg-amber-400 animate-pulse' : 'bg-red-500 animate-pulse';
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-dim" title="Dashboard connection to the backend">
      <i className={`h-2 w-2 rounded-full ${cls}`} />
      {live === 'live' ? 'live' : live === 'connecting' ? 'connecting' : 'backend unreachable — data may be stale'}
    </span>
  );
}

function WorldPicker() {
  const turtles = useFleet((s) => s.turtles);
  const world = useFleet((s) => s.world);
  const dimension = useFleet((s) => s.dimension);
  const setWorld = useFleet((s) => s.setWorld);
  const options = useMemo(() => {
    const set = new Map<string, { world: string; dimension: string }>();
    set.set(`${world}|${dimension}`, { world, dimension });
    for (const t of Object.values(turtles)) set.set(`${t.world}|${t.dimension}`, { world: t.world, dimension: t.dimension });
    return [...set.values()];
  }, [turtles, world, dimension]);
  return (
    <select
      value={`${world}|${dimension}`}
      onChange={(e) => {
        const [w, d] = e.target.value.split('|');
        setWorld(w, d);
      }}
      className="rounded border border-edge bg-panel-2 px-1 py-0.5 text-xs"
      title="World and dimension shown on the map"
    >
      {options.map((o) => (
        <option key={`${o.world}|${o.dimension}`} value={`${o.world}|${o.dimension}`}>
          {o.world === 'sim' ? 'sim (simulated)' : o.world} · {o.dimension.replace('minecraft:', '')}
        </option>
      ))}
    </select>
  );
}

/** "x z", "x y z" or a turtle name. */
function GoTo() {
  const [q, setQ] = useState('');
  const turtles = useFleet((s) => s.turtles);
  const go = () => {
    const nums = q.trim().split(/[\s,]+/).map(Number);
    const st = useFleet.getState();
    if (nums.length === 2 && nums.every(Number.isFinite)) st.centerOn(nums[0], nums[1]);
    else if (nums.length === 3 && nums.every(Number.isFinite)) {
      st.setFollowY(false);
      st.centerOn(nums[0], nums[2], nums[1]);
    } else {
      const needle = q.trim().toLowerCase();
      const t = Object.values(turtles).find((x) => x.name.toLowerCase() === needle) ?? Object.values(turtles).find((x) => x.name.toLowerCase().includes(needle));
      if (!t) return st.toast('error', `No turtle or coordinates match "${q}"`);
      st.select([t.id]);
      st.focus(t.id, true);
    }
    setQ('');
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
    >
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Go to: x z · x y z · name" className="w-48 rounded border border-edge bg-panel-2 px-2 py-0.5 text-xs placeholder:text-slate-600" />
    </form>
  );
}

function YSlider() {
  const y = useFleet((s) => s.y);
  const setY = useFleet((s) => s.setY);
  const followY = useFleet((s) => s.followY);
  const setFollowY = useFleet((s) => s.setFollowY);
  return (
    <div className="flex w-14 shrink-0 flex-col items-center gap-1 border-l border-edge bg-panel py-2 text-[10px] text-dim">
      <span>Y level</span>
      <input
        type="number"
        value={y}
        onChange={(e) => {
          setFollowY(false);
          setY(Number(e.target.value));
        }}
        className="num w-12 rounded border border-edge bg-panel-2 px-1 text-center text-xs text-ink"
      />
      <button onClick={() => (setFollowY(false), setY(y + 1))} className="w-10 rounded bg-panel-2 hover:bg-slate-700">
        ▲
      </button>
      <input
        type="range"
        min={0}
        max={255}
        value={y}
        onChange={(e) => {
          setFollowY(false);
          setY(Number(e.target.value));
        }}
        className="flex-1"
        style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
        aria-label="Y level"
      />
      <button onClick={() => (setFollowY(false), setY(y - 1))} className="w-10 rounded bg-panel-2 hover:bg-slate-700">
        ▼
      </button>
      <label className="flex flex-col items-center gap-0.5 text-center leading-tight" title="Keep the slider on the focused turtle's level">
        <input type="checkbox" checked={followY} onChange={(e) => setFollowY(e.target.checked)} />
        follow
      </label>
    </div>
  );
}

function RightTabs() {
  const tab = useFleet((s) => s.rightTab);
  const setTab = useFleet((s) => s.setRightTab);
  const jobs = useFleet((s) => s.jobs);
  const active = Object.values(jobs).filter((j) => j.status === 'running' || j.status === 'pausing').length;
  const attention = Object.values(jobs).some((j) => j.status === 'paused' && j.error);
  const tabs: { id: 'turtle' | 'jobs' | 'depots' | 'ores'; label: string; alert?: boolean }[] = [
    { id: 'turtle', label: 'Turtle' },
    { id: 'jobs', label: `Jobs${active ? ` · ${active}` : ''}`, alert: attention },
    { id: 'depots', label: 'Depots' },
    { id: 'ores', label: 'Ores' },
  ];
  return (
    <div className="flex shrink-0 border-b border-edge text-xs">
      {tabs.map((t) => (
        <button key={t.id} onClick={() => setTab(t.id)} className={`relative flex-1 px-2 py-1.5 ${tab === t.id ? 'border-b-2 border-cyan-400 text-ink' : 'text-dim hover:text-ink'}`}>
          {t.label}
          {t.alert && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-red-400" title="A job needs attention" />}
        </button>
      ))}
    </div>
  );
}

const MapView3D = lazy(() => import('./components/MapView3D'));

/** The 2D slice map or the 3D view, with the switch between them. */
function MapArea() {
  const mode = useFleet((s) => s.mapMode);
  const setMode = useFleet((s) => s.setMapMode);
  return (
    <>
      {mode === '3d' ? (
        <Suspense fallback={<div className="absolute inset-0 grid place-items-center text-xs text-dim">Loading 3D view…</div>}>
          <MapView3D />
        </Suspense>
      ) : (
        <MapView />
      )}
      <MapContextMenu />
      <div className="absolute bottom-3 right-3 z-10 flex overflow-hidden rounded border border-edge text-[11px]">
        {(['2d', '3d'] as const).map((m) => (
          <button key={m} onClick={() => setMode(m)} className={`px-2.5 py-1 font-semibold ${mode === m ? 'bg-cyan-700 text-white' : 'bg-black/60 text-dim hover:text-ink'}`}>
            {m.toUpperCase()}
          </button>
        ))}
      </div>
    </>
  );
}

function RightPanel() {
  const tab = useFleet((s) => s.rightTab);
  if (tab === 'jobs') return <JobsPanel />;
  if (tab === 'depots') return <DepotsPanel />;
  if (tab === 'ores') return <OresPanel />;
  return <DetailsPanel />;
}
