import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Heading, MapBlock, Vec3 } from '@ccfleet/protocol';
import { api } from '../lib/api';
import { mapCache, runBatch, useFleet } from '../lib/store';
import { shortItem, statusOf } from '../lib/status';

type Item = { label: string; hint?: string; danger?: boolean; disabled?: boolean; run?: () => void } | 'sep' | { title: string };

const fmt = (c: Vec3) => `${c.x} ${c.y} ${c.z}`;

/** The right-click menu of the 2D and 3D map. */
export function MapContextMenu() {
  const menu = useFleet((s) => s.contextMenu);
  const turtles = useFleet((s) => s.turtles);
  const selection = useFleet((s) => s.selection);
  const focusId = useFleet((s) => s.focusId);
  const forcedChunks = useFleet((s) => s.forcedChunks);
  const world = useFleet((s) => s.world);
  const dimension = useFleet((s) => s.dimension);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  const close = () => useFleet.getState().setContextMenu(undefined);

  // Close on Escape, a click elsewhere, or when the window loses focus.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ left: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4)) });
  }, [menu]);

  if (!menu) return null;
  const st = useFleet.getState();
  const toastErr = (e: unknown) => st.toast('error', (e as Error).message);
  const items: Item[] = [];

  // ---- a turtle
  const t = menu.turtleId ? turtles[menu.turtleId] : undefined;
  if (t) {
    items.push({ title: `${t.name} · ${statusOf(t)}` });
    const selected = selection.includes(t.id);
    items.push({ label: 'Select only this turtle', run: () => (st.select([t.id], 'replace'), st.focus(t.id)) });
    items.push(selected ? { label: 'Remove from selection', run: () => st.select([t.id], 'toggle') } : { label: 'Add to selection', run: () => st.select([t.id], 'add') });
    items.push({ label: 'Details', run: () => (st.select([t.id], 'replace'), st.focus(t.id), st.setRightTab('turtle')) });
    items.push({ label: 'Jobs', run: () => (st.select([t.id], 'replace'), st.focus(t.id), st.setRightTab('jobs')) });
    items.push('sep');
    items.push({ label: 'Pause', hint: 'after the current action', run: () => runBatch(api.stop({ turtleIds: [t.id] }, 'pause')) });
    items.push({ label: 'Resume', run: () => runBatch(api.resume({ turtleIds: [t.id] })) });
    items.push({ label: 'Cancel queued commands', run: () => runBatch(api.cancel({ turtleIds: [t.id] })) });
    items.push({ label: 'Emergency stop', danger: true, run: () => runBatch(api.stop({ turtleIds: [t.id] }, 'estop')) });
  }

  // ---- a place
  const cell = menu.cell;
  const block = menu.block;
  const where = block ?? cell;
  if (where) {
    if (t) items.push('sep');
    const known: MapBlock | undefined = 'cell' in where ? (where as MapBlock) : mapCache.layer(where.y)?.get(`${where.x},${where.z}`);
    items.push({ title: `${fmt(where)}${known ? ` · ${known.block ? shortItem(known.block) : 'known empty'}` : ' · unknown'}` });

    // Send turtles here: the selected ones (else the focused one), not the one right-clicked.
    const senders = (selection.length ? selection : focusId ? [focusId] : []).map((id) => turtles[id]).filter((x) => x && x.id !== t?.id && x.world === world && x.dimension === dimension);
    if (!cell) items.push({ label: 'Send a turtle here', hint: 'no open space here', disabled: true });
    else if (!senders.length) items.push({ label: 'Send a turtle here', hint: 'select a turtle first', disabled: true });
    else
      for (const s of senders.slice(0, 4))
        items.push({
          label: `Send ${s.name} here`,
          hint: fmt(cell),
          run: () =>
            api
              .goto(s.id, cell)
              .then(() => st.toast('info', `${s.name}: going to ${fmt(cell)}`))
              .catch(toastErr),
        });
    if (senders.length > 4) items.push({ label: `…and ${senders.length - 4} more selected`, disabled: true });

    const origin = block ?? cell!;
    const heading = senders[0]?.state?.pose.heading ?? (focusId ? turtles[focusId]?.state?.pose.heading : undefined);
    items.push({
      label: 'New job starting here…',
      hint: fmt(origin),
      run: () => {
        // From a turtle's menu with nothing selected: the job is for that turtle.
        if (t && !selection.length) {
          st.select([t.id], 'replace');
          st.focus(t.id);
        }
        st.newJobAt({ x: origin.x, y: origin.y, z: origin.z }, (heading ?? t?.state?.pose.heading) as Heading | undefined);
      },
    });
    items.push({
      label: 'Copy coordinates',
      hint: fmt(where),
      run: () =>
        navigator.clipboard
          .writeText(fmt(where))
          .then(() => st.toast('info', `Copied ${fmt(where)}`))
          .catch(toastErr),
    });
    const cx = Math.floor(where.x / 16);
    const cz = Math.floor(where.z / 16);
    const forced = forcedChunks.some((c) => c.world === world && c.dimension === dimension && c.cx === cx && c.cz === cz);
    items.push({
      label: forced ? 'Unmark chunk as force-loaded' : 'Mark chunk as force-loaded',
      hint: `chunk ${cx}, ${cz}`,
      run: () => api.setForcedChunk({ world, dimension, cx, cz, forced: !forced }).catch(toastErr),
    });
    items.push(
      menu.view === '2d'
        ? { label: 'Show in 3D', run: () => (st.centerOn(where.x, where.z, where.y), st.setMapMode('3d')) }
        : { label: 'Show in 2D', run: () => (st.setFollowY(false), st.centerOn(where.x, where.z, where.y), st.setMapMode('2d')) },
    );
  }

  if (!items.length) return null;
  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-56 rounded-md border border-edge bg-panel py-1 text-xs shadow-xl shadow-black/60"
      style={{ left: pos.left || menu.x, top: pos.top || menu.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => {
        if (it === 'sep') return <div key={i} className="my-1 border-t border-edge" />;
        if ('title' in it)
          return (
            <div key={i} className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-dim">
              {it.title}
            </div>
          );
        return (
          <button
            key={i}
            disabled={it.disabled}
            onClick={() => {
              close();
              it.run?.();
            }}
            className={`flex w-full items-baseline justify-between gap-4 px-3 py-1 text-left disabled:cursor-default disabled:text-slate-600 ${it.danger ? 'text-red-300 hover:bg-red-950/60' : 'text-ink hover:bg-cyan-950/60'} disabled:hover:bg-transparent`}
          >
            <span>{it.label}</span>
            {it.hint && <span className="font-mono text-[10px] text-dim">{it.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}
