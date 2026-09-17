/** Version-checked incremental realtime frames — verbatim port of FE's
 *  src/api/graphPatch.ts (M3-QA-5 / RT-PIN-3 / RT-PIN-4):
 *  eventId guard FIRST; stale dropped; exactly-sequential merges; gaps refetch.
 *  Admin frames (no siteId) full-replace; site/focus frames upsert, never delete.
 *  graph.remove tombstone is the only incremental deletion path. */
import type {
  DependencyEdge, GraphPatchFrame, GraphRemoveFrame, GraphSnapshot, ResourceNode, TaskNode,
} from '../../contracts/contracts.v1';

export type { GraphPatchFrame, GraphRemoveFrame };
export type PatchAction = 'drop' | 'merge' | 'refetch';

export function isFrameForEvent(graphEventId: string, frame: { eventId: string }): boolean {
  return frame.eventId === graphEventId;
}

export function decidePatchAction(lastVersion: number | null, frameVersion: number): PatchAction {
  if (lastVersion == null) return 'refetch';
  if (frameVersion <= lastVersion) return 'drop';
  if (frameVersion === lastVersion + 1) return 'merge';
  return 'refetch';
}

function upsertById<T extends { id: string }>(base: T[], patch: T[]): T[] {
  const map = new Map(base.map((x) => [x.id, x]));
  for (const p of patch) map.set(p.id, p);
  return [...map.values()];
}

export function mergeGraphPatch(graph: GraphSnapshot, frame: GraphPatchFrame, fullReplace: boolean): GraphSnapshot {
  if (fullReplace) {
    return {
      ...graph,
      event: { ...graph.event, version: frame.version },
      tasks: frame.tasks,
      dependencies: frame.dependencies,
      resources: frame.resources,
    };
  }
  return {
    ...graph,
    event: { ...graph.event, version: frame.version },
    tasks: upsertById(graph.tasks, frame.tasks),
    dependencies: upsertById(graph.dependencies, frame.dependencies),
    resources: upsertById(graph.resources, frame.resources),
  };
}

export function applyGraphRemove(graph: GraphSnapshot, frame: GraphRemoveFrame): GraphSnapshot {
  const removed = new Set(frame.taskIds);
  const tasks = graph.tasks.filter((t) => !removed.has(t.id));
  const dependencies = graph.dependencies.filter((d) => !removed.has(d.fromTaskId) && !removed.has(d.toTaskId));
  const referenced = new Set(tasks.flatMap((t) => t.assigneeResourceIds));
  const resources = graph.resources.filter((r) => referenced.has(r.id));
  return { ...graph, event: { ...graph.event, version: frame.version }, tasks, dependencies, resources };
}