import type {
  AuditLogEntry, Branch, ChangeRequest, ContentAck, ContentItem, ContentItemVersion, DependencyEdge, EventNode,
  ExternalParty, GraphSnapshot, ID, IdempotencyRecord, NotificationJob, OptoutSuppression, Principal, PushSubscription, ReportReadState,
  ResourceNode, Role, StatusReport, StatusToken, TaskNode, TaskResourceLink,
  WhitelistEntry, WhitelistStatus,
  AdvanceProposal, AdvanceOutbox, ISODateTime,
} from '@contake/core';

/** Authenticated user record (the Principal plus login material). */
export interface UserRecord extends Principal {
  orgId: ID;
  name: string;
  email?: string;
  phone?: string;
  /** Dev-grade password hash (scrypt). OTP codes are kept separately. */
  passwordHash?: string;
  active: boolean;
}

export interface ChannelRecord {
  id: ID;            // subscriberChannelId, e.g. ch-parent-1
  orgId: ID;
  address: string;   // E.164 phone
  label: string;
  optedOut?: boolean; // ND-5: STOP disconnects the channel
}

/** Storage contract (architecture §2: Postgres/Prisma later, behind THIS interface). */
/** Durable idempotency backstop (QA QM3 2026-09-17): clientReportId is unique
 *  across the reports table; adapters raise this on a uniqueness race so the
 *  route can resolve replay-or-conflict against the winner row. */
export class ReportClientIdConflictError extends Error {
  constructor() { super('REPORT_CLIENT_ID_CONFLICT'); this.name = 'ReportClientIdConflictError'; }
}

export interface GraphRepository {
  // users & channels
  createUser(u: UserRecord): Promise<UserRecord>;
  getUser(userId: ID): Promise<UserRecord | undefined>;
  findUserByEmail(email: string): Promise<UserRecord | undefined>;
  findUserByPhone(phone: string): Promise<UserRecord | undefined>;
  updateUser(userId: ID, patch: Partial<UserRecord>): Promise<UserRecord | undefined>;
  listUsers(orgId: ID): Promise<UserRecord[]>;
  createChannel(c: ChannelRecord): Promise<ChannelRecord>;
  getChannel(id: ID): Promise<ChannelRecord | undefined>;
  findChannelByAddress(address: string): Promise<ChannelRecord | undefined>;
  updateChannel(id: ID, patch: Partial<ChannelRecord>): Promise<ChannelRecord | undefined>;
  updateUser(userId: ID, patch: Partial<UserRecord>): Promise<UserRecord | undefined>;
  listNotificationJobsAll(): Promise<NotificationJob[]>;
  /** QA-M2-4/PR-1 atomicity support: a mutation+audit unit runs between
   *  checkpoint() and commit()/restore(). Postgres: real BEGIN/COMMIT/ROLLBACK. */
  checkpoint?(): Promise<unknown>;
  commit?(cp: unknown): Promise<void>;
  restore?(cp: unknown): Promise<void>;
  /** Preferred atomic-unit protocol (PR-1): run fn inside a transaction with the
   *  tx client bound via AsyncLocalStorage.run, so every continuation of fn —
   *  including fire-and-forget subscribers — sees the ambient tx. Nested calls
   *  flatten into the outer tx. Adapters without runInTx use checkpoint/commit/restore. */
  runInTx?<T>(fn: () => Promise<T>): Promise<T>;

  // events & graph
  createEvent(e: EventNode): Promise<EventNode>;
  getEvent(id: ID): Promise<EventNode | undefined>;
  updateEvent(id: ID, patch: Partial<EventNode>): Promise<EventNode | undefined>;
  listEvents(orgId: ID): Promise<EventNode[]>;
  /** Full snapshot for an event (engine input). */
  snapshot(eventId: ID): Promise<GraphSnapshot | undefined>;
  /** Atomic compare-and-set on the event version: fails if event.version !== expected. */
  bumpEventVersion(id: ID, expected: number): Promise<boolean>;

  createTask(t: TaskNode): Promise<TaskNode>;
  getTask(id: ID): Promise<TaskNode | undefined>;
  listTasks(eventId: ID): Promise<TaskNode[]>;
  /** All-or-nothing batch apply (QA AC-DOM-7). Returns false and writes nothing
   *  if any id is missing or any version mismatches. */
  applyTaskUpdates(updates: { id: ID; expectedVersion: number; patch: Partial<TaskNode> }[]): Promise<boolean>;

  createResource(r: ResourceNode): Promise<ResourceNode>;
  getResource(id: ID): Promise<ResourceNode | undefined>;
  updateResource(id: ID, patch: Partial<ResourceNode>): Promise<ResourceNode | undefined>;
  listResources(eventId: ID): Promise<ResourceNode[]>;

  createDependency(d: DependencyEdge): Promise<DependencyEdge>;
  getDependency(id: ID): Promise<DependencyEdge | undefined>;
  deleteDependency(id: ID): Promise<boolean>;
  /** QA-M2-7: removes the event and its cascade (tasks, their dependencies,
   *  change requests, status reports, notification jobs). */
  deleteEvent(id: ID): Promise<boolean>;
  /** Hard-deletes a task and its dependency edges. Precondition: QA-M1-3 gate passed. */
  deleteTask(id: ID): Promise<boolean>;
  listDependencies(eventId: ID): Promise<DependencyEdge[]>;

  // change requests
  createChangeRequest(cr: ChangeRequest): Promise<ChangeRequest>;
  getChangeRequest(id: ID): Promise<ChangeRequest | undefined>;
  updateChangeRequest(id: ID, patch: Partial<ChangeRequest>): Promise<ChangeRequest | undefined>;
  listChangeRequests(filter: { eventId?: ID; state?: string }): Promise<ChangeRequest[]>;

  // field reports (dedupe on clientReportId, QA C3/AC-FR-2)
  createReport(r: StatusReport): Promise<StatusReport>;
  getReportByClientId(clientReportId: string): Promise<StatusReport | undefined>;
  listReports(eventId: ID): Promise<StatusReport[]>;
  getReport(id: ID): Promise<StatusReport | undefined>;
  /** v1.12: write-once handled-state (ack-style idempotency): applied=false when
   *  already resolved - a re-resolve never overwrites and never re-audits. */
  resolveReport(id: ID, by: ID, at: string, noteHe?: string): Promise<{ report: StatusReport; applied: boolean } | undefined>;
  /** v1.21.2 §26.1א: CAS correction - returns 'conflict' on stale expectedVersion,
   *  undefined when the report does not exist. */
  correctReport(id: ID, expectedVersion: number, patch: { actualFinishAt: ISODateTime; lastCorrection: { reason: string; at: ISODateTime; by: ID } }): Promise<StatusReport | 'conflict' | undefined>;
  /** v1.21.2 §26: advance proposals + durable outbox. */
  createAdvanceProposal(p: AdvanceProposal): Promise<AdvanceProposal>;
  getAdvanceProposal(id: ID): Promise<AdvanceProposal | undefined>;
  listAdvanceProposals(eventId: ID): Promise<AdvanceProposal[]>;
  updateAdvanceProposal(id: ID, patch: Partial<Pick<AdvanceProposal, 'status'>>): Promise<AdvanceProposal | undefined>;
  /** Natural-key reuse: an identical open proposal for the same compute input. */
  findOpenAdvanceProposal(eventId: ID, anchorTaskId: ID, actualFinishAt: ISODateTime, graphVersion: number): Promise<AdvanceProposal | undefined>;
  markProposalsStaleForReport(reportId: ID): Promise<ID[]>;
  createAdvanceOutbox(o: AdvanceOutbox): Promise<AdvanceOutbox>;
  listPendingAdvanceOutbox(): Promise<AdvanceOutbox[]>;
  markAdvanceOutboxMaterialized(id: ID): Promise<void>;

  // notification jobs (recorder; sandbox dispatch lands at M3)
  createNotificationJob(j: NotificationJob): Promise<NotificationJob>;
  getNotificationJob(id: ID): Promise<NotificationJob | undefined>;
  getNotificationJobByIdempotencyKey(key: string): Promise<NotificationJob | undefined>;
  /** PR-3 (contracts v1.6): ack fields are write-once — a patch that would
   *  overwrite an existing acknowledgedBy is a no-op returning the current job,
   *  so concurrent first-acks never clobber each other (idempotent ack). */
  updateNotificationJob(id: ID, patch: Partial<NotificationJob>): Promise<NotificationJob | undefined>;
  /** PR-3 / TL Sev-3: the ack check-and-set as ONE atomic primitive. applied=true
   *  only for the actual first-ack writer; concurrent racers (even same admin,
   *  same millisecond) get applied=false, so audit rows and frames never duplicate
   *  in EITHER adapter. */
  ackNotificationJob(id: ID, by: ID, at: string): Promise<{ job: NotificationJob; applied: boolean } | undefined>;
  listNotificationJobs(eventId: ID): Promise<NotificationJob[]>;

  // push subscriptions (contracts v1.10): owner-scoped, upsert idempotent on endpoint.
  upsertPushSubscription(s: PushSubscription): Promise<PushSubscription>;
  getPushSubscriptionByEndpoint(endpoint: string): Promise<PushSubscription | undefined>;
  listPushSubscriptions(userId: ID): Promise<PushSubscription[]>;
  /** Owner-guarded delete (routes). */
  deletePushSubscription(userId: ID, endpoint: string): Promise<boolean>;
  /** Unguarded delete for the dispatcher's 404/410 dead-subscription cleanup. */
  deletePushSubscriptionByEndpoint(endpoint: string): Promise<boolean>;

  // whitelist onboarding (contracts v1.18 §15): one row per phone, globally unique.
  /** Upsert on phone - invite reset and seed share this path (idempotent). */
  upsertWhitelistEntry(e: WhitelistEntry): Promise<WhitelistEntry>;
  /** Create/invite-only atomic primitive (QA 2026-09-17, register
   *  exactly-one-winner): plain INSERT semantics - NEVER overwrites an
   *  existing row. Explicit outcome: 'created' = this call won the row;
   *  'exists' = a row was already there (concurrent loser or pre-existing);
   *  callers classify tenant-safety by the returned entry's orgId. Runs
   *  inside the caller's withWhitelistMutation unit (PG: same tx).
   *  upsertWhitelistEntry stays for the decide/registration CAS paths. */
  createWhitelistInvite(e: WhitelistEntry): Promise<{ outcome: 'created' | 'exists'; entry: WhitelistEntry }>;
  getWhitelistEntry(phone: string): Promise<WhitelistEntry | undefined>;
  /** QA round-5 CAS registration primitive: atomically transition ONLY a
   *  status='invited' entry and append the committed auth_audit row for the
   *  winner alone. 'applied' = this call won the transition; 'duplicate' =
   *  the entry was no longer invited (concurrent winner or other state) and
   *  nothing was written. Identical semantics on both adapters:
   *  PG = UPDATE ... WHERE status='invited' + INSERT in one tx; memory = one
   *  synchronous CAS + AWAITED winner-only audit sink: a rejecting sink is
   *  caught and rolls back the exact prior object (QA round-6: the sink is
   *  async so no Promise rejection can escape the try/catch; AuthService
   *  serializes same-phone calls across the await). `appendAudit` is the
   *  memory path's winner-only audit sink; PG ignores it (own INSERT). */
  commitWhitelistRegistration(
    entry: WhitelistEntry,
    audit: { phone: string; kind: string; detail?: unknown },
    appendAudit?: (a: { phone: string; kind: string; detail?: unknown }) => void | Promise<void>,
  ): Promise<'applied' | 'duplicate'>;

  /** Repository transition primitive (round 8): run fn with the phone's
   *  whitelist row exclusively held, and every read/write inside fn in the
   *  SAME unit - memory: the per-phone mutex; PG: ONE transaction opened
   *  around fn with SELECT ... FOR UPDATE on the row, nested withAuditSafety
   *  and all repo writes sharing the same tx client via the ambient scope.
   *  invite / approve / reject route through it, so a status check and its
   *  writes can never be interleaved by a concurrent decision. fn receives
   *  the exclusively-held entry (undefined when none). */
  withWhitelistMutation<T>(phone: string, fn: (locked: WhitelistEntry | undefined) => Promise<T>): Promise<T>;
  listWhitelist(orgId: ID, status?: WhitelistStatus): Promise<WhitelistEntry[]>;

  // audit (append-only by construction: no update/delete methods exist, QA AC-AUD-2)
  appendAudit(e: AuditLogEntry): Promise<void>;
  listAudit(orgId: ID): Promise<AuditLogEntry[]>;

  // v1.20 §20 content surface
  createContentItem(c: ContentItem): Promise<ContentItem>;
  getContentItem(id: ID): Promise<ContentItem | undefined>;
  updateContentItem(id: ID, patch: Partial<ContentItem>): Promise<ContentItem | undefined>;
  /** v1.20.2 CAS head advance: returns undefined when current version !== expectedVersion. */
  casUpdateContentItem(id: ID, expectedVersion: number, patch: Partial<ContentItem>): Promise<ContentItem | undefined | 'conflict'>;
  deleteContentItem(id: ID): Promise<boolean>;
  listContentItems(orgId: ID): Promise<ContentItem[]>;
  // v1.20.2 immutable content versions (never deleted)
  createContentVersion(v: ContentItemVersion): Promise<ContentItemVersion>;
  listContentVersions(contentId: ID): Promise<ContentItemVersion[]>;
  getContentVersion(contentId: ID, contentVersionId: ID): Promise<ContentItemVersion | undefined>;
  attachTaskContent(l: TaskResourceLink): Promise<TaskResourceLink>;
  detachTaskContent(taskId: ID, contentId: ID): Promise<boolean>;
  listTaskContent(taskId: ID): Promise<TaskResourceLink[]>;
  createContentAck(a: ContentAck & { orgId: ID }): Promise<ContentAck>;
  /** v1.20.2: ack dedupe is isolated per org+actor (was global on clientAckId). */
  getContentAck(orgId: ID, userId: ID, clientAckId: string): Promise<ContentAck | undefined>;
  // v1.20 §22 stakeholders (+ §22 G6 status tokens)
  createExternalParty(p: ExternalParty): Promise<ExternalParty>;
  getExternalParty(id: ID): Promise<ExternalParty | undefined>;
  updateExternalParty(id: ID, patch: Partial<ExternalParty>): Promise<ExternalParty | undefined>;
  deleteExternalParty(id: ID): Promise<boolean>;
  listExternalParties(orgId: ID): Promise<ExternalParty[]>;
  createStatusToken(t: StatusToken): Promise<StatusToken>;
  getStatusToken(id: ID): Promise<StatusToken | undefined>;
  /** v1.20.2: lookup by HMAC hash (indexed column); plaintext never hits the repo. */
  getStatusTokenByHash(tokenHash: string): Promise<StatusToken | undefined>;
  findExternalPartyByContactRef(value: string): Promise<ExternalParty | undefined>;
  updateStatusToken(id: ID, patch: Partial<StatusToken>): Promise<StatusToken | undefined>;
  // v1.20 §23 branches
  createBranch(b: Branch): Promise<Branch>;
  getBranch(id: ID): Promise<Branch | undefined>;
  updateBranch(id: ID, patch: Partial<Branch>): Promise<Branch | undefined>;
  listBranches(orgId: ID): Promise<Branch[]>;
  // v1.20 §24 report read state
  markReportRead(s: ReportReadState): Promise<ReportReadState>;
  getReportReadState(reportId: ID, userId: ID): Promise<ReportReadState | undefined>;
  listReportReadStates(userId: ID): Promise<ReportReadState[]>;
  // v1.20.2 opt-out suppressions (machine-principal writes; org-admin scoped removal)
  createOptoutSuppression(x: OptoutSuppression): Promise<OptoutSuppression>;
  /** active suppression for (channel, address): org-scoped for orgId OR global-ambiguous (orgId null). */
  findActiveSuppression(channel: string, address: string, orgId?: ID): Promise<OptoutSuppression | undefined>;
  listOptoutSuppressions(orgId?: ID): Promise<OptoutSuppression[]>;
  removeOptoutSuppression(id: ID, by: ID, reason: string, at: string): Promise<OptoutSuppression | undefined>;
  // v1.20.2 per-route idempotency records (same-tx write; PG UNIQUE enforced)
  getIdempotencyRecord(orgId: ID, actorId: ID, route: string, clientMutationId: string): Promise<IdempotencyRecord | undefined>;
  putIdempotencyRecord(r: IdempotencyRecord): Promise<IdempotencyRecord>;
}

export interface SeedData {
  orgId: ID;
  users: UserRecord[];
  channels: ChannelRecord[];
  events: EventNode[];
  tasks: TaskNode[];
  resources: ResourceNode[];
  dependencies: DependencyEdge[];  whitelist?: WhitelistEntry[];
}

export type { Role };
