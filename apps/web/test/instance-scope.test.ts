import { beforeEach, describe, expect, it } from 'vitest';
import type { DepotView, JobView, TurtleView } from '@ccfleet/protocol';
import { apply, useFleet } from '../src/lib/store';

const turtle = (id: string, world: string) => ({ id, name: id, world, dimension: 'minecraft:overworld', connection: 'online' }) as unknown as TurtleView;
const job = (id: string, world: string) => ({ id, world, dimension: 'minecraft:overworld', status: 'running' }) as unknown as JobView;
const depot = (id: string, world: string) => ({ id, world, dimension: 'minecraft:overworld' }) as unknown as DepotView;

beforeEach(() => {
  useFleet.setState({ world: 'A', allTurtles: {}, turtles: {}, allJobs: {}, jobs: {}, allDepots: {}, depots: {}, selection: [], focusId: undefined });
  apply({
    type: 'init',
    turtles: [turtle('a1', 'A'), turtle('a2', 'A'), turtle('b1', 'B')],
    groups: [{ id: 'g', name: 'Mixed', color: '#fff', memberIds: ['a1', 'b1'] }],
    batches: [],
    events: [],
    jobs: [job('ja', 'A'), job('jb', 'B')],
    depots: [depot('da', 'A'), depot('db', 'B')],
    forcedChunks: [],
  });
});

describe('instance scope', () => {
  it('shows only the turtles, jobs and depots of the instance shown', () => {
    const s = useFleet.getState();
    expect(Object.keys(s.turtles).sort()).toEqual(['a1', 'a2']);
    expect(Object.keys(s.jobs)).toEqual(['ja']);
    expect(Object.keys(s.depots)).toEqual(['da']);
    expect(Object.keys(s.allTurtles)).toHaveLength(3);
  });

  it('never selects turtles of another instance (a group can hold both)', () => {
    useFleet.getState().select(['a1', 'b1']);
    expect(useFleet.getState().selection).toEqual(['a1']);
    useFleet.getState().select(['b1'], 'add');
    expect(useFleet.getState().selection).toEqual(['a1']);
  });

  it('switching instance swaps everything and drops the selection', () => {
    useFleet.getState().select(['a1']);
    useFleet.getState().setInstance('B');
    const s = useFleet.getState();
    expect(Object.keys(s.turtles)).toEqual(['b1']);
    expect(Object.keys(s.jobs)).toEqual(['jb']);
    expect(Object.keys(s.depots)).toEqual(['db']);
    expect(s.selection).toEqual([]);
  });

  it('updates from another instance leave the shown maps untouched (no re-render)', () => {
    const before = useFleet.getState();
    apply({ type: 'turtle', turtle: { ...turtle('b1', 'B'), name: 'moved' } });
    apply({ type: 'job', job: { ...job('jb', 'B'), status: 'paused' } as JobView });
    const after = useFleet.getState();
    expect(after.turtles).toBe(before.turtles);
    expect(after.jobs).toBe(before.jobs);
    expect(after.depots).toBe(before.depots);
    expect(after.allTurtles.b1.name).toBe('moved');
    // A new turtle paired into the shown instance appears.
    apply({ type: 'turtle', turtle: turtle('a3', 'A') });
    expect(Object.keys(useFleet.getState().turtles).sort()).toEqual(['a1', 'a2', 'a3']);
  });
});
