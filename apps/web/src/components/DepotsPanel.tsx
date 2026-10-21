import { useState } from 'react';
import type { Dir, DepotView, Heading } from '@ccfleet/protocol';
import { api } from '../lib/api';
import { useFleet } from '../lib/store';
import { HEADING_SHORT } from '../lib/status';

const DIR_LABEL: Record<Dir, string> = { front: 'in front', up: 'above', down: 'below' };

export function DepotsPanel() {
  const depotMap = useFleet((s) => s.depots);
  const depots = Object.values(depotMap);
  const turtles = useFleet((s) => s.turtles);
  const centerOn = useFleet((s) => s.centerOn);
  const [editing, setEditing] = useState<DepotView | 'new' | undefined>();

  if (editing) return <DepotForm depot={editing === 'new' ? undefined : editing} onDone={() => setEditing(undefined)} />;

  return (
    <div className="space-y-3 p-3 text-xs">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-dim">Depots</h3>
        <button onClick={() => setEditing('new')} className="rounded bg-cyan-700/40 px-2 py-0.5 text-cyan-200 hover:bg-cyan-600/50">
          + New depot
        </button>
      </div>
      {depots.length === 0 && (
        <p className="text-slate-500">
          A depot is where turtles unload: a dock cell to stand in, a chest next to it, and optionally a fuel chest. Park a turtle on the dock facing the right way, select it, then “New depot”.
        </p>
      )}
      {depots.map((d) => (
        <div key={d.id} className="rounded border border-edge bg-panel-2 p-2">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{d.name}</span>
            <span className="text-dim">
              {d.world} · {d.dimension.replace('minecraft:', '')}
            </span>
            {d.lockedBy && <span className="ml-auto rounded bg-violet-900/60 px-1 text-[10px] text-violet-200">dock in use: {turtles[d.lockedBy]?.name ?? d.lockedBy}</span>}
          </div>
          <div className="num mt-1 text-dim">
            dock {d.dock.x} {d.dock.y} {d.dock.z} facing {HEADING_SHORT[d.dockHeading]} · unload chest {DIR_LABEL[d.unloadDir]}
            {d.fuelDir ? ` · fuel chest ${DIR_LABEL[d.fuelDir]}` : ' · no fuel chest'}
            {` · ${d.waiting.length} waiting spot(s)`}
          </div>
          <div className="mt-1 flex gap-2">
            <button className="text-cyan-300 hover:underline" onClick={() => centerOn(d.dock.x, d.dock.z, d.dock.y)}>
              Show
            </button>
            <button className="text-cyan-300 hover:underline" onClick={() => setEditing(d)}>
              Edit
            </button>
            <button
              className="text-red-400 hover:underline"
              onClick={async () => {
                if (!confirm(`Delete depot "${d.name}"?`)) return;
                try {
                  await api.deleteDepot(d.id);
                } catch (e) {
                  useFleet.getState().toast('error', (e as Error).message);
                }
              }}
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function DepotForm({ depot, onDone }: { depot?: DepotView; onDone: () => void }) {
  const focus = useFleet((s) => (s.focusId ? s.turtles[s.focusId] : undefined));
  const [v, setV] = useState(() => ({
    name: depot?.name ?? 'Home',
    world: depot?.world ?? focus?.world ?? useFleet.getState().world,
    dimension: depot?.dimension ?? focus?.dimension ?? 'minecraft:overworld',
    x: String(depot?.dock.x ?? ''),
    y: String(depot?.dock.y ?? ''),
    z: String(depot?.dock.z ?? ''),
    heading: String(depot?.dockHeading ?? 0),
    unloadDir: (depot?.unloadDir ?? 'front') as Dir,
    fuelDir: (depot?.fuelDir ?? '') as Dir | '',
  }));
  const [spots, setSpots] = useState(depot?.waiting ?? []);
  const [err, setErr] = useState<string>();
  const useTurtle = () => {
    const p = focus?.state?.pose;
    if (!focus || !p?.pos) return setErr('Select a turtle with a known position first.');
    setV({ ...v, world: focus.world, dimension: focus.dimension, x: String(p.pos.x), y: String(p.pos.y), z: String(p.pos.z), heading: String(p.heading ?? 0) });
  };
  const save = async () => {
    setErr(undefined);
    const nums = [v.x, v.y, v.z].map((s) => Number(s));
    if (nums.some((n) => !Number.isInteger(n))) return setErr('Dock coordinates must be whole numbers.');
    try {
      await api.saveDepot(
        {
          name: v.name,
          world: v.world,
          dimension: v.dimension,
          dock: { x: nums[0], y: nums[1], z: nums[2] },
          dockHeading: Number(v.heading) as Heading,
          unloadDir: v.unloadDir,
          fuelDir: v.fuelDir || undefined,
          waiting: spots,
        },
        depot?.id,
      );
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="space-y-2 p-3 text-xs">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-dim">{depot ? 'Edit depot' : 'New depot'}</h3>
      <Field label="Name">
        <input value={v.name} maxLength={40} onChange={(e) => setV({ ...v, name: e.target.value })} className="inp" />
      </Field>
      <button onClick={useTurtle} disabled={!focus} className="w-full rounded border border-cyan-800 bg-cyan-950/50 py-1 text-cyan-200 hover:bg-cyan-900/50 disabled:opacity-40">
        Use {focus ? focus.name : 'the selected turtle'}: its position and facing as the dock
      </button>
      <div className="grid grid-cols-4 gap-1">
        {(['x', 'y', 'z'] as const).map((k) => (
          <Field key={k} label={k.toUpperCase()}>
            <input value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} className="inp num" />
          </Field>
        ))}
        <Field label="Facing">
          <select value={v.heading} onChange={(e) => setV({ ...v, heading: e.target.value })} className="inp">
            <option value="0">N</option>
            <option value="1">E</option>
            <option value="2">S</option>
            <option value="3">W</option>
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-1">
        <Field label="Unload chest is">
          <select value={v.unloadDir} onChange={(e) => setV({ ...v, unloadDir: e.target.value as Dir })} className="inp">
            <option value="front">in front</option>
            <option value="up">above</option>
            <option value="down">below</option>
          </select>
        </Field>
        <Field label="Fuel chest is">
          <select value={v.fuelDir} onChange={(e) => setV({ ...v, fuelDir: e.target.value as Dir | '' })} className="inp">
            <option value="">none</option>
            <option value="front">in front</option>
            <option value="up">above</option>
            <option value="down">below</option>
          </select>
        </Field>
      </div>
      <div className="rounded border border-edge bg-panel-2 p-2 text-[11px] text-dim">
        <b className="text-ink">Physical setup.</b> Leave the dock cell empty; the turtle parks there. Put a chest {DIR_LABEL[v.unloadDir]} it
        {v.unloadDir === 'front' ? ' (in the direction of “Facing”)' : ''}. A fuel chest, if any, goes on another side; keep only fuel in it (coal, charcoal…). The turtle never drops items unless the block there is an inventory.
      </div>
      <div className="rounded border border-edge bg-panel-2 p-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-dim">Waiting spots</span>
          <button
            disabled={!focus?.state?.pose.pos}
            onClick={() => {
              const p = focus?.state?.pose.pos;
              if (p && !spots.some((s) => s.x === p.x && s.y === p.y && s.z === p.z)) setSpots([...spots, { ...p }]);
            }}
            className="text-[11px] text-cyan-300 hover:underline disabled:text-slate-600 disabled:no-underline"
          >
            + {focus ? `${focus.name}'s position` : 'selected turtle'}
          </button>
        </div>
        {spots.length === 0 ? (
          <p className="mt-1 text-[11px] text-dim">
            Optional. When the dock is busy, turtles wait on a free spot instead of where they are. Pick open cells near the dock that are off the main path (an alcove is ideal).
          </p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {spots.map((s, i) => (
              <li key={i} className="num flex justify-between">
                <span>
                  {s.x} {s.y} {s.z}
                </span>
                <button className="text-red-400 hover:underline" onClick={() => setSpots(spots.filter((_, j) => j !== i))}>
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Field label="World / dimension">
        <div className="flex gap-1">
          <input value={v.world} onChange={(e) => setV({ ...v, world: e.target.value })} className="inp" />
          <select value={v.dimension} onChange={(e) => setV({ ...v, dimension: e.target.value })} className="inp">
            <option value="minecraft:overworld">Overworld</option>
            <option value="minecraft:the_nether">Nether</option>
            <option value="minecraft:the_end">End</option>
          </select>
        </div>
      </Field>
      {err && <p className="text-red-300">{err}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onDone} className="px-2 py-1 text-dim hover:text-ink">
          Cancel
        </button>
        <button onClick={save} className="rounded bg-cyan-600 px-3 py-1 font-semibold text-slate-950 hover:bg-cyan-500">
          Save depot
        </button>
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-[10px] uppercase tracking-wide text-dim [&_.inp]:w-full [&_.inp]:rounded [&_.inp]:border [&_.inp]:border-edge [&_.inp]:bg-panel [&_.inp]:px-1.5 [&_.inp]:py-0.5 [&_.inp]:text-xs [&_.inp]:normal-case [&_.inp]:tracking-normal [&_.inp]:text-ink">
      {label}
      <div className="mt-0.5">{children}</div>
    </label>
  );
}
