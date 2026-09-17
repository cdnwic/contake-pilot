/**
 * @contake/core — Shared contracts v1.10 (2026-09-12)
 * Single source of truth for Backend, Frontend, Design and QA workstreams.
 * Pure TypeScript + Zod. No IO, no framework imports.
 * Versioning: tech lead owns this file; consumers pin a version, never edit locally.
 *
 * v1.10 changelog (web push workstream, ADDITIVE ONLY — zero breaking changes):
 *    Web push approved by the product owner (relayed via main, 2026-09-12) as a
 *    complementary in-app channel. Push is a DELIVERY PATH derived from existing
 *    in_app targets at dispatch time — DominoResult.impacts remains the ONLY
 *    targeting source (notifications spec v1.6 §2). No NotificationJob /
 *    RealtimeFrame / template / matrix changes. Push serves INTERNAL users only
 *    and is never quiet-hours-held; external group subscribers receive no push.
 *  + NotifyChannel gains 'web_push'.
 *  + PushSubscription interface (per user/device, org-scoped). endpoint + keys
 *    are operational secrets: never emitted to another user, never in realtime
 *    frames (QA-M2-3 analog).
 *  + Action gains 'push.subscribe' | 'push.unsubscribe' — audit completeness for
 *    the self-service endpoints; NO matrix rows (v1.8 notify.ack precedent).
 *    Cross-user subscription attempts = 403 + v1.9 denied audit (scope_violation).
 *  + AuditEntityType gains 'push_subscription'.
 *  + Endpoints: GET /v1/push/vapid-public-key; POST /GET /DELETE
 *    /v1/push/subscriptions (owner-only self-service, upsert idempotent on endpoint).
 *
 * v1.9 changelog (G4 planning, ADDITIVE): denied-attempt auditing generalized —
 *    every MUTATING endpoint attempt that passes authentication but fails
 *    authorization (matrix deny or scope violation) appends an AuditLogEntry with
 *    outcome 'denied' + denialReason. Excluded: read endpoints (volume),
 *    domino.compute dry-run (non-mutating), failed authentication (401, no
 *    Principal). beforeJson/afterJson are null on denied rows; eventId is the
 *    target event when determinable. The denied-audit append is standalone (no
 *    mutation tx exists); if it fails the denial still stands and the failure is
 *    logged server-side — a broken audit store never upgrades a denial.
 *    Success-path audits stay tx-atomic per QA-M2-6. No matrix cell changes.
 *
 * v1.8 changelog (ADDITIVE): 'notify.ack' added to the Action union — the ack
 *    endpoint is a mutation, and the every-mutation-is-audited invariant (QA §9)
 *    stays absolute: ack writes an AuditLogEntry (entityType 'notification').
 *    The job's acknowledgedBy/At fields remain the state record; the audit row is
 *    the who-did-what record. RBAC matrix unchanged (endpoint stays admin-only).
 *
 * v1.7 changelog (QA precision fix, no wire change vs v1.6):
 *  ~ 'notify.acked' emission target named exactly: adminsRoom(orgId) — ack is
 *    admin-only and cross-admin handled-state is its purpose. There is no
 *    event-wide room; the model is adminsRoom / siteRoom / userRoom only.
 *
 * v1.6 changelog (PR-3 FE ruling, ADDITIVE):
 *  + NotificationJob.acknowledgedBy/acknowledgedAt + POST /v1/notify-jobs/:id/ack
 *    (admin only, idempotent: re-ack returns 200 with the existing ack, never overwrites)
 *    + realtime frame 'notify.acked' to adminsRoom(orgId) [target named exactly in v1.7]. Purpose: FYI notifications
 *    (esp. notify.failed, QA-M2-5) get shared handled-state across admins on shift;
 *    session-local dismiss is NOT sufficient for the pilot. Admin-only matches the
 *    existing GET /v1/notifications scope (matrix unchanged).
 *
 * v1.5 changelog (ADDITIVE types only — no wire change vs v1.4):
 *  + Exported RealtimeFrame union (GraphPatchFrame | GraphRemoveFrame | ChangePendingFrame |
 *    ChangeResolvedFrame | ReportNewFrame | NotifyFailedFrame) so tsc enforces
 *    client/server frame conformance (was comment-only). QA nit, adopted immediately
 *    so the v6 drop can consume it. Frame PAYLOADS unchanged from v1.4.
 *
 * v1.4 changelog (RT-PIN-4, ADDITIVE wire frame):
 *  + Realtime frame 'graph.remove' { type: 'graph.remove', eventId: string, version: number,
 *    taskIds: string[], siteId?: string } — tombstone for REMOVALS, which incremental
 *    upsert frames cannot express (unassignment, site transfer). siteId is present when
 *    the emission targets a site room (mirrors the graph.patch convention), absent on
 *    user-room frames. Emitted to the rooms that previously held the task: the source
 *    event:{eventId}:site:{siteId} room and the user:{userId} rooms of removed person
 *    assignees — NO adminsRoom emission (admin full-snapshots reconcile wholesale).
 *    version = event.version AFTER the change, in the SAME sequence as graph.patch.
 *    Clients apply under
 *    the same rule as graph.patch (RT-PIN-3): sequential version -> remove locally;
 *    gap/stale -> full resync. Admin full-snapshot frames reconcile removals by
 *    wholesale replace and do not need the tombstone. Removals NEVER travel via
 *    incremental upsert frames.
 *
 * v1.3 changelog (M2 scope, ADDITIVE ONLY):
 *  + NotificationKind gains 'task_assigned' | 'task_unassigned' — reassignment fanout
 *    (M1 review Sev-3): a task.assign notifies the NEW person assignees (task_assigned)
 *    and REMOVED person assignees (task_unassigned). Person-level only; groups/external
 *    subscribers are NOT fanned out on reassignment unless the change also moves times.
 *
 * v1.2 changelog (M1 backend review, ADDITIVE ONLY — zero breaking changes):
 *  + ChangeRequest.rejectionReasonHe (P0 journey 4: proposer must SEE the reason;
 *    audit-only storage hides it from focus workers, who cannot read audit).
 *  + NotificationJob.holdUntil (quiet-hours hold timestamp, N2 mechanism).
 *  + AuditEntityType gains 'dependency' (was mislabeled 'resource').
 *  + Endpoints: POST /v1/tasks/:id/lock, /unlock; GET /v1/audit; GET /v1/notifications.
 *  + Spec note: blocked semantics pinned to corpus behavior (direct dependents of an
 *    anchor are blocked; further downstream computes against unchanged times).
 *
 * v1.1 changelog (resolves QA G0 critique):
 *  C1 ProposedChange widened to all 16 proposable actions (was task-only).
 *  C2 focus-worker delay-report apply rule defined (see rbac-matrix v1.1 reportApplyRule).
 *  C3 StatusReport.clientReportId — client ULID, server dedupe (AC-FR-2).
 *  C4 All datetimes are offset-bearing ISO instants; stored UTC; rendered in EventNode.timezone.
 *  D1 DominoResult.blockedTaskIds pinned (lock-blocked chains, no notifications until resolved).
 *  D2 ResourceNode.capacity marked RESERVED — not enforced by the Alpha engine.
 *  R1 admin S3 = allow (מנהל-על שליטה מלאה); field_manager >=S1 => ChangeRequest.
 *  NodeKind trimmed to graph nodes; audit entity types are a separate union.
 *  ok === false iff at least one BLOCKING conflict (WINDOW_VIOLATION is non-blocking).
 */

// ============================================================
// 1. RESOURCE GRAPH — generic core model
// ============================================================

export type ID = string; // ULID
export type ISODateTime = string; // MUST be offset-bearing instant, e.g. 2026-09-11T13:00:00+03:00. Stored UTC.

/** The four generic resource types. Domain profiles only relabel them. */
export type ResourceKind = 'person' | 'equipment' | 'location' | 'group';

export type NodeKind = 'event' | 'task' | 'resource';

export interface EventNode {
  id: ID;
  kind: 'event';
  orgId: ID;
  domainProfileId: ID;        // e.g. 'camp', 'film-shoot', 'conference'
  name: string;
  date: string;               // ISO date, event-local wall time
  timezone: string;           // IANA, e.g. 'Asia/Jerusalem' — the rendering + working-window timezone
  siteIds: ID[];
  status: 'draft' | 'published' | 'archived';
  version: number;            // optimistic concurrency
}

export interface TaskNode {
  id: ID;
  kind: 'task';
  eventId: ID;
  siteId: ID;
  name: string;
  /** Planned window. start=null means unscheduled. Offset-bearing instant, stored UTC. */
  start: ISODateTime | null;
  durationMin: number;
  status: 'planned' | 'active' | 'done' | 'delayed' | 'cancelled';
  locked: boolean;            // hard constraint: never moved by domino, by any path, any role
  assigneeResourceIds: ID[];  // edge: assigned_to
  version: number;
}

export interface ResourceNode {
  id: ID;
  kind: 'resource';
  eventId: ID;
  resourceKind: ResourceKind;
  name: string;
  /** Exclusivity: a shared exclusive resource double-booked = S2 conflict. */
  exclusive: boolean;
  /** RESERVED — not enforced by the Alpha domino engine (QA D2). Kept for post-Alpha capacity rules. */
  capacity?: number;
  /** For kind=group: member resource ids (edge: member_of). */
  memberIds?: ID[];
  /** External stakeholder channel attached to this node (e.g. parents of a group). */
  subscriberChannelIds?: ID[];
  version: number;
}

export interface DependencyEdge {
  id: ID;
  kind: 'depends_on';
  fromTaskId: ID;             // successor
  toTaskId: ID;               // predecessor (finish-start)
  lagMin: number;             // default 0
  hard: boolean;              // hard dep: violation = conflict, never auto-broken
}

export type GraphNode = EventNode | TaskNode | ResourceNode;

export interface GraphSnapshot {
  event: EventNode;
  tasks: TaskNode[];
  resources: ResourceNode[];
  dependencies: DependencyEdge[]; // MUST be a DAG; validated on every write, 4xx + cycle members on violation
}

// ============================================================
// 2. DOMAIN PROFILE — vocabulary + catalog + rules, zero schema change
// ============================================================

export interface DomainProfile {
  id: ID;
  displayNameHe: string;
  labels: {
    event: string; task: string;
    resource: Record<ResourceKind, string>;
    role: Record<Role, string>;
  };
  catalog: Array<{ resourceKind: ResourceKind; name: string; exclusive: boolean }>;
  taskTemplates: Array<{ name: string; durationMin: number; defaultAssigneeKinds: ResourceKind[] }>;
  rules: {
    maxShiftMin?: number;
    workingWindow?: { startHHMM: string; endHHMM: string };
    externalStakeholderLabel?: string;
    quietHours?: { startHHMM: string; endHHMM: string };  // default 22:00-07:00
  };
  /** Hebrew RTL. Allowlisted {{params}} only — no free interpolation. */
  notificationTemplates: Record<NotificationKind | 'digest_multi_change', string>;
}

// ============================================================
// 3. RBAC — normative matrix: contake-rbac-matrix.v1.1.json (machine-readable)
// ============================================================

export type Role = 'admin' | 'field_manager' | 'focus_worker';

/** Impact classes: approval requirement derives from impact, not role alone. */
export type ImpactClass = 'S0' | 'S1' | 'S2' | 'S3';

/** The 22 actions (see matrix JSON for allow/scope/propose/deny per role). */
export type Action =
  | 'event.create' | 'event.update' | 'event.delete' | 'event.publish'
  | 'task.create' | 'task.update' | 'task.move' | 'task.delete' | 'task.assign'
  | 'resource.create' | 'resource.update' | 'resource.delete'
  | 'dependency.create' | 'dependency.delete'
  | 'constraint.lock' | 'constraint.unlock'
  | 'domino.compute' | 'domino.apply'
  | 'change.approve' | 'change.reject'
  | 'report.status.create'
  | 'notify.send.targeted'
  | 'notify.ack'               // v1.8 — audit completeness for the ack endpoint
  | 'push.subscribe' | 'push.unsubscribe'; // v1.10 — push self-service audit (no matrix rows, v1.8 precedent)

export interface Scope { eventId: ID; siteId?: ID; }

export interface Principal {
  userId: ID; role: Role; scopes: Scope[];
  /** focus_worker maps to exactly one person resource. */
  linkedResourceId?: ID;
}

// ============================================================
// 4. DOMINO ENGINE — pure function contract (isomorphic: server + client preview)
// ============================================================

/** Every proposable action is representable (QA C1). */
export type ProposedChange =
  | { type: 'event.create'; event: Omit<EventNode, 'id' | 'version'> }
  | { type: 'event.update'; eventId: ID; patch: Partial<Pick<EventNode, 'name' | 'date' | 'timezone'>> }
  | { type: 'event.publish'; eventId: ID }
  | { type: 'task.create'; task: Omit<TaskNode, 'id' | 'version'> }
  | { type: 'task.update'; taskId: ID; patch: Partial<Pick<TaskNode, 'name' | 'durationMin' | 'status'>> }
  | { type: 'task.move'; taskId: ID; newStart: ISODateTime }
  | { type: 'task.assign'; taskId: ID; assigneeResourceIds: ID[] }
  | { type: 'task.delete'; taskId: ID }
  | { type: 'resource.create'; resource: Omit<ResourceNode, 'id' | 'version'> }
  | { type: 'resource.update'; resourceId: ID; patch: Partial<Pick<ResourceNode, 'name' | 'exclusive' | 'memberIds' | 'subscriberChannelIds'>> }
  | { type: 'resource.delete'; resourceId: ID }
  | { type: 'dependency.create'; edge: Omit<DependencyEdge, 'id'> }
  | { type: 'dependency.delete'; dependencyId: ID }
  | { type: 'constraint.lock'; taskId: ID }
  | { type: 'constraint.unlock'; taskId: ID }
  | { type: 'domino.apply'; changeRequestId: ID };

export interface Conflict {
  code: 'LOCK_VIOLATION' | 'DEPENDENCY_VIOLATION' | 'DOUBLE_BOOKING' | 'WINDOW_VIOLATION' | 'MAX_SHIFT_EXCEEDED';
  blocking: boolean;          // WINDOW_VIOLATION is the only non-blocking code
  taskIds: ID[];
  resourceIds: ID[];
  messageHe: string;
}

export interface Impact {
  taskId: ID;
  beforeStart: ISODateTime | null;
  afterStart: ISODateTime | null;
  affectedResourceIds: ID[];
  affectedGroupIds: ID[];
  impactClass: ImpactClass;
}

export interface DominoResult {
  /** false iff at least one BLOCKING conflict exists. A blocking proposal cannot apply and notifies nobody. */
  ok: boolean;
  movedTasks: Array<{ taskId: ID; beforeStart: ISODateTime | null; afterStart: ISODateTime }>;
  /** QA D1: tasks that could not be rescheduled because a locked task anchors their chain.
   *  They KEEP their current times, appear here (never in movedTasks), and generate NO
   *  notifications until a human resolves the lock (unlock / move / cancel). */
  blockedTaskIds: ID[];
  impacts: Impact[];
  conflicts: Conflict[];
  maxImpactClass: ImpactClass;
  /** PINNED (QA golden corpus): N counts DEPENDENT tasks only, never the trigger task.
   *  e.g. "אפקט דומינו: 1 משימות תלויות יזוזו (בריכה)" — 1 dependent, trigger excluded. */
  summaryHe: string;
}

/** THE engine signature. Deterministic, pure, synchronous. Server-side compute is
 *  scope-checked: field_manager receives only own-site graph (QA C6). */
export declare function computeDomino(
  graph: GraphSnapshot,
  change: ProposedChange,
  profile: DomainProfile
): DominoResult;

// ============================================================
// 5. CHANGE REQUEST — approval flow
//    proposed -> pending_review -> approved(applied) | rejected
// ============================================================

/** Edit policy (locked, QA AC-RBAC-5): a pending CR is immutable; proposer withdraws
 *  and resubmits as a new CR. Approving against a moved base graph version => 409 stale,
 *  must be re-proposed. Never force-apply. */
export interface ChangeRequest {
  id: ID;
  eventId: ID;
  baseGraphVersion: number;   // event.version at proposal time; approve checks staleness
  proposedBy: ID;
  role: Role;
  change: ProposedChange;
  dominoResult: DominoResult; // computed at proposal time, frozen
  state: 'proposed' | 'pending_review' | 'approved' | 'rejected';
  reasonHe: string;
  /** v1.2: stored ON the CR so the proposer (incl. focus_worker) sees it — audit-only is hidden from them. */
  rejectionReasonHe?: string | null;
  createdAt: ISODateTime;
  resolvedBy?: ID;
  resolvedAt?: ISODateTime;
}

// ============================================================
// 6. FIELD REPORTS (Focus Mode input)
// ============================================================

export interface StatusReport {
  id: ID;                     // server-assigned
  clientReportId: string;     // QA C3: client-generated ULID; server dedupes on it (exactly-once, AC-FR-2)
  taskId: ID;
  reportedBy: ID;
  status: 'on_track' | 'delayed' | 'done' | 'blocked';
  delayMin?: number;          // when delayed => triggers domino.compute
  noteHe?: string;
  clientTimestamp: ISODateTime; // original field time, preserved through offline sync
  createdAt: ISODateTime;       // server receipt time
}
/** Apply authority for delay reports (QA C2, matrix reportApplyRule):
 *  own-task delay, computed impact S0, task unlocked => auto-apply.
 *  Anything above S0 (or locked task) => ChangeRequest pending_review.
 *  A report is NEVER a back-door task.move on another's task or above the reporter's impact. */

// ============================================================
// 7. NOTIFICATIONS — targeted stakeholder sync
// ============================================================

export type NotificationKind = 'task_delayed' | 'task_moved' | 'task_cancelled' | 'change_needs_approval' | 'task_assigned' | 'task_unassigned';
export type NotifyChannel = 'whatsapp' | 'sms' | 'in_app' | 'web_push'; // v1.10: dispatch-time delivery path over in_app targeting

export interface NotificationTarget {
  channel: NotifyChannel;
  address: string;            // phone E.164 or user id for in_app
  recipientLabel: string;
}

export interface NotificationJob {
  id: ID;
  eventId: ID;
  kind: NotificationKind | 'digest_multi_change';
  targets: NotificationTarget[];
  templateKey: string;
  params: Record<string, string>; // allowlisted params only
  idempotencyKey: string;         // eventId+changeRequestId+kind
  batchWindowSec: number;         // 60 — recipient batching window (QA AC-NOT-2)
  /** v1.2: quiet-hours hold — dispatch at this instant (07:00 local), never before. */
  holdUntil?: ISODateTime;
  /** v1.6: shared handled-state for FYI items (esp. failures). Set once via ack endpoint. */
  acknowledgedBy?: ID;
  acknowledgedAt?: ISODateTime;
}

// ============================================================
// 7.4 WEB PUSH — VAPID subscriptions (v1.10)
// ============================================================

/** v1.10: VAPID web-push subscription, per user/device, org-scoped. The push
 *  endpoint and keys are operational secrets — anyone holding them can send to
 *  that device. They are never emitted to another user and never carried in
 *  realtime frames (QA-M2-3 analog; same leak class as subscriberChannelIds). */
export interface PushSubscription {
  id: ID;
  orgId: ID;
  userId: ID;
  endpoint: string;            // unique per browser+device; client re-registers on pushsubscriptionchange
  keys: { p256dh: string; auth: string };
  deviceClass?: string;        // ua-derived, display-only in settings
  createdAt: ISODateTime;
  lastUsedAt?: ISODateTime;
}

// ============================================================
// 7.5 AUDIT LOG — append-only, every mutation (QA §9)
// ============================================================

export type AuditEntityType = NodeKind | 'user' | 'change_request' | 'notification' | 'dependency'
  | 'push_subscription';       // v1.10

export interface AuditLogEntry {
  id: ID;
  orgId: ID;
  eventId: ID;
  actorUserId: ID;
  role: Role;
  action: Action;
  entityType: AuditEntityType;
  entityId: ID;
  beforeJson: string | null;
  afterJson: string | null;
  changeRequestId?: ID;
  deviceClass?: string;       // ua-derived; IP recorded as out-of-Alpha (QA Sev-4)
  createdAt: ISODateTime;
  /** v1.9: absent/'applied' = the mutation happened; 'denied' = authz failure trace. */
  outcome?: 'applied' | 'denied';
  denialReason?: string;      // machine code, e.g. 'matrix_deny' | 'scope_violation'
}
// DB-level enforcement: no UPDATE/DELETE grants on audit_log for the app role.

// ============================================================
// 7.6 REALTIME FRAMES — typed wire shapes (v1.5)
// ============================================================

export interface GraphPatchFrame {
  type: 'graph.patch';
  eventId: ID;
  version: number;
  siteId?: string;                 // present on site-room frames
  tasks: TaskNode[];
  dependencies: DependencyEdge[];
  resources: ResourceNode[];       // subscriber-stripped for non-admin rooms (QA-M2-3)
}

export interface GraphRemoveFrame {
  type: 'graph.remove';
  eventId: ID;
  version: number;                 // same sequence as graph.patch
  taskIds: ID[];
  siteId?: string;                 // present on site-room frames, absent on user-room frames
}

export interface ChangePendingFrame { type: 'change.pending'; changeRequest: ChangeRequest; }
export interface ChangeResolvedFrame { type: 'change.resolved'; changeRequest: ChangeRequest; }
export interface ReportNewFrame { type: 'report.new'; report: StatusReport; siteId: ID; }
export interface NotifyFailedFrame { type: 'notify.failed'; jobId: ID; address: string; error: string; }
export interface NotifyAckedFrame { type: 'notify.acked'; jobId: ID; acknowledgedBy: ID; acknowledgedAt: ISODateTime; }

export type RealtimeFrame =
  | GraphPatchFrame | GraphRemoveFrame
  | ChangePendingFrame | ChangeResolvedFrame
  | ReportNewFrame | NotifyFailedFrame | NotifyAckedFrame;

// ============================================================
// 8. API CONTRACT (REST, prefix /v1) + realtime events
// ============================================================

/**
 * REST endpoints (all scoped by Principal; mutations return ChangeRequest when approval required):
 *   GET    /v1/events
 *   POST   /v1/events                              event.create
 *   GET    /v1/events/:id/graph                    GraphSnapshot (role-filtered: focus_worker gets own tasks only)
 *   PATCH  /v1/events/:id                          event.update        [QA C5]
 *   DELETE /v1/events/:id                          event.delete        [QA C5]
 *   POST   /v1/events/:id/publish                  event.publish       [QA C5]
 *   POST   /v1/events/:id/tasks                    task.create
 *   PATCH  /v1/tasks/:id                           task.update/move/assign -> { applied } | { changeRequest }
 *   DELETE /v1/tasks/:id                           task.delete
 *   POST   /v1/events/:id/resources                resource.create
 *   PATCH  /v1/resources/:id                       resource.update     [QA C5]
 *   DELETE /v1/resources/:id                       resource.delete     [QA C5]
 *   POST   /v1/events/:id/dependencies             dependency.create (400 on cycle, Hebrew error names members)
 *   DELETE /v1/dependencies/:id                    dependency.delete   [QA C5]
 *   POST   /v1/domino/compute                      dry-run; scope-checked (field_manager: own sites only) [QA C6]
 *   POST   /v1/changes/:id/approve                 change.approve (admin; 409 on stale baseGraphVersion)
 *   POST   /v1/changes/:id/reject                  change.reject (admin)
 *   GET    /v1/changes?eventId=&state=             pending approvals queue
 *   POST   /v1/reports                             report.status.create; dedupe on clientReportId
 *   POST   /v1/tasks/:id/lock                      constraint.lock       [v1.2]
 *   POST   /v1/tasks/:id/unlock                    constraint.unlock     [v1.2]
 *   GET    /v1/audit?eventId=                      audit read (admin full; field_manager site-scoped) [v1.2, QA AC-AUD-3]
 *   GET    /v1/notifications?eventId=              notification jobs (admin only) [v1.2]
 *   POST   /v1/notify-jobs/:id/ack                 notify.ack (admin only; idempotent — re-ack 200s with existing ack) [v1.6]
 *   GET    /v1/push/vapid-public-key               { publicKey } — authenticated, any role [v1.10]
 *   POST   /v1/push/subscriptions                  upsert own subscription (idempotent on endpoint) [v1.10]
 *   GET    /v1/push/subscriptions                  own subscriptions only [v1.10]
 *   DELETE /v1/push/subscriptions                  delete own subscription; other user's endpoint -> 403 + denied audit [v1.10]
 *   GET    /v1/profiles
 *   POST   /v1/auth/otp/request  POST /v1/auth/otp/verify   (focus workers)
 *   POST   /v1/auth/login  POST /v1/auth/refresh            (managers)
 *
 * Realtime (Socket.IO rooms): event:{eventId} for managers, user:{userId} for focus workers.
 *   server -> client: 'graph.patch' { tasks: TaskNode[] }, 'graph.remove' { eventId, version, taskIds } [v1.4],
 *                     'change.pending' ChangeRequest,
 *                     'change.resolved' ChangeRequest, 'report.new' StatusReport,
 *                     'notify.failed' { jobId, address, error }, 'notify.acked' { jobId, acknowledgedBy, acknowledgedAt } [v1.6, room = adminsRoom(orgId) v1.7]
 *   client -> server: none (all writes via REST)
 *
 * Errors: { error: { code: string, messageHe: string } }, HTTP 4xx/5xx.
 */
