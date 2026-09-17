import { describe, expect, it } from 'vitest';
import type { DependencyEdge } from '../../contracts/contake-core-contracts.v1.1';
import { CycleError, assertAcyclic, topoSort, transitiveDependents, wouldCreateCycle } from '../graph/dag';

const edge = (id: string, from: string, to: string): DependencyEdge =>
  ({ id, kind: 'depends_on', fromTaskId: from, toTaskId: to, lagMin: 0, hard: true });

describe('dependency DAG', () => {
  it('rejects self-dependency', () => {
    expect(wouldCreateCycle([], 'a', 'a')).toBe(true);
  });
  it('rejects a 2-cycle', () => {
    const deps = [edge('e1', 'b', 'a')]; // b depends on a
    expect(wouldCreateCycle(deps, 'a', 'b')).toBe(true); // a depends on b would close the loop
    expect(wouldCreateCycle(deps, 'c', 'b')).toBe(false);
  });
  it('rejects an N-cycle and names members in Hebrew', () => {
    const deps = [edge('e1', 'b', 'a'), edge('e2', 'c', 'b'), edge('e3', 'd', 'c')];
    expect(wouldCreateCycle(deps, 'a', 'd')).toBe(true);
    expect(() => assertAcyclic([...deps, edge('e4', 'a', 'd')], id => `משימה-${id}`)).toThrowError(CycleError);
    try {
      assertAcyclic([...deps, edge('e4', 'a', 'd')], id => `משימה-${id}`);
      expect.unreachable();
    } catch (e) {
      const err = e as CycleError;
      expect(err.messageHe).toContain('קשר תלות מעגלי אסור');
      expect(err.cycleIds.length).toBeGreaterThanOrEqual(2);
    }
  });
  it('topoSort is predecessors-first and deterministic (start, then id)', () => {
    const deps = [edge('e1', 'b', 'a'), edge('e2', 'c', 'a')];
    const starts: Record<string, number> = { a: 300, b: 100, c: 200 };
    const order1 = topoSort(['c', 'b', 'a'], deps, id => starts[id] ?? 0);
    const order2 = topoSort(['a', 'b', 'c'], deps, id => starts[id] ?? 0);
    expect(order1).toEqual(['a', 'b', 'c']);
    expect(order2).toEqual(['a', 'b', 'c']);
  });
  it('transitiveDependents returns the full downstream set', () => {
    const deps = [edge('e1', 'b', 'a'), edge('e2', 'c', 'b'), edge('e3', 'd', 'a')];
    expect([...transitiveDependents(deps, 'a')].sort()).toEqual(['b', 'c', 'd']);
    expect([...transitiveDependents(deps, 'c')]).toEqual([]);
  });
});
