/**
 * Mock API adapter — async, REST-shaped, in-memory. Mirrors contracts v1.1 §8
 * so the UI code swaps to the real Fastify backend by changing this module only.
 * Role gating mirrors rbac-matrix v1.1 for UI purposes; the server remains the
 * enforcement point (AC-RBAC-3). All mutations append to an audit log (§9).
 */
import type {
  AuditLogEntry, ChangeRequest, DomainProfile, DominoResult, GraphSnapshot, ID,
  NotificationJob, NotificationTarget, Principal, ProposedChange, Role, StatusReport, TaskNode,
} from '../contracts/contake-core-contracts.v1.1';
import { computeDomino } from '../engine/computeDomino';
import { DEMO_INCIDENTS, PROFILES, SEEDERS, SUBSCRIBER_CHANNELS } from './seed';
import rbacMatrix from '../contracts/rbac-matrix.v1.1.json';

export interface SentRecord { job: NotificationJob; sentAt: string; }
export interface SkippedParty { label: string; why: string; }
export interface ClientState {
  profile: DomainProfile;
  graph: GraphSnapshot;
  reports: StatusReport[];
  changes: ChangeRequest[];
  pendingNotifications: NotificationJob[];
  sentNotifications: SentRecord[];
  skipped: SkippedParty[];
  audit: AuditLogEntry[];
}

interface ProfileState {
  graph: GraphSnapshot;
  reports: StatusReport[];
  changes: ChangeRequest[];
  pendingNotifications: NotificationJob[];
  sentNotifications: SentRecord[];
  skipped: SkippedParty[];
  audit: AuditLogEntry[];
  seq: number;
  seenClientReportIds: Set<string>;
}

type Matrix = { matrix: Record<string, Record<Role, 'allow' | 'scope' | 'propose' | 'deny'>> };
const MATRIX = (rbacMatrix as unknown as Matrix).matrix;

const latency = () => new Promise((r) => setTimeout(r, 60));
const states = new Map<string, ProfileState>();
let seq = 1000;
const nid = (p: string) => `${p}-${(++seq).toString(36)}`;
const nowIso = () => new Date().toISOString();

/** Focus worker identity used by the demo session per profile (one linked person). */
export const FOCUS_LINKED: Record<string, { userId: string; resourceId: string; display: string }> = {
  camp: { userId: 'u-noaa', resourceId: 'r-noaa', display: 'נועה כהן · מלוות אוטובוס' },
  'event-production': { userId: 'u-avi', resourceId: 'e-avi', display: 'אבי · טכנאי סאונד' },
  'film-shoot': { userId: 'u-shani', resourceId: 'f-shani', display: 'שני · ראש צוות תאורה' },
  conference: { userId: 'u-omer', resourceId: 'c-omer', display: 'עומר · מפעיל טכני' },
  logistics: { userId: 'u-haim', resourceId: 'l-haim', display: 'חיים · מוביל' },
  'after-school': { userId: 'u-avi2', resourceId: 'u-avi', display: 'אבי · מדריך ג׳ודו' },
  education: { userId: 'u-asnat', resourceId: 't-asnat', display: 'אסנת · מורה למתמטיקה' },
};

function stateOf(profileId: string): ProfileState {
  let s = states.get(profileId);
  if (!s) {
    const seeder = SEEDERS[profileId];
    if (!seeder) throw new Error(`unknown profile ${profileId}`);
    s = {
      graph: seeder(), reports: [], changes: [], pendingNotifications: [],
      sentNotifications: [], skipped: [], audit: [], seq: 0, seenClientReportIds: new Set(),
    };
    states.set(profileId, s);
  }
  return s;
}
export function resetState(profileId: string): void { states.delete(profileId); }

export function principalFor(profileId: string, role: Role): Principal {
  const g = stateOf(profileId).graph;
  if (role === 'focus_worker') {
    const f = FOCUS_LINKED[profileId];
    return { userId: f.userId, role, scopes: [{ eventId: g.event.id }], linkedResourceId: f.resourceId };
  }
  return { userId: role === 'admin' ? 'u-admin' : 'u-field', role, scopes: [{ eventId: g.event.id }] };
}

function decision(action: string, role: Role): 'allow' | 'scope' | 'propose' | 'deny' {
  return MATRIX[action]?.[role] ?? 'deny';
}

function audit(s: ProfileState, p: Principal, action: AuditLogEntry['action'], entityType: AuditLogEntry['entityType'], entityId: ID, before: unknown, after: unknown, changeRequestId?: ID): void {
  s.audit.unshift({
    id: nid('aud'), orgId: s.graph.event.orgId, eventId: s.graph.event.id,
    actorUserId: p.userId, role: p.role, action, entityType, entityId,
    beforeJson: before == null ? null : JSON.stringify(before),
    afterJson: after == null ? null : JSON.stringify(after),
    changeRequestId, deviceClass: 'desktop', createdAt: nowIso(),
  });
}

/** Apply a computed domino to the graph (the server does this atomically per spec §5). */
function applyDomino(s: ProfileState, d: DominoResult): void {
  for (const m of d.movedTasks) {
    const t = s.graph.tasks.find((x) => x.id === m.taskId);
    if (t) { t.start = m.afterStart; t.version += 1; }
  }
  s.graph.event.version += 1;
}

/** Notifications spec §2: targets derive ONLY from DominoResult.impacts. */
function jobsFromImpacts(s: ProfileState, d: DominoResult, changeRequestId: ID | undefined, profile: DomainProfile): NotificationJob[] {
  const targets: NotificationTarget[] = [];
  const seen = new Set<string>();
  for (const imp of d.impacts) {
    const task = s.graph.tasks.find((t) => t.id === imp.taskId);
    for (const rid of imp.affectedResourceIds) {
      const r = s.graph.resources.find((x) => x.id === rid);
      if (r && !seen.has('p:' + rid)) {
        seen.add('p:' + rid);
        targets.push({ channel: 'whatsapp', address: `mock-person:${rid}`, recipientLabel: r.name });
      }
    }
    for (const gid of imp.affectedGroupIds) {
      const g = s.graph.resources.find((x) => x.id === gid);
      for (const chId of g?.subscriberChannelIds ?? []) {
        const ch = SUBSCRIBER_CHANNELS[chId];
        if (ch && !seen.has('g:' + chId)) {
          seen.add('g:' + chId);
          targets.push({ channel: ch.channel, address: `mock-channel:${chId}`, recipientLabel: `${ch.label} (${ch.count})` });
        }
      }
    }
    void task;
  }
  if (!targets.length) return [];
  const firstMoved = d.movedTasks.find((m) => d.impacts.some((i) => i.taskId === m.taskId));
  const firstTask = firstMoved ? s.graph.tasks.find((t) => t.id === firstMoved.taskId) : undefined;
  const fmtTime = (isoV: string) => new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: s.graph.event.timezone }).format(new Date(isoV));
  return [{
    id: nid('njob'), eventId: s.graph.event.id, kind: 'task_moved', targets,
    templateKey: 'task_moved',
    params: { taskName: firstTask?.name ?? '', newStart: firstMoved ? fmtTime(firstMoved.afterStart) : '' },
    idempotencyKey: `${s.graph.event.id}+${changeRequestId ?? 'direct'}+task_moved`,
    batchWindowSec: 60,
  }];
}

/** Who deliberately gets nothing (the anti-noise panel), computed against a job. */
function computeSkipped(s: ProfileState, targets: NotificationTarget[]): SkippedParty[] {
  const targeted = new Set(targets.map((t) => t.address));
  const out: SkippedParty[] = [];
  for (const r of s.graph.resources) {
    if (r.resourceKind === 'person' && !targeted.has(`mock-person:${r.id}`)) {
      out.push({ label: r.name, why: 'המשימות שלו לא השתנו' });
    }
    if (r.resourceKind === 'group') {
      for (const chId of r.subscriberChannelIds ?? []) {
        const ch = SUBSCRIBER_CHANNELS[chId];
        if (ch && !targeted.has(`mock-channel:${chId}`)) {
          out.push({ label: `${ch.label} (${ch.count})`, why: 'לוח הזמנים שלהם לא השתנה — בלי רעש' });
        }
      }
    }
  }
  return out;
}

// ================= reads =================
export async function getProfiles(): Promise<DomainProfile[]> { await latency(); return PROFILES; }

export async function getClientState(profileId: string, role: Role): Promise<ClientState> {
  await latency();
  const s = stateOf(profileId);
  const profile = PROFILES.find((p) => p.id === profileId)!;
  let graph = s.graph;
  if (role === 'focus_worker') {
    // AC-RBAC-4 data minimization: focus workers never receive the full graph.
    const linked = FOCUS_LINKED[profileId].resourceId;
    const tasks = s.graph.tasks.filter((t) => t.assigneeResourceIds.includes(linked));
    const resIds = new Set(tasks.flatMap((t) => t.assigneeResourceIds));
    graph = {
      event: s.graph.event,
      tasks,
      resources: s.graph.resources.filter((r) => resIds.has(r.id)),
      dependencies: [],
    };
  }
  return {
    profile,
    graph,
    reports: role === 'focus_worker' ? s.reports.filter((r) => r.reportedBy === FOCUS_LINKED[profileId].userId) : s.reports,
    changes: role === 'focus_worker' ? [] : s.changes,
    pendingNotifications: role === 'admin' ? s.pendingNotifications : [],
    sentNotifications: role === 'focus_worker' ? [] : s.sentNotifications,
    skipped: s.skipped,
    audit: role === 'focus_worker' ? [] : s.audit,
  };
}

// ================= field reports (Focus Mode) =================
export interface ReportInput { taskId: ID; status: StatusReport['status']; delayMin?: number; noteHe?: string; clientReportId: string; }
export interface ReportResult { report: StatusReport; domino: DominoResult | null; outcome: 'recorded' | 'auto_applied' | 'pending_review'; duplicate: boolean; }

export async function submitReport(profileId: string, input: ReportInput, principal: Principal): Promise<ReportResult> {
  await latency();
  const s = stateOf(profileId);
  const profile = PROFILES.find((p) => p.id === profileId)!;
  if (s.seenClientReportIds.has(input.clientReportId)) {
    const existing = s.reports.find((r) => r.clientReportId === input.clientReportId)!;
    return { report: existing, domino: null, outcome: 'recorded', duplicate: true };
  }
  s.seenClientReportIds.add(input.clientReportId);
  const report: StatusReport = {
    id: nid('rep'), taskId: input.taskId, reportedBy: principal.userId, status: input.status,
    delayMin: input.delayMin, noteHe: input.noteHe, clientReportId: input.clientReportId,
    clientTimestamp: nowIso(), createdAt: nowIso(),
  };
  s.reports.unshift(report);
  audit(s, principal, 'report.status.create', 'task', input.taskId, null, report);

  if (input.status !== 'delayed' || !input.delayMin) {
    const t = s.graph.tasks.find((x) => x.id === input.taskId);
    if (t && input.status === 'done') { t.status = 'done'; audit(s, principal, 'task.update', 'task', t.id, { status: 'planned' }, { status: 'done' }); }
    if (t && input.status === 'blocked') { t.status = 'delayed'; }
    return { report, domino: null, outcome: 'recorded', duplicate: false };
  }

  // delayed => domino.compute on duration extension (spec §4 test 4)
  const t = s.graph.tasks.find((x) => x.id === input.taskId);
  if (!t) return { report, domino: null, outcome: 'recorded', duplicate: false };
  const change: ProposedChange = { type: 'task.update', taskId: t.id, patch: { durationMin: t.durationMin + input.delayMin, status: 'delayed' } };
  const domino = computeDomino(s.graph, change, profile);
  // reportApplyRule (C2): own-task, unlocked, computed impact S0 => auto-apply.
  const ownTask = principal.linkedResourceId ? t.assigneeResourceIds.includes(principal.linkedResourceId) : false;
  if (domino.ok && ownTask && !t.locked && domino.maxImpactClass === 'S0') {
    const before = JSON.parse(JSON.stringify(t));
    Object.assign(t, change.patch);
    t.version += 1;
    applyDomino(s, domino);
    audit(s, principal, 'task.update', 'task', t.id, before, t);
    return { report, domino, outcome: 'auto_applied', duplicate: false };
  }
  // above S0 (or locked / not own) => ChangeRequest pending_review; graph untouched.
  const cr: ChangeRequest = {
    id: nid('cr'), eventId: s.graph.event.id, proposedBy: principal.userId, role: principal.role,
    change, baseGraphVersion: s.graph.event.version, dominoResult: domino, state: 'pending_review',
    reasonHe: `דיווח עיכוב ${input.delayMin} דקות על "${t.name}" — ${domino.summaryHe} (דרגת השפעה ${domino.maxImpactClass})`,
    createdAt: nowIso(),
  };
  s.changes.unshift(cr);
  audit(s, principal, 'domino.compute', 'task', t.id, null, domino, cr.id);
  return { report, domino, outcome: 'pending_review', duplicate: false };
}

// ================= builder mutations =================
export interface SaveResult { outcome: 'applied' | 'pending_review' | 'denied' | 'stale'; changeRequest?: ChangeRequest; domino?: DominoResult; messageHe: string; }

export async function saveTask(profileId: string, taskId: ID | null, draft: Partial<TaskNode> & { name: string }, principal: Principal): Promise<SaveResult> {
  await latency();
  const s = stateOf(profileId);
  const profile = PROFILES.find((p) => p.id === profileId)!;
  const isNew = taskId == null;
  const existing = isNew ? null : s.graph.tasks.find((t) => t.id === taskId) ?? null;
  if (!isNew && !existing) return { outcome: 'denied', messageHe: 'המשימה לא נמצאה' };

  const action = isNew ? 'task.create' : 'task.update';
  const dec = decision(action, principal.role);
  if (dec === 'deny') return { outcome: 'denied', messageHe: 'אין הרשאה לפעולה זו' };

  const next: TaskNode = existing
    ? { ...existing, ...draft, id: existing.id }
    : { kind: 'task', eventId: s.graph.event.id, siteId: s.graph.event.siteIds[0], name: draft.name, start: draft.start ?? null, durationMin: draft.durationMin ?? 45, status: 'planned', locked: !!draft.locked, assigneeResourceIds: draft.assigneeResourceIds ?? [], version: 1, id: nid('task') };

  const timeChanged = !!existing && (existing.start !== next.start || existing.durationMin !== next.durationMin);
  const change: ProposedChange | null = !existing
    ? { type: 'task.create', task: { ...next } }
    : timeChanged
      ? { type: 'task.update', taskId: next.id, patch: { durationMin: next.durationMin, ...(next.start ? {} : {}) } }
      : { type: 'task.assign', taskId: next.id, assigneeResourceIds: next.assigneeResourceIds };

  let domino: DominoResult | undefined;
  if (existing && timeChanged && next.start && existing.start) {
    domino = computeDomino(s.graph, { type: 'task.move', taskId: next.id, newStart: next.start }, profile);
    if (existing.durationMin !== next.durationMin) {
      // duration edits evaluate through update semantics
      domino = computeDomino(s.graph, { type: 'task.update', taskId: next.id, patch: { durationMin: next.durationMin } }, profile);
    }
  }
  const lockTouched = !!existing && (existing.locked !== next.locked || (existing.locked && timeChanged));
  const impact = domino?.maxImpactClass ?? (lockTouched ? 'S1' : 'S0');
  // autoEscalation (matrix v1.1): field_manager >=S1 => ChangeRequest. admin always allow.
  const needsApproval = principal.role === 'field_manager' && (lockTouched || impact !== 'S0');

  if (needsApproval) {
    const cr: ChangeRequest = {
      id: nid('cr'), eventId: s.graph.event.id, proposedBy: principal.userId, role: principal.role,
      change: existing ? { type: 'task.update', taskId: next.id, patch: { name: next.name, durationMin: next.durationMin, status: next.status } } : change!,
      baseGraphVersion: s.graph.event.version,
      dominoResult: domino ?? { ok: true, movedTasks: [], impacts: [], conflicts: [], maxImpactClass: 'S0', summaryHe: 'שינוי בהקצאה בלבד', blockedTaskIds: [] },
      state: 'pending_review',
      reasonHe: lockTouched
        ? `שינוי במשימה נעולה 🔒 "${next.name}" — דורש אישור מנהל-על`
        : `${domino!.summaryHe} (דרגת השפעה ${impact})`,
      createdAt: nowIso(),
    };
    s.changes.unshift(cr);
    audit(s, principal, action as AuditLogEntry['action'], 'task', next.id, existing, next, cr.id);
    return { outcome: 'pending_review', changeRequest: cr, domino, messageHe: '📨 שינוי רוחבי — נשלח לאישור מנהל-על' };
  }

  const before = existing ? JSON.parse(JSON.stringify(existing)) : null;
  if (existing) Object.assign(existing, next, { version: existing.version + 1 });
  else s.graph.tasks.push(next);
  if (domino && domino.ok && domino.movedTasks.length) applyDomino(s, domino);
  s.graph.event.version += 1;
  audit(s, principal, action as AuditLogEntry['action'], 'task', next.id, before, next);
  return { outcome: 'applied', domino, messageHe: `✓ "${next.name}" נשמרה` };
}

export async function deleteTask(profileId: string, taskId: ID, principal: Principal): Promise<SaveResult> {
  await latency();
  const s = stateOf(profileId);
  const t = s.graph.tasks.find((x) => x.id === taskId);
  if (!t) return { outcome: 'denied', messageHe: 'המשימה לא נמצאה' };
  const dec = decision('task.delete', principal.role);
  if (dec === 'deny') return { outcome: 'denied', messageHe: 'אין הרשאה למחיקה' };
  if (dec === 'propose' || (principal.role === 'field_manager' && (t.locked || s.graph.dependencies.some((d) => d.toTaskId === t.id)))) {
    const cr: ChangeRequest = {
      id: nid('cr'), eventId: s.graph.event.id, proposedBy: principal.userId, role: principal.role,
      change: { type: 'task.delete', taskId }, baseGraphVersion: s.graph.event.version,
      dominoResult: { ok: true, movedTasks: [], impacts: [], conflicts: [], maxImpactClass: 'S1', summaryHe: `מחיקת "${t.name}"`, blockedTaskIds: [] },
      state: 'pending_review',
      reasonHe: t.locked ? `מחיקת משימה נעולה 🔒 "${t.name}"` : `מחיקת "${t.name}" עם משימות תלויות`,
      createdAt: nowIso(),
    };
    s.changes.unshift(cr);
    return { outcome: 'pending_review', changeRequest: cr, messageHe: '📨 מחיקה רוחבית — נשלחה לאישור מנהל-על' };
  }
  s.graph.tasks = s.graph.tasks.filter((x) => x.id !== taskId);
  s.graph.dependencies = s.graph.dependencies.filter((d) => d.fromTaskId !== taskId && d.toTaskId !== taskId);
  s.graph.event.version += 1;
  audit(s, principal, 'task.delete', 'task', taskId, t, null);
  return { outcome: 'applied', messageHe: `✓ "${t.name}" נמחקה` };
}

// ================= change requests (approvals) =================
export async function approveChange(profileId: string, changeId: ID, principal: Principal): Promise<SaveResult> {
  await latency();
  const s = stateOf(profileId);
  if (decision('change.approve', principal.role) !== 'allow') return { outcome: 'denied', messageHe: 'רק מנהל-על מאשר' };
  const cr = s.changes.find((c) => c.id === changeId);
  if (!cr || cr.state !== 'pending_review') return { outcome: 'denied', messageHe: 'בקשה לא תקפה' };
  if (cr.baseGraphVersion !== s.graph.event.version) {
    return { outcome: 'stale', messageHe: 'הגרף השתנה מאז ההצעה — נדרשת הצעה מחודשת (409 stale)' };
  }
  // Atomic approve = validate + apply + notify (AC-RBAC-6). Blocking conflicts never apply.
  const d = cr.dominoResult;
  if (d.ok) {
    if (cr.change.type === 'task.update' || cr.change.type === 'task.move') {
      const t = s.graph.tasks.find((x) => x.id === (cr.change as { taskId: string }).taskId);
      if (t && cr.change.type === 'task.update') Object.assign(t, cr.change.patch, { version: t.version + 1 });
      if (t && cr.change.type === 'task.move') { t.start = cr.change.newStart; t.version += 1; }
    } else if (cr.change.type === 'task.delete') {
      s.graph.tasks = s.graph.tasks.filter((x) => x.id !== (cr.change as { taskId: string }).taskId);
      s.graph.dependencies = s.graph.dependencies.filter((x) => x.fromTaskId !== (cr.change as { taskId: string }).taskId && x.toTaskId !== (cr.change as { taskId: string }).taskId);
    }
    applyDomino(s, d);
  }
  s.graph.event.version += 1;
  cr.state = 'approved';
  cr.resolvedBy = principal.userId;
  cr.resolvedAt = nowIso();
  const profile = PROFILES.find((p) => p.id === profileId)!;
  if (d.ok && d.impacts.length) {
    const jobs = jobsFromImpacts(s, d, cr.id, profile);
    s.pendingNotifications.push(...jobs);
    s.skipped = computeSkipped(s, jobs.flatMap((j) => j.targets));
  }
  audit(s, principal, 'change.approve', 'change_request', cr.id, { state: 'pending_review' }, { state: 'approved' }, cr.id);
  return { outcome: 'applied', messageHe: `✓ אושר והוחל` };
}

export async function rejectChange(profileId: string, changeId: ID, principal: Principal): Promise<SaveResult> {
  await latency();
  const s = stateOf(profileId);
  if (decision('change.reject', principal.role) !== 'allow') return { outcome: 'denied', messageHe: 'רק מנהל-על דוחה' };
  const cr = s.changes.find((c) => c.id === changeId);
  if (!cr || cr.state !== 'pending_review') return { outcome: 'denied', messageHe: 'בקשה לא תקפה' };
  cr.state = 'rejected';
  cr.resolvedBy = principal.userId;
  cr.resolvedAt = nowIso();
  audit(s, principal, 'change.reject', 'change_request', cr.id, { state: 'pending_review' }, { state: 'rejected' }, cr.id);
  return { outcome: 'applied', messageHe: '✕ נדחה — הגרף נשאר ללא שינוי' };
}

// ================= dependencies =================
function wouldCycle(deps: Array<{ fromTaskId: ID; toTaskId: ID }>, fromId: ID, toId: ID): ID[] | null {
  // new edge from->to cycles iff 'from' is reachable from 'to'
  const adj = new Map<ID, ID[]>();
  for (const d of deps) {
    if (!adj.has(d.fromTaskId)) adj.set(d.fromTaskId, []);
    adj.get(d.fromTaskId)!.push(d.toTaskId);
  }
  const stack: ID[] = [toId];
  const seen = new Set<ID>();
  const parent = new Map<ID, ID>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === fromId) {
      const path: ID[] = [fromId];
      let c = fromId;
      while (parent.has(c)) { c = parent.get(c)!; path.push(c); }
      return path;
    }
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const n of adj.get(cur) ?? []) { if (!parent.has(n)) parent.set(n, cur); stack.push(n); }
  }
  return null;
}

export async function saveDependency(profileId: string, fromTaskId: ID, toTaskId: ID, principal: Principal): Promise<SaveResult> {
  await latency();
  const s = stateOf(profileId);
  const dec = decision('dependency.create', principal.role);
  if (dec === 'deny') return { outcome: 'denied', messageHe: 'אין הרשאה ליצירת תלות' };
  if (fromTaskId === toTaskId) return { outcome: 'denied', messageHe: 'משימה לא יכולה להיות תלויה בעצמה' };
  if (s.graph.dependencies.some((d) => d.fromTaskId === fromTaskId && d.toTaskId === toTaskId)) {
    return { outcome: 'denied', messageHe: 'התלות כבר קיימת' };
  }
  const cycle = wouldCycle(s.graph.dependencies, fromTaskId, toTaskId);
  if (cycle) {
    const nameOf = (tid: ID) => s.graph.tasks.find((t) => t.id === tid)?.name ?? tid;
    return { outcome: 'denied', messageHe: `קשר תלות מעגלי אסור: ${cycle.map(nameOf).join(' ← ')}` };
  }
  const edge = { id: nid('dep'), kind: 'depends_on' as const, fromTaskId, toTaskId, lagMin: 0, hard: true };
  if (dec !== 'allow') {
    const cr: ChangeRequest = {
      id: nid('cr'), eventId: s.graph.event.id, proposedBy: principal.userId, role: principal.role,
      change: { type: 'dependency.create', edge }, baseGraphVersion: s.graph.event.version,
      dominoResult: { ok: true, movedTasks: [], impacts: [], conflicts: [], maxImpactClass: 'S0', summaryHe: 'יצירת תלות חדשה', blockedTaskIds: [] },
      state: 'pending_review', reasonHe: 'יצירת תלות חדשה — דורש אישור מנהל-על', createdAt: nowIso(),
    };
    s.changes.unshift(cr);
    audit(s, principal, 'dependency.create', 'task', fromTaskId, null, edge, cr.id);
    return { outcome: 'pending_review', changeRequest: cr, messageHe: '📨 נשלח לאישור מנהל-על' };
  }
  s.graph.dependencies.push(edge);
  s.graph.event.version += 1;
  audit(s, principal, 'dependency.create', 'task', fromTaskId, null, edge);
  return { outcome: 'applied', messageHe: '✓ תלות נוצרה' };
}

export async function deleteDependency(profileId: string, dependencyId: ID, principal: Principal): Promise<SaveResult> {
  await latency();
  const s = stateOf(profileId);
  const dec = decision('dependency.delete', principal.role);
  if (dec === 'deny') return { outcome: 'denied', messageHe: 'אין הרשאה למחיקת תלות' };
  const dep = s.graph.dependencies.find((d) => d.id === dependencyId);
  if (!dep) return { outcome: 'denied', messageHe: 'התלות לא נמצאה' };
  if (dec !== 'allow') {
    const cr: ChangeRequest = {
      id: nid('cr'), eventId: s.graph.event.id, proposedBy: principal.userId, role: principal.role,
      change: { type: 'dependency.delete', dependencyId }, baseGraphVersion: s.graph.event.version,
      dominoResult: { ok: true, movedTasks: [], impacts: [], conflicts: [], maxImpactClass: 'S0', summaryHe: 'מחיקת תלות', blockedTaskIds: [] },
      state: 'pending_review', reasonHe: 'מחיקת תלות — דורש אישור מנהל-על', createdAt: nowIso(),
    };
    s.changes.unshift(cr);
    audit(s, principal, 'dependency.delete', 'task', dep.fromTaskId, dep, null, cr.id);
    return { outcome: 'pending_review', changeRequest: cr, messageHe: '📨 נשלח לאישור מנהל-על' };
  }
  s.graph.dependencies = s.graph.dependencies.filter((d) => d.id !== dependencyId);
  s.graph.event.version += 1;
  audit(s, principal, 'dependency.delete', 'task', dep.fromTaskId, dep, null);
  return { outcome: 'applied', messageHe: '✓ תלות נמחקה' };
}

// ================= notifications =================
export async function sendNotifications(profileId: string, principal: Principal): Promise<{ sent: number; messageHe: string }> {
  await latency();
  const s = stateOf(profileId);
  if (decision('notify.send.targeted', principal.role) !== 'allow') return { sent: 0, messageHe: 'רק מנהל-על שולח עדכונים' };
  const jobs = s.pendingNotifications.splice(0);
  const sentAt = nowIso();
  for (const j of jobs) {
    s.sentNotifications.unshift({ job: j, sentAt });
    audit(s, principal, 'notify.send.targeted', 'notification', j.id, null, { targets: j.targets.length, idempotencyKey: j.idempotencyKey });
  }
  return { sent: jobs.length, messageHe: `✓ נשלחו ${jobs.length} עדכונים ממוקדים` };
}

/** REWRITE-ADD (r3): ack a sent notification job (lost from r2.1, era skew). Mock marks the
 *  stored job acknowledged; NotificationJob ack fields are v1.2+ so applied via cast. */
export async function ackNotifyJob(profileId: string, jobId: ID, _principal: Principal): Promise<SaveResult> {
  await latency();
  const s = stateOf(profileId);
  const rec = s.sentNotifications.find((r) => r.job.id === jobId);
  if (rec) {
    (rec.job as NotificationJob & { acknowledgedBy?: string; acknowledgedAt?: string }).acknowledgedBy = _principal.userId;
    (rec.job as NotificationJob & { acknowledgedBy?: string; acknowledgedAt?: string }).acknowledgedAt = new Date().toISOString();
  }
  return { outcome: 'applied', messageHe: '✓ סומן כטופל' };
}

export async function computePreview(profileId: string, change: ProposedChange): Promise<DominoResult> {
  await latency();
  const s = stateOf(profileId);
  const profile = PROFILES.find((p) => p.id === profileId)!;
  return computeDomino(s.graph, change, profile);
}

export function demoIncident(profileId: string) { return DEMO_INCIDENTS[profileId]; }