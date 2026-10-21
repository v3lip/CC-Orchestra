import { useEffect, useMemo, useState } from 'react';
import type { InstanceView } from '@ccfleet/protocol';
import { api } from '../lib/api';
import { useFleet } from '../lib/store';

const DIMENSIONS = ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'];

const ago = (t?: number) => {
  if (!t) return 'never';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/** Header: which instance (Minecraft world/server) and dimension the dashboard shows. */
export function InstancePicker() {
  const instances = useFleet((s) => s.instances);
  const setInstances = useFleet((s) => s.setInstances);
  const setInstance = useFleet((s) => s.setInstance);
  const world = useFleet((s) => s.world);
  const dimension = useFleet((s) => s.dimension);
  const setWorld = useFleet((s) => s.setWorld);
  const turtles = useFleet((s) => s.turtles);
  const toast = useFleet((s) => s.toast);
  const [managing, setManaging] = useState(false);

  useEffect(() => {
    api.instances().then(setInstances, () => {});
  }, [setInstances]);

  const names = useMemo(() => [...new Set([world, ...instances.map((i) => i.name)])].sort((a, b) => a.localeCompare(b)), [instances, world]);
  const dims = useMemo(() => [...new Set([dimension, ...DIMENSIONS, ...Object.values(turtles).filter((t) => t.world === world).map((t) => t.dimension)])], [turtles, world, dimension]);

  const create = async () => {
    const name = prompt('Name of the new instance (e.g. the server or save name):')?.trim();
    if (!name) return;
    try {
      setInstances(await api.createInstance(name));
      setInstance(name);
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  return (
    <div className="flex items-center gap-1">
      <select
        value={world}
        onChange={(e) => {
          if (e.target.value === '+new') return void create();
          if (e.target.value === '+manage') return setManaging(true);
          setInstance(e.target.value);
        }}
        className="rounded border border-edge bg-panel-2 px-1 py-0.5 text-xs"
        title="Instance: one per Minecraft world or server. The fleet list, map, jobs and depots show this one; new turtles are paired into it."
      >
        {names.map((n) => {
          const i = instances.find((x) => x.name === n);
          return (
            <option key={n} value={n}>
              {n === 'sim' ? 'sim (simulated)' : n}
              {i ? ` · ${i.online}/${i.turtles} online` : ''}
            </option>
          );
        })}
        <option value="+new">＋ New instance…</option>
        <option value="+manage">Manage instances…</option>
      </select>
      <select value={dimension} onChange={(e) => setWorld(world, e.target.value)} className="rounded border border-edge bg-panel-2 px-1 py-0.5 text-xs" title="Dimension shown on the map">
        {dims.map((d) => (
          <option key={d} value={d}>
            {d.replace('minecraft:', '').replace('the_', '')}
          </option>
        ))}
      </select>
      {managing && <InstancesDialog onClose={() => setManaging(false)} />}
    </div>
  );
}

function InstancesDialog({ onClose }: { onClose: () => void }) {
  const instances = useFleet((s) => s.instances);
  const setInstances = useFleet((s) => s.setInstances);
  const setInstance = useFleet((s) => s.setInstance);
  const world = useFleet((s) => s.world);
  const [err, setErr] = useState<string>();
  const run = async (p: Promise<InstanceView[]>) => {
    try {
      setInstances(await p);
      setErr(undefined);
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    }
  };
  const rename = async (i: InstanceView) => {
    const to = prompt(`Rename "${i.name}" to:`, i.name)?.trim();
    if (!to || to === i.name) return;
    if ((await run(api.renameInstance(i.name, to))) && world === i.name) setInstance(to);
  };
  const remove = async (i: InstanceView) => {
    if (!confirm(`Delete instance "${i.name}" and everything in it?\n\n${i.turtles} turtle(s) will be unpaired (run "install" with a new code to use them again), plus ${i.mapBlocks.toLocaleString()} map blocks, ${i.jobs} job(s) and ${i.depots} depot(s).\n\nThis cannot be undone.`)) return;
    await run(api.deleteInstance(i.name));
  };
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60" onClick={onClose}>
      <div className="w-[34rem] max-w-[95vw] rounded-lg border border-edge bg-panel p-4 text-xs shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Instances</h2>
          <button onClick={onClose} className="text-dim hover:text-ink">
            ✕
          </button>
        </div>
        <p className="mb-2 text-[11px] text-dim">One per Minecraft world or server. Turtles of every instance stay connected; the dashboard shows one at a time. Pair turtles from another save into their own instance so their map and jobs don't mix with this one.</p>
        {err && <p className="mb-2 rounded border border-red-800 bg-red-950/40 p-1.5 text-red-200">{err}</p>}
        <table className="w-full">
          <thead className="text-left text-[10px] uppercase tracking-wide text-dim">
            <tr>
              <th className="py-1">Instance</th>
              <th>Turtles</th>
              <th>Map</th>
              <th>Jobs</th>
              <th>Last seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {instances.map((i) => (
              <tr key={i.name} className={`border-t border-edge ${i.name === world ? 'text-cyan-200' : ''}`}>
                <td className="py-1.5">
                  <button onClick={() => (setInstance(i.name), onClose())} className="hover:underline" title="Show this instance">
                    {i.name}
                  </button>
                </td>
                <td className="font-mono">
                  {i.online}/{i.turtles}
                </td>
                <td className="font-mono">{i.mapBlocks.toLocaleString()}</td>
                <td className="font-mono">
                  {i.jobs} · {i.depots} depot{i.depots === 1 ? '' : 's'}
                </td>
                <td className="text-dim">{ago(i.lastSeen)}</td>
                <td className="text-right">
                  <button onClick={() => rename(i)} className="mr-2 text-dim hover:text-ink">
                    Rename
                  </button>
                  <button onClick={() => remove(i)} className="text-red-300 hover:text-red-200">
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
