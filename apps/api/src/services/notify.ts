import type {
  DominoResult, DomainProfile, EventNode, GraphSnapshot, ID, Impact,
  NotificationJob, NotificationKind, NotificationTarget,
} from '@contake/core';
import { hhmmToMin, renderInstant, wallMinutes } from '@contake/core';
import type { GraphRepository } from '../repo/graph-repository.js';

/**
 * Notification targeting (notifications spec §2: DominoResult.impacts is the ONLY
 * source of recipients — QA AC-NOT-1 recipient-set equality, AC-NOT-5 nothing
 * sends pre-approval). Alpha records jobs; sandbox provider dispatch lands at M3.
 * Idempotent: the same eventId+changeRequestId+kind never produces two jobs.
 */

let seq = 0;
const newJobId = (): ID => `njob_${Date.now().toString(36)}_${(seq += 1)}`;

interface BuiltJob {
  kind: NotificationKind | 'digest_multi_change';
  targets: NotificationTarget[];
  templateKey: string;
  params: Record<string, string>;
  /** external = group-subscriber (parent/client) delivery. Quiet hours hold ONLY
   *  external jobs (QA-M2-2); internal staff delivery is always immediate. */
  external: boolean;
}

/** Build the targeted jobs for an APPLIED change. Pure derivation, no writes. */
export async function buildJobsForAppliedChange(input: {
  repo: GraphRepository;
  snapshot: GraphSnapshot;
  domino: DominoResult;
  profile: DomainProfile;
  changeRequestId: ID;
  changeSummaryHe: string;
  now?: () => number;
}): Promise<NotificationJob[]> {
  const { repo, snapshot, domino, profile, changeRequestId } = input;
  const resources = new Map(snapshot.resources.map(r => [r.id, r] as const));
  const tasks = new Map(snapshot.tasks.map(t => [t.id, t] as const));

  // resourceId -> phone comes from the seeded user records (staff sign in by phone)
  const staffPhones = new Map<ID, string>();
  for (const u of await repo.listUsers(snapshot.event.orgId)) {
    if (u.linkedResourceId && u.phone) staffPhones.set(u.linkedResourceId, u.phone);
  }

  const movedInternal = new Map<string, NotificationTarget>();
  const movedExternal = new Map<string, NotificationTarget>();
  const cancelledInternal = new Map<string, NotificationTarget>();
  const cancelledExternal = new Map<string, NotificationTarget>();
  let firstMovedName = '';
  let firstCancelledName = '';
  const cancelledTaskIds = new Set(
    domino.impacts.filter(i => i.afterStart === null).map(i => i.taskId),
  );

  const addImpactTargets = async (impact: Impact, internal: Map<string, NotificationTarget>, external: Map<string, NotificationTarget>): Promise<void> => {
    for (const rid of impact.affectedResourceIds) {
      const res = resources.get(rid);
      if (res?.resourceKind !== 'person') continue;
      const phone = staffPhones.get(rid);
      if (phone) {
        internal.set(`p:${rid}`, { channel: 'whatsapp', address: phone, recipientLabel: res.name });
      }
    }
    for (const gid of impact.affectedGroupIds) {
      const grp = resources.get(gid);
      for (const chId of grp?.subscriberChannelIds ?? []) {
        const ch = await repo.getChannel(chId);
        external.set(`c:${chId}`, {
          channel: 'whatsapp',
          address: ch?.address ?? chId,
          recipientLabel: ch?.label ?? chId,
        });
      }
    }
  };

  for (const impact of domino.impacts) {
    if (cancelledTaskIds.has(impact.taskId)) {
      if (!firstCancelledName) firstCancelledName = tasks.get(impact.taskId)?.name ?? impact.taskId;
      await addImpactTargets(impact, cancelledInternal, cancelledExternal);
    } else {
      if (!firstMovedName) firstMovedName = tasks.get(impact.taskId)?.name ?? impact.taskId;
      await addImpactTargets(impact, movedInternal, movedExternal);
    }
  }

  const built: BuiltJob[] = [];
  const sorted = (m: Map<string, NotificationTarget>): NotificationTarget[] =>
    [...m.values()].sort((a, b) => a.address.localeCompare(b.address));
  if (movedInternal.size > 0) {
    built.push({
      kind: 'task_moved', external: false,
      targets: sorted(movedInternal),
      templateKey: 'task_moved',
      params: { taskName: firstMovedName, newStart: domino.movedTasks[0]?.afterStart ?? '', summaryHe: input.changeSummaryHe },
    });
  }
  if (movedExternal.size > 0) {
    built.push({
      kind: 'task_moved', external: true,
      targets: sorted(movedExternal),
      templateKey: 'task_moved',
      params: { taskName: firstMovedName, newStart: domino.movedTasks[0]?.afterStart ?? '', summaryHe: input.changeSummaryHe },
    });
  }
  if (cancelledInternal.size > 0) {
    built.push({
      kind: 'task_cancelled', external: false,
      targets: sorted(cancelledInternal),
      templateKey: 'task_cancelled',
      params: { taskName: firstCancelledName, summaryHe: input.changeSummaryHe },
    });
  }
  if (cancelledExternal.size > 0) {
    built.push({
      kind: 'task_cancelled', external: true,
      targets: sorted(cancelledExternal),
      templateKey: 'task_cancelled',
      params: { taskName: firstCancelledName, summaryHe: input.changeSummaryHe },
    });
  }

  const now = input.now?.() ?? Date.now();
  return built.map(b => toJob(repo, snapshot.event, profile, b, changeRequestId, now));
}

/** Approval-needed alert: admins only (AC-NOT-5: nobody else hears pre-approval). */
export async function buildApprovalNeededJob(input: {
  repo: GraphRepository;
  event: EventNode;
  profile: DomainProfile;
  changeRequestId: ID;
  summaryHe: string;
}): Promise<NotificationJob> {
  const { repo, event, changeRequestId } = input;
  const targets: NotificationTarget[] = (await repo.listUsers(event.orgId))
    .filter(u => u.role === 'admin')
    .map(u => ({ channel: 'in_app' as const, address: u.userId, recipientLabel: u.name }))
    .sort((a, b) => a.address.localeCompare(b.address));
  const job: NotificationJob = {
    id: newJobId(),
    eventId: event.id,
    kind: 'change_needs_approval',
    targets,
    templateKey: 'change_needs_approval',
    params: { summaryHe: input.summaryHe },
    idempotencyKey: `${event.id}+${changeRequestId}+change_needs_approval`,
    batchWindowSec: 60,
    createdAt: new Date().toISOString(), // v1.12
  };
  return job;
}

/** Quiet hours (N2 pinned): S3-class external notifications are held until 07:00
 *  local UNLESS the event is a published day currently in progress. Holds are
 *  expressed on the job record; dispatch honors them at M3. */
function toJob(
  repo: GraphRepository,
  event: EventNode,
  profile: DomainProfile,
  b: BuiltJob,
  changeRequestId: ID,
  nowMs: number,
): NotificationJob {
  const job: NotificationJob = {
    id: newJobId(),
    eventId: event.id,
    kind: b.kind,
    targets: b.targets,
    templateKey: b.templateKey,
    params: b.params,
    // internal half keeps the pinned key shape; external half gets a deterministic
    // suffix so recordJobs dedupe never collapses the two (QA-M2-2 recipient split).
    idempotencyKey: `${event.id}+${changeRequestId}+${b.kind}${b.external ? '+external' : ''}`,
    batchWindowSec: 60,
    createdAt: new Date().toISOString(), // v1.12
  };
  const quiet = profile.rules.quietHours ?? { startHHMM: '22:00', endHHMM: '07:00' };
  // QA-M2-2: quiet hours hold ONLY external (group-subscriber) delivery — staff never held.
  const isExternal = b.external;
  const dayMs = Date.parse(`${event.date}T00:00:00Z`);
  const todayMs = Date.parse(new Date(nowMs).toISOString().slice(0, 10) + 'T00:00:00Z');
  const isActivePublishedDay = event.status === 'published' && dayMs === todayMs;
  if (isExternal && !isActivePublishedDay) {
    const wall = wallMinutes(nowMs, event.timezone);
    const qStart = hhmmToMin(quiet.startHHMM);
    const qEnd = hhmmToMin(quiet.endHHMM);
    const inQuiet = qStart > qEnd ? wall >= qStart || wall < qEnd : wall >= qStart && wall < qEnd;
    if (inQuiet) {
      // deliver at quiet-window end (07:00 local) — held, never dropped
      const untilMs = nowMs + (((qEnd - wall) % 1440 + 1440) % 1440) * 60000;
      job.holdUntil = renderInstant(untilMs, event.timezone);
    }
  }
  void repo;
  return job;
}

/** Reassignment fanout (contracts v1.3 / notifications spec v1.2 §2א): a pure
 *  task.assign notifies NEW person assignees (task_assigned) and REMOVED person
 *  assignees (task_unassigned). Person-level only — groups/external subscribers
 *  are never fanned out on reassignment alone. Staff-internal: always immediate. */
export async function buildReassignmentJobs(input: {
  repo: GraphRepository;
  snapshot: GraphSnapshot;
  profile: DomainProfile;
  changeRequestId: ID;
  taskId: ID;
  addedPersonIds: ID[];
  removedPersonIds: ID[];
  now?: () => number;
}): Promise<NotificationJob[]> {
  const { repo, snapshot, profile, changeRequestId } = input;
  const task = snapshot.tasks.find(t => t.id === input.taskId);
  if (!task) return [];
  const resources = new Map(snapshot.resources.map(r => [r.id, r] as const));
  const users = await repo.listUsers(snapshot.event.orgId);
  const targetFor = (rid: ID): NotificationTarget | null => {
    const res = resources.get(rid);
    if (res?.resourceKind !== 'person') return null;
    const user = users.find(u => u.linkedResourceId === rid);
    if (user?.phone) return { channel: 'whatsapp', address: user.phone, recipientLabel: res.name };
    if (user) return { channel: 'in_app', address: user.userId, recipientLabel: res.name };
    return null;
  };
  const jobs: NotificationJob[] = [];
  const build = (kind: NotificationKind, personIds: ID[], params: Record<string, string>): void => {
    const targets = personIds
      .map(targetFor)
      .filter((t): t is NotificationTarget => t !== null)
      .sort((a, b) => a.address.localeCompare(b.address));
    if (targets.length === 0) return;
    jobs.push({
      id: newJobId(),
      eventId: snapshot.event.id,
      kind,
      targets,
      templateKey: kind,
      params,
      idempotencyKey: `${snapshot.event.id}+${changeRequestId}+${kind}`,
      batchWindowSec: 60,
      createdAt: new Date().toISOString(), // v1.12
    });
  };
  build('task_assigned', input.addedPersonIds, { taskName: task.name, newStart: task.start ?? '' });
  build('task_unassigned', input.removedPersonIds, { taskName: task.name });
  return jobs;
}

/** Record jobs idempotently (QA AC-DOM-6/AC-NOT-2): existing key -> existing job. */
export async function recordJobs(repo: GraphRepository, jobs: NotificationJob[]): Promise<NotificationJob[]> {
  const out: NotificationJob[] = [];
  for (const j of jobs) {
    out.push(await repo.getNotificationJobByIdempotencyKey(j.idempotencyKey) ?? await repo.createNotificationJob(j));
  }
  return out;
}
