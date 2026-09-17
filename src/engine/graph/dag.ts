import type { DependencyEdge, ID } from '../../contracts/contake-core-contracts.v1.1';

/** Hebrew-named cycle error, per QA AC-GRAPH-1: any path that would create a
 *  cycle is rejected naming the cycle members. */
export class CycleError extends Error {
  readonly code = 'DEPENDENCY_CYCLE' as const;
  constructor(
    readonly cycleIds: ID[],
    readonly messageHe: string,
  ) {
    super(messageHe);
    this.name = 'CycleError';
  }
}

/** Edge direction in contracts.v1: fromTaskId = successor, toTaskId = predecessor (FS + lag). */

const dependsOnTargets = (deps: DependencyEdge[], taskId: ID): ID[] =>
  deps.filter(e => e.fromTaskId === taskId).map(e => e.toTaskId);

/** Tasks that directly depend on taskId (its successors). */
export const dependentsOf = (deps: DependencyEdge[], taskId: ID): ID[] =>
  deps.filter(e => e.toTaskId === taskId).map(e => e.fromTaskId);

/** Transitive successors of taskId (everything downstream), excluding itself. */
export function transitiveDependents(deps: DependencyEdge[], taskId: ID): Set<ID> {
  const seen = new Set<ID>();
  const stack: ID[] = [taskId];
  while (stack.length) {
    const cur = stack.pop() as ID;
    for (const next of dependentsOf(deps, cur)) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  seen.delete(taskId);
  return seen;
}

/** Would adding "successor depends on predecessor" close a loop?
 *  True iff predecessor is already reachable from successor via depends-on steps. */
export function wouldCreateCycle(deps: DependencyEdge[], successor: ID, predecessor: ID): boolean {
  if (successor === predecessor) return true;
  // The new edge is "successor depends on predecessor". It closes a loop iff the
  // predecessor already depends on the successor through existing depends-on steps.
  const seen = new Set<ID>();
  const stack: ID[] = [predecessor];
  while (stack.length) {
    const cur = stack.pop() as ID;
    if (cur === successor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of dependsOnTargets(deps, cur)) stack.push(next);
  }
  return false;
}

/** The dependency path between two tasks if one exists (for Hebrew error naming). */
export function dependencyPath(deps: DependencyEdge[], from: ID, to: ID): ID[] | null {
  const queue: ID[][] = [[from]];
  const seen = new Set<ID>([from]);
  while (queue.length) {
    const path = queue.shift() as ID[];
    const cur = path[path.length - 1] as ID;
    if (cur === to) return path;
    for (const next of dependsOnTargets(deps, cur)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push([...path, next]);
      }
    }
  }
  return null;
}

/** Throws CycleError naming members (Hebrew) if the edge set contains a cycle. */
export function assertAcyclic(deps: DependencyEdge[], nameOf?: (id: ID) => string): void {
  for (const e of deps) {
    if (wouldCreateCycle(deps.filter(d => d !== e), e.fromTaskId, e.toTaskId)) {
      const cycle = dependencyPath(deps, e.toTaskId, e.fromTaskId) ?? [e.fromTaskId, e.toTaskId];
      const names = cycle.map(id => (nameOf ? nameOf(id) : id));
      throw new CycleError(cycle, `קשר תלות מעגלי אסור: ${names.join(' ← ')}`);
    }
  }
}

/** Kahn topological order, predecessors first. Deterministic: ties broken by
 *  (startMs, id) per the domino spec. Throws CycleError on cyclic input. */
export function topoSort(
  taskIds: ID[],
  deps: DependencyEdge[],
  startMsOf: (id: ID) => number,
  nameOf?: (id: ID) => string,
): ID[] {
  assertAcyclic(deps, nameOf);
  const nodes = new Set(taskIds);
  const indeg = new Map<ID, number>();
  for (const id of taskIds) indeg.set(id, 0);
  for (const e of deps) {
    if (nodes.has(e.fromTaskId) && nodes.has(e.toTaskId)) {
      indeg.set(e.fromTaskId, (indeg.get(e.fromTaskId) ?? 0) + 1);
    }
  }
  const byStartThenId = (a: ID, b: ID): number => {
    const d = startMsOf(a) - startMsOf(b);
    return d !== 0 ? d : a.localeCompare(b);
  };
  const ready = taskIds.filter(id => (indeg.get(id) ?? 0) === 0).sort(byStartThenId);
  const order: ID[] = [];
  while (ready.length) {
    const cur = ready.shift() as ID;
    order.push(cur);
    for (const succ of dependentsOf(deps, cur).filter(s => nodes.has(s))) {
      const d = (indeg.get(succ) ?? 1) - 1;
      indeg.set(succ, d);
      if (d === 0) {
        ready.push(succ);
        ready.sort(byStartThenId);
      }
    }
  }
  return order;
}
