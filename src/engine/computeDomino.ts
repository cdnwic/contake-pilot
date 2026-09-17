import type {
  Conflict, DominoResult, DomainProfile, GraphSnapshot, ID, Impact, ImpactClass,
  ProposedChange, TaskNode,
} from '../contracts/contracts.v1';
import { topoSort } from './graph/dag';
import { hhmmToMin, parseInstant, renderInstant, wallMinutes } from './time';

/**
 * computeDomino — pure, deterministic, synchronous (contracts v1.1, domino spec v1.1).
 * No clock, no randomness: identical input -> byte-identical output.
 *
 * Pinned semantics:
 * - Locks (D1, corpus-pinned): a locked task that would have to move emits one
 *   LOCK_VIOLATION and stays. Its DIRECT dependents keep their times, appear in
 *   blockedTaskIds (never in movedTasks), and produce no notifications — whether
 *   or not they could still be satisfied against the lock's violated position.
 *   Tasks further downstream compute normally against unchanged times.
 * - maxShiftMin: a non-trigger task whose required shift exceeds the profile limit
 *   is not moved: MAX_SHIFT_EXCEEDED + blockedTaskIds; it anchors its chain the
 *   same way a lock does (direct dependents blocked).
 * - The trigger of task.move always takes the requested position.
 * - Conflicts consolidate to at most ONE entry per code (sorted id unions) — the
 *   QA golden corpus asserts exact code sets. `blocking` false only for
 *   WINDOW_VIOLATION; ok === false iff any blocking conflict exists.
 * - Capacity (QA D2): RESERVED, not enforced in Alpha.
 */

const CLASS_ORDER: Record<ImpactClass, number> = { S0: 0, S1: 1, S2: 2, S3: 3 };

interface WorkTask {
  node: TaskNode;
  startMs: number | null;
  originalStartMs: number | null;
  endMs: number | null;
}

const zeroResult = (conflicts: Conflict[] = []): DominoResult => ({
  ok: !conflicts.some(c => c.blocking),
  movedTasks: [],
  blockedTaskIds: [],
  impacts: [],
  conflicts,
  maxImpactClass: 'S0',
  summaryHe: 'אין אפקט דומינו: רק המשימה עצמה משתנה',
});

export function computeDomino(
  graph: GraphSnapshot,
  change: ProposedChange,
  profile: DomainProfile,
): DominoResult {
  const tz = graph.event.timezone;

  const tasksById = new Map<ID, WorkTask>();
  for (const t of [...graph.tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    const startMs = t.start === null ? null : parseInstant(t.start);
    tasksById.set(t.id, {
      node: { ...t, assigneeResourceIds: [...t.assigneeResourceIds] },
      startMs,
      originalStartMs: startMs,
      endMs: startMs === null ? null : startMs + t.durationMin * 60000,
    });
  }
  const nameOf = (id: ID): string => tasksById.get(id)?.node.name ?? id;
  const resourcesById = new Map([...graph.resources].map(r => [r.id, r] as const));

  const conflicts: Conflict[] = [];
  const pushConflict = (code: Conflict['code'], blocking: boolean, taskIds: ID[], resourceIds: ID[], messageHe: string): void => {
    const existing = conflicts.find(c => c.code === code);
    if (existing) {
      existing.taskIds = [...new Set([...existing.taskIds, ...taskIds])].sort();
      existing.resourceIds = [...new Set([...existing.resourceIds, ...resourceIds])].sort();
      if (!existing.messageHe.includes(messageHe)) existing.messageHe = `${existing.messageHe} ${messageHe}`;
    } else {
      conflicts.push({ code, blocking, taskIds: [...taskIds].sort(), resourceIds: [...resourceIds].sort(), messageHe });
    }
  };

  // ---- Scheduling-neutral variants (v1.1 C1): validated, no cascade. --------
  switch (change.type) {
    case 'event.create':
    case 'event.update':
    case 'event.publish':
    case 'resource.create':
    case 'resource.update':
    case 'resource.delete':
    case 'dependency.create':
    case 'dependency.delete':
    case 'constraint.lock':
    case 'constraint.unlock':
    case 'domino.apply':
      return zeroResult();
    default:
      break;
  }

  const deps = graph.dependencies.filter(
    e => tasksById.has(e.fromTaskId) && tasksById.has(e.toTaskId),
  );

  // task.create has no pre-existing trigger task; all other scheduling variants do.
  const triggerTaskId: ID | null = change.type === 'task.create' ? null : change.taskId;
  if (triggerTaskId !== null && !tasksById.has(triggerTaskId)) throw new Error(`unknown task: ${triggerTaskId}`);

  // ---- 2. Apply trigger on the working snapshot ------------------------------
  const cancelled = new Set<ID>();
  const touched = new Set<ID>(); // trigger tasks included in booking checks + impacts
  let triggerMove: { taskId: ID; beforeMs: number | null; afterMs: number } | null = null;
  switch (change.type) {
    case 'task.move': {
      const w = tasksById.get(change.taskId)!;
      // QA-M1-1 (Sev-1): a LOCKED trigger is refused for every role — unlock-first
      // is the only path, and unlock is matrix-gated. No trigger exemption.
      if (w.node.locked) {
        pushConflict('LOCK_VIOLATION', true, [change.taskId], [], `המשימה "${w.node.name}" נעולה — שחרר נעילה לפני הזזה.`);
        break;
      }
      w.startMs = parseInstant(change.newStart);
      w.endMs = w.startMs + w.node.durationMin * 60000;
      touched.add(change.taskId);
      // The trigger is always part of the proposal (corpus: movedTasks includes it).
      triggerMove = { taskId: change.taskId, beforeMs: w.originalStartMs, afterMs: w.startMs };
      break;
    }
    case 'task.update': {
      const w = tasksById.get(change.taskId)!;
      if (change.patch.name !== undefined) w.node = { ...w.node, name: change.patch.name };
      if (change.patch.durationMin !== undefined) {
        w.node = { ...w.node, durationMin: change.patch.durationMin };
        if (w.startMs !== null) w.endMs = w.startMs + w.node.durationMin * 60000;
      }
      if (change.patch.status !== undefined) {
        w.node = { ...w.node, status: change.patch.status };
        if (change.patch.status === 'cancelled') cancelled.add(change.taskId);
      }
      touched.add(change.taskId);
      break;
    }
    case 'task.assign': {
      const w = tasksById.get(change.taskId)!;
      w.node = { ...w.node, assigneeResourceIds: [...change.assigneeResourceIds] };
      touched.add(change.taskId);
      break;
    }
    case 'task.create': {
      const t = change.task;
      const startMs = t.start === null ? null : parseInstant(t.start);
      tasksById.set('__new__', {
        node: { ...t, id: '__new__', version: 0 },
        startMs,
        originalStartMs: startMs,
        endMs: startMs === null ? null : startMs + t.durationMin * 60000,
      });
      touched.add('__new__');
      break;
    }
    case 'task.delete': {
      tasksById.delete(change.taskId);
      break;
    }
  }

  const activeDeps = deps.filter(
    e => !cancelled.has(e.fromTaskId) && !cancelled.has(e.toTaskId)
      && tasksById.has(e.fromTaskId) && tasksById.has(e.toTaskId),
  );

  // ---- 3. Topo-sort -----------------------------------------------------------
  const order = topoSort(
    [...tasksById.keys()],
    activeDeps,
    id => tasksById.get(id)?.startMs ?? Number.MAX_SAFE_INTEGER,
    nameOf,
  );

  // ---- 4-5. Propagate; locks / max-shift / blocked anchor their chains --------
  const moved = new Map<ID, { beforeMs: number | null; afterMs: number }>();
  const anchors = new Set<ID>();          // lock-conflicted / max-shift-stopped tasks
  const blocked = new Set<ID>();          // direct dependents of anchors (QA D1, corpus-pinned)
  const maxShiftMin = profile.rules.maxShiftMin;

  const markDependentsBlocked = (anchorId: ID): void => {
    for (const e of activeDeps.filter(d => d.toTaskId === anchorId)) {
      if (!anchors.has(e.fromTaskId)) blocked.add(e.fromTaskId);
    }
  };

  for (const id of order) {
    const w = tasksById.get(id)!;
    if (w.startMs === null || cancelled.has(id)) continue;
    if (anchors.has(id) || blocked.has(id)) continue; // keep current times, no notify
    let requiredMs = w.startMs;
    for (const e of activeDeps.filter(d => d.fromTaskId === id)) {
      const pred = tasksById.get(e.toTaskId);
      if (!pred || pred.endMs === null) continue;
      requiredMs = Math.max(requiredMs, pred.endMs + e.lagMin * 60000);
    }
    if (requiredMs <= w.startMs) continue; // satisfiable as-is: neither moved nor blocked

    const isTriggerMove = change.type === 'task.move' && id === change.taskId;
    if (w.node.locked) {
      pushConflict('LOCK_VIOLATION', true, [id], [], `המשימה "${w.node.name}" נעולה ולא יכולה לזוז.`);
      anchors.add(id);
      markDependentsBlocked(id);
      continue;
    }
    const shiftMin = (requiredMs - (w.originalStartMs ?? requiredMs)) / 60000;
    if (!isTriggerMove && maxShiftMin !== undefined && shiftMin > maxShiftMin) {
      pushConflict('MAX_SHIFT_EXCEEDED', true, [id], [], `המשימה "${w.node.name}" צריכה לזוז ${Math.round(shiftMin)} דקות, מעבר למותר (${maxShiftMin}).`);
      blocked.add(id);
      anchors.add(id);
      markDependentsBlocked(id);
      continue;
    }
    moved.set(id, { beforeMs: w.originalStartMs ?? w.startMs, afterMs: requiredMs });
    w.startMs = requiredMs;
    w.endMs = requiredMs + w.node.durationMin * 60000;
  }
  const blockedTaskIds: ID[] = [...blocked].sort();
  if (triggerMove !== null) {
    const cur = moved.get(triggerMove.taskId);
    moved.set(triggerMove.taskId, {
      beforeMs: triggerMove.beforeMs,
      afterMs: cur?.afterMs ?? triggerMove.afterMs,
    });
  }

  // ---- 6. Exclusive-resource double booking (moved/touched pairs only) -------
  {
    const involved = new Set([...moved.keys(), ...touched]);
    const entries = [...tasksById.values()].filter(w => w.startMs !== null && !cancelled.has(w.node.id));
    for (const res of [...resourcesById.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!res.exclusive) continue;
      const users = entries.filter(w => w.node.assigneeResourceIds.includes(res.id));
      let hit: ID[] | null = null;
      for (let i = 0; i < users.length && !hit; i++) {
        for (let j = i + 1; j < users.length; j++) {
          const a = users[i]!;
          const b = users[j]!;
          if (!involved.has(a.node.id) && !involved.has(b.node.id)) continue;
          if ((a.startMs as number) < (b.endMs as number) && (b.startMs as number) < (a.endMs as number)) {
            hit = [a.node.id, b.node.id];
            break;
          }
        }
      }
      if (hit) pushConflict('DOUBLE_BOOKING', true, hit, [res.id], `המשאב "${res.name}" משובץ לשתי משימות חופפות.`);
    }
  }

  // ---- Working-window warnings on moved tasks (non-blocking) -----------------
  if (profile.rules.workingWindow) {
    const { startHHMM, endHHMM } = profile.rules.workingWindow;
    const wStart = hhmmToMin(startHHMM);
    const wEnd = hhmmToMin(endHHMM);
    for (const [id, m] of moved) {
      const w = tasksById.get(id)!;
      // QA-M1-2: instant comparison with date rollover — an end past midnight
      // counts as > wEnd (23:30+120min must warn), not a small wall-clock number.
      const startWall = wallMinutes(m.afterMs, tz);
      const endWall = startWall + w.node.durationMin;
      if (startWall < wStart || endWall > wEnd) {
        pushConflict('WINDOW_VIOLATION', false, [id], [], `המשימה "${w.node.name}" מחוץ לחלון העבודה ${startHHMM}-${endHHMM}.`);
      }
    }
  }

  // ---- 7. Impacts + classification -------------------------------------------
  const triggerSiteId = (triggerTaskId !== null ? tasksById.get(triggerTaskId)?.node.siteId : tasksById.get('__new__')?.node.siteId) ?? graph.event.siteIds[0];
  const movedSorted = [...moved.entries()].sort((a, b) => {
    const d = a[1].afterMs - b[1].afterMs;
    return d !== 0 ? d : a[0].localeCompare(b[0]);
  });
  const movedCountBySite = new Map<ID, number>();
  for (const [id] of movedSorted) {
    const site = tasksById.get(id)!.node.siteId;
    movedCountBySite.set(site, (movedCountBySite.get(site) ?? 0) + 1);
  }
  const exclusiveSharedAcrossSites = (resourceIds: ID[]): boolean =>
    resourceIds.some(rid => {
      const r = resourcesById.get(rid);
      if (!r?.exclusive) return false;
      const sites = new Set(
        [...tasksById.values()]
          .filter(w => w.node.assigneeResourceIds.includes(rid))
          .map(w => w.node.siteId),
      );
      return sites.size > 1;
    });

  const impacts: Impact[] = [];
  let maxImpactClass: ImpactClass = 'S0';
  const bump = (c: ImpactClass): void => {
    if (CLASS_ORDER[c] > CLASS_ORDER[maxImpactClass]) maxImpactClass = c;
  };
  const classify = (w: WorkTask, assignees: ID[], groups: ID[]): ImpactClass => {
    const hasExternal = groups.some(g => (resourcesById.get(g)?.subscriberChannelIds?.length ?? 0) > 0);
    if (hasExternal) return 'S3';
    if (w.node.siteId !== triggerSiteId || exclusiveSharedAcrossSites(assignees)) return 'S2';
    return (movedCountBySite.get(w.node.siteId) ?? 0) > 1 ? 'S1' : 'S0';
  };
  for (const [id, m] of movedSorted) {
    const w = tasksById.get(id)!;
    const assignees = [...w.node.assigneeResourceIds].sort();
    const groups = assignees.filter(rid => resourcesById.get(rid)?.resourceKind === 'group');
    const klass = classify(w, assignees, groups);
    bump(klass);
    impacts.push({
      taskId: id,
      beforeStart: m.beforeMs === null ? null : renderInstant(m.beforeMs, tz),
      afterStart: renderInstant(m.afterMs, tz),
      affectedResourceIds: assignees,
      affectedGroupIds: groups,
      impactClass: klass,
    });
  }
  // Cancellations surface as impacts with afterStart null (notification targeting).
  for (const id of [...cancelled].sort()) {
    const w = tasksById.get(id);
    if (!w || w.originalStartMs === null) continue;
    const assignees = [...w.node.assigneeResourceIds].sort();
    const groups = assignees.filter(rid => resourcesById.get(rid)?.resourceKind === 'group');
    const klass = classify(w, assignees, groups);
    bump(klass);
    impacts.push({
      taskId: id,
      beforeStart: renderInstant(w.originalStartMs, tz),
      afterStart: null,
      affectedResourceIds: assignees,
      affectedGroupIds: groups,
      impactClass: klass,
    });
  }

  // ---- 8. Summary (PINNED: N = dependents only, trigger excluded) -------------
  const dependents = movedSorted.filter(([id]) => id !== triggerTaskId);
  const summaryHe = dependents.length === 0
    ? 'אין אפקט דומינו: רק המשימה עצמה משתנה'
    : `אפקט דומינו: ${dependents.length} משימות תלויות יזוזו (${nameOf(dependents[0]![0])})`;

  return {
    ok: !conflicts.some(c => c.blocking),
    movedTasks: movedSorted.map(([id, m]) => ({
      taskId: id,
      beforeStart: m.beforeMs === null ? null : renderInstant(m.beforeMs, tz),
      afterStart: renderInstant(m.afterMs, tz),
    })),
    blockedTaskIds: blockedTaskIds.sort(),
    impacts: impacts.sort((a, b) => a.taskId.localeCompare(b.taskId)),
    conflicts: conflicts.sort((a, b) => a.code.localeCompare(b.code)),
    maxImpactClass,
    summaryHe,
  };
}
