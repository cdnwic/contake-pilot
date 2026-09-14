import type {
  Action, AuditEntityType, ChangeRequest, DomainProfile, DominoResult, GraphSnapshot, ID, ImpactClass,
  Principal, ProposedChange, TaskNode,
} from '@contake/core';
import { computeDomino, effectiveDecision, getProfile, inScope, rawDecision, reportAutoApplies } from '@contake/core';
import type { GraphRepository } from '../repo/graph-repository.js';
import { audit, deviceClassOf, type DenialMeta } from './audit.js';
import { buildApprovalNeededJob, buildJobsForAppliedChange, buildReassignmentJobs, recordJobs } from './notify.js';

/** Monotonic per-process segment for direct-apply idempotency keys (ND-3 Sev-2). */
let directSeq = 0;
import { appEvents } from './events.js';

/**
 * The ImpactHook decision point (architecture §5.3): every graph mutation flows
 * through here. Base cell -> scope check -> compute impact -> autoEscalation ->
 * apply atomically OR freeze a ChangeRequest. Server-side only (QA AC-RBAC-3).
 */

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly messageHe: string,
    /** contracts v1.9: set only on mutating-endpoint authz denials. */
    readonly denial?: DenialMeta,
  ) {
    super(messageHe);
  }
}

/** v1.9: would-be audit target of a denied mutation (entity may not exist yet -
 *  creates carry the 'pending' sentinel). */
function denialTarget(change: ProposedChange): { entityType: AuditEntityType; entityId: ID } {
  switch (change.type) {
    case 'event.create':
    case 'event.update':
    case 'event.publish':
      return { entityType: 'event', entityId: 'eventId' in change ? change.eventId : 'pending' };
    case 'task.create':
      return { entityType: 'task', entityId: 'pending' };
    case 'task.update':
    case 'task.move':
    case 'task.assign':
    case 'task.delete':
    case 'constraint.lock':
    case 'constraint.unlock':
      return { entityType: 'task', entityId: change.taskId };
    case 'resource.create':
      return { entityType: 'resource', entityId: 'pending' };
    case 'resource.update':
    case 'resource.delete':
      return { entityType: 'resource', entityId: change.resourceId };
    case 'dependency.create':
      return { entityType: 'dependency', entityId: 'pending' };
    case 'dependency.delete':
      return { entityType: 'dependency', entityId: change.dependencyId };
    case 'domino.apply':
      return { entityType: 'change_request', entityId: change.changeRequestId };
  }
}

let seq = 0;
const newId = (p: string): ID => `${p}_${Date.now().toString(36)}_${(seq += 1)}`;

/** Actions whose change carries scheduling semantics (engine computes a real cascade). */
const SCHEDULING = new Set(['task.update', 'task.move', 'task.assign', 'task.create', 'task.delete']);

export interface MutationOutcome {
  applied?: { domino: DominoResult };
  changeRequest?: ChangeRequest;
  /** Blocking conflicts: nothing applies, nobody is notified; human resolution first. */
  blockedPreview?: DominoResult;
}

function taskSite(snapshot: GraphSnapshot, change: ProposedChange): string | undefined {
  const taskId = 'taskId' in change ? change.taskId : undefined;
  if (taskId) return snapshot.tasks.find(t => t.id === taskId)?.siteId;
  if (change.type === 'task.create') return change.task.siteId;
  return snapshot.event.siteIds[0];
}

export function reasonFor(impactClass: ImpactClass, base: string, profile?: DomainProfile): string {
  // Stage 1: S3 names the profile's external stakeholders when the registry
  // provides a label (e.g. לקוחות); generic text remains the fallback.
  const s3 = profile?.rules.externalStakeholderLabel ? `השפעה על ${profile.rules.externalStakeholderLabel}` : 'השפעה על בעלי עניין חיצוניים';
  const classes: Record<ImpactClass, string> = {
    S0: 'השפעה מקומית', S1: 'השפעה על כל האתר', S2: 'השפעה חוצת אתרים', S3: s3,
  };
  return `${classes[impactClass]} — נדרש אישור מנהל-על (${base})`;
}

export async function proposeMutation(
  repo: GraphRepository,
  principal: Principal & { orgId: ID; name: string },
  action: Action,
  change: ProposedChange,
  eventId: ID,
  userAgent?: string,
): Promise<MutationOutcome> {
  const deviceClass = deviceClassOf(userAgent);
  const base = rawDecision(action, principal.role);
  if (base === 'deny') {
    // contracts v1.9: centralized matrix-deny path -> standalone denied audit row
    throw new ApiError(403, 'FORBIDDEN', 'אין לך הרשאה לפעולה זו', {
      reason: 'matrix_deny', action, ...denialTarget(change), eventId,
    });
  }

  const snapshot = await repo.snapshot(eventId);
  if (!snapshot || snapshot.event.orgId !== principal.orgId) {
    throw new ApiError(404, 'NOT_FOUND', 'האירוע לא נמצא');
  }
  const profile = getProfile(snapshot.event.domainProfileId);
  const site = taskSite(snapshot, change);

  // ScopeHook: 'scope' cells apply only inside the principal's sites; a cross-scope
  // attempt becomes a pending ChangeRequest, graph untouched (QA AC-RBAC-7).
  const scopedIn = base !== 'scope' || inScope(principal.scopes, eventId, site);

  const domino = SCHEDULING.has(action)
    ? computeDomino(snapshot, change, profile)
    : computeDomino(snapshot, change, profile); // zero-move result for neutral variants
  const impactClass = domino.maxImpactClass;

  const effective = scopedIn ? effectiveDecision(action, principal.role, impactClass) : 'propose';

  if (effective === 'propose') {
    if (!domino.ok) {
      // A blocking proposal is surfaced for human resolution but applies nothing.
      return { blockedPreview: domino };
    }
    const cr: ChangeRequest = {
      id: newId('cr'),
      eventId,
      proposedBy: principal.userId,
      role: principal.role,
      baseGraphVersion: snapshot.event.version,
      change,
      dominoResult: domino,
      state: 'pending_review',
      reasonHe: reasonFor(impactClass, action, profile),
      createdAt: new Date().toISOString(),
    };
    await withAuditSafety(repo, async () => {
      await repo.createChangeRequest(cr);
      await audit(repo, {
        orgId: principal.orgId, eventId, actorUserId: principal.userId, role: principal.role,
        action, entityType: 'change_request', entityId: cr.id, after: cr, deviceClass,
      });
    });
    appEvents.emit({ type: 'change.pending', changeRequest: cr });
    await recordJobs(repo, [await buildApprovalNeededJob({ repo, event: snapshot.event, profile, changeRequestId: cr.id, summaryHe: domino.summaryHe })]);
    return { changeRequest: cr };
  }

  // allow/scope: apply atomically (QA-M2-6: audit-write failure aborts and rolls back)
  const created: { id?: ID } = {};
  await withAuditSafety(repo, async () => {
    if (SCHEDULING.has(action)) {
      await applyDomino(repo, snapshot, domino, change, principal, action, deviceClass, undefined, created);
    } else {
      await applyNeutral(repo, snapshot, change, principal, action, deviceClass, undefined, created);
    }
  });
  // QA-M2-8: create mutations return the created entity id, not only domino metadata
  return { applied: { domino, ...(created.id ? { createdId: created.id } : {}) } };
}


/** QA-M2-4: a failed audit write (or any mid-mutation error) fails the mutation
 *  LOUDLY and rolls the repository back — never a half-applied graph with a 5xx. */
export async function withAuditSafety<T>(repo: GraphRepository, fn: () => T | Promise<T>): Promise<T> {
  if (repo.runInTx) return repo.runInTx(async () => fn());
  const cp = await repo.checkpoint?.();
  try {
    const out = await fn();
    if (cp !== undefined) await repo.commit?.(cp);
    return out;
  } catch (e) {
    if (cp !== undefined) await repo.restore?.(cp);
    throw e;
  }
}

/** Applies a computed (ok) domino atomically with optimistic concurrency,
 *  bumps the event version, writes audit + targeted notification jobs. */
export async function applyDomino(
  repo: GraphRepository,
  snapshot: GraphSnapshot,
  domino: DominoResult,
  change: ProposedChange,
  principal: Principal & { orgId: ID },
  action: Action,
  deviceClass?: string,
  changeRequestId?: ID,
  createdOut?: { id?: ID },
): Promise<void> {
  if (!domino.ok) throw new ApiError(409, 'BLOCKING_CONFLICT', 'ההצעה חסומה — נדרש פתרון ידני לפני החלה');

  const updates: { id: ID; expectedVersion: number; patch: Partial<TaskNode> }[] = [];
  const befores = new Map<ID, TaskNode>();
  for (const m of domino.movedTasks) {
    const cur = snapshot.tasks.find(t => t.id === m.taskId);
    if (!cur) throw new ApiError(409, 'STALE', 'הגרף השתנה מאז החישוב — יש לחשב מחדש');
    befores.set(m.taskId, cur);
    updates.push({ id: m.taskId, expectedVersion: cur.version, patch: { start: m.afterStart, status: 'delayed' } });
  }
  if (change.type === 'task.update' && change.patch.status === 'cancelled') {
    const cur = snapshot.tasks.find(t => t.id === change.taskId);
    if (!cur) throw new ApiError(404, 'NOT_FOUND', 'המשימה לא נמצאה');
    befores.set(change.taskId, cur);
    updates.push({ id: change.taskId, expectedVersion: cur.version, patch: { status: 'cancelled' } });
  }
  if (change.type === 'task.assign') {
    const cur = snapshot.tasks.find(t => t.id === change.taskId);
    if (!cur) throw new ApiError(404, 'NOT_FOUND', 'המשימה לא נמצאה');
    befores.set(change.taskId, cur);
    updates.push({ id: change.taskId, expectedVersion: cur.version, patch: { assigneeResourceIds: change.assigneeResourceIds } });
  }
  if (change.type === 'task.update' && (change.patch.name !== undefined || change.patch.durationMin !== undefined)) {
    const cur = snapshot.tasks.find(t => t.id === change.taskId);
    if (cur && !updates.some(u => u.id === cur.id)) {
      befores.set(change.taskId, cur);
      updates.push({ id: change.taskId, expectedVersion: cur.version, patch: change.patch });
    }
  }
  const deleteId = change.type === 'task.delete' ? change.taskId : null;
  if (deleteId !== null) {
    const cur = snapshot.tasks.find(t => t.id === deleteId);
    if (cur) befores.set(deleteId, cur);
  }
  let createdTaskId: ID | null = null;
  if (change.type === 'task.create') {
    const task: TaskNode = { ...change.task, id: newId('task'), version: 1 };
    createdTaskId = task.id;
    if (createdOut) createdOut.id = task.id;
    await repo.createTask(task);
    await audit(repo, {
      orgId: principal.orgId, eventId: snapshot.event.id, actorUserId: principal.userId, role: principal.role,
      action, entityType: 'task', entityId: task.id, after: task,
      ...(changeRequestId ? { changeRequestId } : {}), ...(deviceClass ? { deviceClass } : {}),
    });
  }

  if (!await repo.applyTaskUpdates(updates)) {
    throw new ApiError(409, 'VERSION_CONFLICT', 'הגרף השתנה במקביל — רענן ונסה שוב');
  }
  if (deleteId !== null) {
    // hard delete (allowed only pre-publish or with zero subscribers — QA-M1-3 gate at the API)
    await repo.deleteTask(deleteId);
  }
  if (!await repo.bumpEventVersion(snapshot.event.id, snapshot.event.version)) {
    throw new ApiError(409, 'VERSION_CONFLICT', 'הגרף השתנה במקביל — רענן ונסה שוב');
  }
  for (const u of updates) {
    await audit(repo, {
      orgId: principal.orgId, eventId: snapshot.event.id, actorUserId: principal.userId, role: principal.role,
      action, entityType: 'task', entityId: u.id,
      before: befores.get(u.id), after: await repo.getTask(u.id),
      ...(changeRequestId ? { changeRequestId } : {}), ...(deviceClass ? { deviceClass } : {}),
    });
  }

  if (deleteId !== null) {
    await audit(repo, {
      orgId: principal.orgId, eventId: snapshot.event.id, actorUserId: principal.userId, role: principal.role,
      action, entityType: 'task', entityId: deleteId,
      before: befores.get(deleteId), after: { deleted: true },
      ...(changeRequestId ? { changeRequestId } : {}), ...(deviceClass ? { deviceClass } : {}),
    });
  }

  const changedTaskIds: ID[] = [
    ...domino.movedTasks.map(m => m.taskId),
    ...updates.map(u => u.id),
    ...(deleteId !== null ? [deleteId] : []),
    ...(createdTaskId !== null ? [createdTaskId] : []),
    ...(change.type === 'task.assign' || change.type === 'task.update' ? [change.taskId] : []),
  ].filter((v, i, a) => a.indexOf(v) === i);

  // RT-PIN-4: tombstones for removals (unassign / site transfer / delete), emitted
  // BEFORE the upsert patch so every room sees a consistent per-version sequence.
  // Status-cancelled is NOT a removal — only assignee loss, site change, or delete.
  {
    const usersByResource = new Map<ID, ID[]>();
    for (const u of await repo.listUsers(snapshot.event.orgId)) {
      if (u.linkedResourceId) usersByResource.set(u.linkedResourceId, [...(usersByResource.get(u.linkedResourceId) ?? []), u.userId]);
    }
    const removedTaskIds: ID[] = [];
    const removedFor = new Set<ID>();
    let tombstoneSiteId: ID | undefined;
    if (deleteId !== null) {
      const before = befores.get(deleteId);
      removedTaskIds.push(deleteId);
      tombstoneSiteId = before?.siteId;
      for (const rid of before?.assigneeResourceIds ?? []) {
        for (const uid of usersByResource.get(rid) ?? []) removedFor.add(uid);
      }
    }
    for (const u of updates) {
      const before = befores.get(u.id);
      if (!before) continue;
      if (u.patch.assigneeResourceIds) {
        const afterSet = new Set(u.patch.assigneeResourceIds);
        const lost = before.assigneeResourceIds.filter(rid => !afterSet.has(rid));
        if (lost.length > 0) {
          removedTaskIds.push(u.id);
          for (const rid of lost) for (const uid of usersByResource.get(rid) ?? []) removedFor.add(uid);
        }
      }
      if (u.patch.siteId !== undefined && u.patch.siteId !== before.siteId) {
        // site transfer (future contract addition): old site room loses the task
        removedTaskIds.push(u.id);
        tombstoneSiteId = before.siteId;
      }
    }
    const uniqueRemoved = removedTaskIds.filter((v, i, a) => a.indexOf(v) === i);
    if (uniqueRemoved.length > 0) {
      appEvents.emit({
        type: 'graph.removed', eventId: snapshot.event.id, orgId: snapshot.event.orgId,
        version: (await repo.getEvent(snapshot.event.id))?.version ?? snapshot.event.version + 1,
        taskIds: uniqueRemoved,
        ...(tombstoneSiteId ? { siteId: tombstoneSiteId } : {}),
        removedForUserIds: [...removedFor],
      });
    }
  }

  appEvents.emit({ type: 'graph.applied', eventId: snapshot.event.id, changedTaskIds });
  // Targeted notifications — only now, post-apply (QA AC-NOT-5).
  const fresh = await repo.snapshot(snapshot.event.id);
  if (fresh) {
    const profile = getProfile(fresh.event.domainProfileId);
    // ND-3 Sev-2: the direct-apply key segment must be unique PER MUTATION —
    // Date.now() alone has millisecond resolution and two rapid admin applies
    // could collide, collapsing jobs through recordJobs dedupe. Counter makes
    // collisions impossible while keeping the eventId+changeRequestId+kind shape.
    const directChangeId = changeRequestId ?? `direct-${Date.now().toString(36)}-${(directSeq += 1)}`;
    await await recordJobs(repo, await buildJobsForAppliedChange({
      repo, snapshot: fresh, domino, profile,
      changeRequestId: directChangeId,
      changeSummaryHe: domino.summaryHe,
    }));
    // Reassignment fanout (contracts v1.3): person-level added/removed only.
    if (change.type === 'task.assign') {
      const before = befores.get(change.taskId);
      if (before) {
        const personIds = new Set(fresh.resources.filter(r => r.resourceKind === 'person').map(r => r.id));
        const oldSet = new Set(before.assigneeResourceIds.filter(id => personIds.has(id)));
        const newSet = new Set(change.assigneeResourceIds.filter(id => personIds.has(id)));
        await recordJobs(repo, await buildReassignmentJobs({
          repo, snapshot: fresh, profile,
          changeRequestId: directChangeId,
          taskId: change.taskId,
          addedPersonIds: [...newSet].filter(id => !oldSet.has(id)).sort(),
          removedPersonIds: [...oldSet].filter(id => !newSet.has(id)).sort(),
        }));
      }
    }
  }
}

/** Approve (admin): validate state + staleness, apply atomically, resolve. */
export async function approveChange(
  repo: GraphRepository,
  principal: Principal & { orgId: ID },
  changeRequestId: ID,
  userAgent?: string,
): Promise<{ changeRequest: ChangeRequest; createdId?: ID }> {
  if (rawDecision('change.approve', principal.role) !== 'allow') {
    throw new ApiError(403, 'FORBIDDEN', 'רק מנהל-על יכול לאשר שינויים', {
      reason: 'matrix_deny', action: 'change.approve', entityType: 'change_request',
      entityId: changeRequestId, eventId: 'pending',
    });
  }
  const cr = await repo.getChangeRequest(changeRequestId);
  if (!cr) throw new ApiError(404, 'NOT_FOUND', 'בקשת השינוי לא נמצאה');
  if (cr.state === 'approved') throw new ApiError(409, 'ALREADY_RESOLVED', 'הבקשה כבר אושרה');
  if (cr.state === 'rejected') throw new ApiError(409, 'ALREADY_RESOLVED', 'הבקשה נדחתה — לא ניתן לאשר דחייה');
  // event.create proposals have no graph yet (eventId='pending'): approval creates the
  // event and re-points the CR to the real id (M1 review Sev-2).
  if (cr.change.type === 'event.create') {
    const event = { ...cr.change.event, id: newId('evt'), version: 1 };
    const resolved = await withAuditSafety(repo, async () => {
      await repo.createEvent(event);
      const r = await repo.updateChangeRequest(cr.id, {
        state: 'approved', resolvedBy: principal.userId, resolvedAt: new Date().toISOString(), eventId: event.id,
      }) as ChangeRequest;
      await audit(repo, {
        orgId: principal.orgId, eventId: event.id, actorUserId: principal.userId, role: principal.role,
        action: 'event.create', entityType: 'event', entityId: event.id, after: event,
        changeRequestId: cr.id, deviceClass: deviceClassOf(userAgent),
      });
      await audit(repo, {
        orgId: principal.orgId, eventId: event.id, actorUserId: principal.userId, role: principal.role,
        action: 'change.approve', entityType: 'change_request', entityId: cr.id, before: cr, after: r,
        changeRequestId: cr.id, deviceClass: deviceClassOf(userAgent),
      });
      return r;
    });
    appEvents.emit({ type: 'change.resolved', changeRequest: resolved });
    return { changeRequest: resolved, createdId: event.id };
  }
  const snapshot = await repo.snapshot(cr.eventId);
  if (!snapshot) throw new ApiError(404, 'NOT_FOUND', 'האירוע לא נמצא');
  if (snapshot.event.version !== cr.baseGraphVersion) {
    throw new ApiError(409, 'STALE_BASE', 'בסיס הגרף השתנה מאז ההצעה — יש להציע מחדש');
  }
  // QA-M2-6: apply + CR resolve + audit are one atomic unit
  const applied = await applyChangeRequest(repo, snapshot, cr, principal, deviceClassOf(userAgent));
  const resolved = await withAuditSafety(repo, async () => {
    const r = await repo.updateChangeRequest(cr.id, {
      state: 'approved', resolvedBy: principal.userId, resolvedAt: new Date().toISOString(),
    }) as ChangeRequest;
    await audit(repo, {
      orgId: principal.orgId, eventId: cr.eventId, actorUserId: principal.userId, role: principal.role,
      action: 'change.approve', entityType: 'change_request', entityId: cr.id, before: cr, after: r,
      changeRequestId: cr.id, deviceClass: deviceClassOf(userAgent),
    });
    return r;
  });
  appEvents.emit({ type: 'change.resolved', changeRequest: resolved });
  return { changeRequest: resolved, ...(applied.createdId ? { createdId: applied.createdId } : {}) };
}

export async function rejectChange(
  repo: GraphRepository,
  principal: Principal & { orgId: ID },
  changeRequestId: ID,
  reasonHe?: string,
  userAgent?: string,
): Promise<ChangeRequest> {
  if (rawDecision('change.reject', principal.role) !== 'allow') {
    throw new ApiError(403, 'FORBIDDEN', 'רק מנהל-על יכול לדחות שינויים', {
      reason: 'matrix_deny', action: 'change.reject', entityType: 'change_request',
      entityId: changeRequestId, eventId: 'pending',
    });
  }
  const cr = await repo.getChangeRequest(changeRequestId);
  if (!cr) throw new ApiError(404, 'NOT_FOUND', 'בקשת השינוי לא נמצאה');
  if (cr.state !== 'pending_review') throw new ApiError(409, 'ALREADY_RESOLVED', 'הבקשה כבר טופלה');
  const resolved = await repo.updateChangeRequest(cr.id, {
    state: 'rejected', resolvedBy: principal.userId, resolvedAt: new Date().toISOString(),
    rejectionReasonHe: reasonHe ?? null,
  }) as ChangeRequest;
  appEvents.emit({ type: 'change.resolved', changeRequest: resolved });
  await audit(repo, {
    orgId: principal.orgId, eventId: cr.eventId, actorUserId: principal.userId, role: principal.role,
    action: 'change.reject', entityType: 'change_request', entityId: cr.id,
    before: cr, after: { ...resolved, rejectionReasonHe: reasonHe ?? null },
    changeRequestId: cr.id, deviceClass: deviceClassOf(userAgent),
  });
  return resolved;
}

/** reportApplyRule enforcement for delay reports (matrix v1.1 C2). */
export function reportDecisionFor(
  principal: Principal,
  task: TaskNode,
  domino: DominoResult,
): 'auto-apply' | 'pending_review' | 'deny' {
  const isOwn = principal.linkedResourceId !== undefined && task.assigneeResourceIds.includes(principal.linkedResourceId);
  if (principal.role === 'focus_worker' && !isOwn) return 'deny';
  if (reportAutoApplies({ isOwnTask: isOwn, impactClass: domino.maxImpactClass, taskLocked: task.locked })) {
    return 'auto-apply';
  }
  return 'pending_review';
}

/** Applies a scheduling-neutral ProposedChange (v1.1 C1 variants) with audit. */
export async function applyNeutral(
  repo: GraphRepository,
  snapshot: GraphSnapshot,
  change: ProposedChange,
  principal: Principal & { orgId: ID },
  action: Action,
  deviceClass?: string,
  changeRequestId?: ID,
  createdOut?: { id?: ID },
): Promise<ID[]> {
  const orgId = principal.orgId;
  const eventId = snapshot.event.id;
  const auditBase = { orgId, eventId, actorUserId: principal.userId, role: principal.role, action };
  const bump = async (): Promise<void> => {
    const cur = await repo.getEvent(eventId);
    if (cur) await repo.bumpEventVersion(eventId, cur.version);
  };
  switch (change.type) {
    case 'event.update': {
      const before = await repo.getEvent(eventId);
      const after = await repo.updateEvent(eventId, change.patch);
      await audit(repo, { ...auditBase, entityType: 'event', entityId: eventId, before, after, ...(changeRequestId ? { changeRequestId } : {}), ...(deviceClass ? { deviceClass } : {}) });
      return [];
    }
    case 'event.publish': {
      const before = await repo.getEvent(eventId);
      const after = await repo.updateEvent(eventId, { status: 'published' });
      await audit(repo, { ...auditBase, entityType: 'event', entityId: eventId, before, after, ...(changeRequestId ? { changeRequestId } : {}), ...(deviceClass ? { deviceClass } : {}) });
      return [];
    }
    case 'resource.create': {
      const resource = { ...change.resource, id: newId('res'), version: 1 };
      if (createdOut) createdOut.id = resource.id;
      await repo.createResource(resource);
      await bump();
      await audit(repo, { ...auditBase, entityType: 'resource', entityId: resource.id, after: resource, ...(changeRequestId ? { changeRequestId } : {}), ...(deviceClass ? { deviceClass } : {}) });
      return [];
    }
    case 'resource.update': {
      const before = await repo.getResource(change.resourceId);
      const after = await repo.updateResource(change.resourceId, change.patch);
      await bump();
      await audit(repo, { ...auditBase, entityType: 'resource', entityId: change.resourceId, before, after, ...(changeRequestId ? { changeRequestId } : {}), ...(deviceClass ? { deviceClass } : {}) });
      return [];
    }
    case 'resource.delete': {
      const before = await repo.getResource(change.resourceId);
      const usedBy = snapshot.tasks.filter(t => t.assigneeResourceIds.includes(change.resourceId) && t.status !== 'cancelled');
      if (usedBy.length > 0) {
        throw new ApiError(409, 'RESOURCE_IN_USE', `לא ניתן למחוק — המשאב משובץ ל: ${usedBy.map(t => t.name).join(', ')}`);
      }
      await repo.updateResource(change.resourceId, { name: `${before?.name ?? change.resourceId} (נמחק)` });
      await bump();
      await audit(repo, { ...auditBase, entityType: 'resource', entityId: change.resourceId, before, after: { deleted: true }, ...(changeRequestId ? { changeRequestId } : {}), ...(deviceClass ? { deviceClass } : {}) });
      return [];
    }
    case 'dependency.create': {
      const edge = { ...change.edge, id: newId('dep') };
      if (createdOut) createdOut.id = edge.id;
      await repo.createDependency(edge);
      await bump();
      await audit(repo, { ...auditBase, entityType: 'dependency', entityId: edge.id, after: edge, ...(changeRequestId ? { changeRequestId } : {}), ...(deviceClass ? { deviceClass } : {}) });
      return [edge.fromTaskId, edge.toTaskId];
    }
    case 'dependency.delete': {
      const before = await repo.getDependency(change.dependencyId);
      await repo.deleteDependency(change.dependencyId);
      await bump();
      await audit(repo, { ...auditBase, entityType: 'dependency', entityId: change.dependencyId, before, after: { deleted: true }, ...(changeRequestId ? { changeRequestId } : {}), ...(deviceClass ? { deviceClass } : {}) });
      return before ? [before.fromTaskId, before.toTaskId] : [];
    }
    case 'constraint.lock':
    case 'constraint.unlock': {
      const before = await repo.getTask(change.taskId);
      if (!before) throw new ApiError(404, 'NOT_FOUND', 'המשימה לא נמצאה');
      if (!await repo.applyTaskUpdates([{ id: change.taskId, expectedVersion: before.version, patch: { locked: change.type === 'constraint.lock' } }])) {
        throw new ApiError(409, 'VERSION_CONFLICT', 'הגרף השתנה במקביל — רענן ונסה שוב');
      }
      await bump();
      await audit(repo, { ...auditBase, entityType: 'task', entityId: change.taskId, before, after: await repo.getTask(change.taskId), ...(changeRequestId ? { changeRequestId } : {}), ...(deviceClass ? { deviceClass } : {}) });
      return [change.taskId];
    }
    case 'event.create': {
      const event = { ...change.event, id: newId('evt'), version: 1 };
      await repo.createEvent(event);
      await audit(repo, { ...auditBase, entityType: 'event', entityId: event.id, after: event, ...(changeRequestId ? { changeRequestId } : {}), ...(deviceClass ? { deviceClass } : {}) });
      return [];
    }
    case 'domino.apply':
      return []; // marker variant: the wrapped CR's own change is what applies
    default:
      throw new ApiError(400, 'UNSUPPORTED_CHANGE', 'סוג שינוי לא נתמך');
  }
}

/** Routes a ChangeRequest's frozen change to the right applier (approve path). */
export async function applyChangeRequest(
  repo: GraphRepository,
  snapshot: GraphSnapshot,
  cr: ChangeRequest,
  principal: Principal & { orgId: ID },
  deviceClass?: string,
): Promise<{ createdId?: ID }> {
  const created: { id?: ID } = {};
  await withAuditSafety(repo, async () => {
    if (SCHEDULING.has(actionOfChange(cr.change))) {
      await applyDomino(repo, snapshot, cr.dominoResult, cr.change, principal, 'domino.apply', deviceClass, cr.id, created);
    } else {
      const ids = await applyNeutral(repo, snapshot, cr.change, principal, 'domino.apply', deviceClass, cr.id, created);
      appEvents.emit({ type: 'graph.applied', eventId: snapshot.event.id, changedTaskIds: ids });
    }
  });
  return created.id ? { createdId: created.id } : {};
}

const ACTION_OF_TYPE: Record<ProposedChange['type'], Action> = {
  'event.create': 'event.create', 'event.update': 'event.update', 'event.publish': 'event.publish',
  'task.create': 'task.create', 'task.update': 'task.update', 'task.move': 'task.move',
  'task.assign': 'task.assign', 'task.delete': 'task.delete',
  'resource.create': 'resource.create', 'resource.update': 'resource.update', 'resource.delete': 'resource.delete',
  'dependency.create': 'dependency.create', 'dependency.delete': 'dependency.delete',
  'constraint.lock': 'constraint.lock', 'constraint.unlock': 'constraint.unlock',
  'domino.apply': 'domino.apply',
};

export function actionOfChange(change: ProposedChange): Action {
  return ACTION_OF_TYPE[change.type];
}
