import { useState } from 'react';
import { api } from '../lib/api';
import { useFleet } from '../lib/store';

export function EnrollDialog({ onClose }: { onClose: () => void }) {
  const groups = useFleet((s) => s.groups);
  const [name, setName] = useState('');
  const [world, setWorld] = useState('main');
  const [dimension, setDimension] = useState('minecraft:overworld');
  const [groupId, setGroupId] = useState('');
  const [result, setResult] = useState<{ code: string; expiresAt: number; publicUrl: string }>();
  const [error, setError] = useState<string>();

  const create = async () => {
    setError(undefined);
    try {
      setResult(await api.enroll({ name: name || undefined, world, dimension, groupId: groupId || undefined }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-edge bg-panel p-4 text-sm shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 text-base font-semibold">Add a turtle</h2>
        {!result ? (
          <div className="space-y-2">
            <p className="text-xs text-dim">Creates a one-time pairing code (valid 15 minutes). The turtle trades it for its own permanent credentials.</p>
            <Field label="Name (optional)">
              <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="e.g. Miner 1" className="input" />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="World">
                <input value={world} maxLength={40} onChange={(e) => setWorld(e.target.value)} className="input" />
              </Field>
              <Field label="Dimension">
                <select value={dimension} onChange={(e) => setDimension(e.target.value)} className="input">
                  <option value="minecraft:overworld">Overworld</option>
                  <option value="minecraft:the_nether">Nether</option>
                  <option value="minecraft:the_end">The End</option>
                </select>
              </Field>
            </div>
            <p className="text-[11px] text-dim">Turtles cannot detect which world or dimension they are in, so you set it here. Map data is stored per world and dimension.</p>
            <Field label="Group (optional)">
              <select value={groupId} onChange={(e) => setGroupId(e.target.value)} className="input">
                <option value="">None</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </Field>
            {error && <p className="text-xs text-red-300">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={onClose} className="rounded px-3 py-1 text-dim hover:text-ink">
                Cancel
              </button>
              <button onClick={create} className="rounded bg-cyan-600 px-3 py-1 font-semibold text-slate-950 hover:bg-cyan-500">
                Create pairing code
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded border border-cyan-800 bg-cyan-950/40 p-3 text-center">
              <div className="text-[11px] uppercase tracking-wider text-cyan-300">Pairing code</div>
              <div className="num text-3xl font-bold tracking-[0.2em] text-white">{result.code}</div>
              <div className="text-[11px] text-dim">single use · expires {new Date(result.expiresAt).toLocaleTimeString()}</div>
            </div>
            <div className="text-xs text-dim">
              On the turtle (a mining turtle: equip a diamond pickaxe), run:
              <pre className="num mt-1 overflow-x-auto rounded bg-black/50 p-2 text-[11px] text-slate-200 select-all">
                wget {result.publicUrl}/turtle/install.lua install.lua{'\n'}install {result.code}
              </pre>
              <ul className="mt-2 list-disc space-y-0.5 pl-4">
                <li>The installer asks for the turtle's coordinates and facing. Enter them, or press Enter and calibrate here later.</li>
                <li>
                  If it says the domain is not permitted, add the http allow rule from <span className="num">docs/minecraft-setup.md</span>.
                </li>
                <li>Codes work once. For the simulator, <span className="num">npm run sim</span> makes its own.</li>
              </ul>
            </div>
            <div className="flex justify-end">
              <button onClick={onClose} className="rounded bg-panel-2 px-3 py-1 hover:bg-slate-700">
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-[11px] text-dim">
      {label}
      <div className="mt-0.5 text-sm text-ink [&_.input]:w-full [&_.input]:rounded [&_.input]:border [&_.input]:border-edge [&_.input]:bg-panel-2 [&_.input]:px-2 [&_.input]:py-1">{children}</div>
    </label>
  );
}
