import type {
  AuditLogEntry, ChangeRequest, DependencyEdge, EventNode, GraphSnapshot, ID,
  NotificationJob, PushSubscription, ResourceNode, StatusReport, TaskNode,
  WhitelistEntry, WhitelistStatus,
} from '@contake/core';
import type { ChannelRecord, GraphRepository, SeedData, UserRecord } from './graph-repository.js';

/** In-memory GraphRepository (M1). Atomic batch semantics mirror the future
 *  Postgres transaction: validate everything, then commit (QA AC-DOM-7). */
export class MemoryGraphRepository implements GraphRepository {
  private users = new Map<ID, UserRecord>();
  private channels = new Map<ID, ChannelRecord>();
  private events = new Map<ID, EventNode>();
  private tasks = new Map<ID, TaskNode>();
  private resources = new Map<ID, ResourceNode>();
  private dependencies = new Map<ID, DependencyEdge>();
  private changeRequests = new Map<ID, ChangeRequest>();
  private reports = new Map<ID, StatusReport>();
  private notificationJobs = new Map<ID, NotificationJob>();
  private pushSubscriptions = new Map<string, PushSubscription>(); // keyed by endpoint (v1.10)
  private whitelist = new Map<string, WhitelistEntry>(); // keyed by phone (v1.18)
  private auditLog: AuditLogEntry[] = [];

  static seeded(data: SeedData): MemoryGraphRepository {
    const repo = new MemoryGraphRepository();
    for (const u of data.users) repo.createUser(u);
    for (const c of data.channels) repo.createChannel(c);
    for (const e of data.events) repo.createEvent(e);
    for (const r of data.resources) repo.createResource(r);
    for (const t of data.tasks) repo.createTask(t);
    for (const d of data.dependencies) repo.createDependency(d);
    for (const w of data.whitelist ?? []) repo.upsertWhitelistEntry(w);
    return repo;
  }

  async createUser(u: UserRecord): Promise<UserRecord> { this.users.set(u.userId, u); return u; }
  async getUser(userId: ID): Promise<UserRecord | undefined> { return this.users.get(userId); }
  async findUserByEmail(email: string): Promise<UserRecord | undefined> {
    return [...this.users.values()].find(u => u.email === email);
  }
  async findUserByPhone(phone: string): Promise<UserRecord | undefined> {
    return [...this.users.values()].find(u => u.phone === phone);
  }
  async updateUser(userId: ID, patch: Partial<UserRecord>): Promise<UserRecord | undefined> {
    const cur = this.users.get(userId);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, userId: cur.userId, orgId: cur.orgId };
    this.users.set(userId, next);
    return next;
  }
  async listUsers(orgId: ID): Promise<UserRecord[]> { return [...this.users.values()].filter(u => u.orgId === orgId); }

  // whitelist onboarding (v1.18 §15)
  async upsertWhitelistEntry(e: WhitelistEntry): Promise<WhitelistEntry> { this.whitelist.set(e.phone, e); return e; }
  async getWhitelistEntry(phone: string): Promise<WhitelistEntry | undefined> { return this.whitelist.get(phone); }
  /** QA round-7: per-phone promise-chain mutex. EVERY whitelist mutation
   *  (invite, register CAS, approve, reject) runs through it, so a mutation
   *  starts only after the previous one for the same phone fully settled.
   *  The sink await inside the registration CAS is a yield point; without
   *  this lock an admin mutation could interleave and the CAS rollback could
   *  restore over the admin's later state. Chain tails self-clean. */
  private readonly wlLocks = new Map<string, Promise<void>>();

  async withWhitelistLock<T>(phone: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.wlLocks.get(phone) ?? Promise.resolve();
    const result = prev.then(() => fn());
    const tail = result.then(() => undefined, () => undefined);
    this.wlLocks.set(phone, tail);
    void tail.then(() => { if (this.wlLocks.get(phone) === tail) this.wlLocks.delete(phone); });
    return result;
  }

  /** QA round-7: CAS - invited -> entry, one winner only, serialized per
   *  phone through withWhitelistLock. The winner's committed audit row is
   *  appended via the AWAITED sink inside the same unit: a REJECTING sink
   *  (Promise.reject included) is caught here and rolls back the EXACT prior
   *  entry object, never a reconstruction - no stale rollback, no escaped
   *  rejection, and the rollback always lands BEFORE any queued admin
   *  mutation for the phone. A loser never mutates anything. */
  async commitWhitelistRegistration(
    entry: WhitelistEntry,
    audit: { phone: string; kind: string; detail?: unknown },
    appendAudit?: (a: { phone: string; kind: string; detail?: unknown }) => void | Promise<void>,
  ): Promise<'applied' | 'duplicate'> {
    return this.withWhitelistLock(entry.phone, async () => {
      const cur = this.whitelist.get(entry.phone);
      if (!cur || cur.status !== 'invited') return 'duplicate';
      this.whitelist.set(entry.phone, entry);
      try {
        await appendAudit?.(audit);
      } catch (e) {
        this.whitelist.set(entry.phone, cur);
        throw e;
      }
      return 'applied';
    });
  }
  async listWhitelist(orgId: ID, status?: WhitelistStatus): Promise<WhitelistEntry[]> {
    return [...this.whitelist.values()].filter(e => e.orgId === orgId && (!status || e.status === status));
  }

  async createChannel(c: ChannelRecord): Promise<ChannelRecord> { this.channels.set(c.id, c); return c; }
  async getChannel(id: ID): Promise<ChannelRecord | undefined> { return this.channels.get(id); }
  async findChannelByAddress(address: string): Promise<ChannelRecord | undefined> {
    return [...this.channels.values()].find(c => c.address === address);
  }
  async updateChannel(id: ID, patch: Partial<ChannelRecord>): Promise<ChannelRecord | undefined> {
    const cur = this.channels.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    this.channels.set(id, next);
    return next;
  }
  async listNotificationJobsAll(): Promise<NotificationJob[]> { return [...this.notificationJobs.values()]; }

  /** QA-M2-4: full-state checkpoint/restore so an audit-write failure (or any
   *  mid-mutation error) rolls the graph back instead of failing half-applied. */
  async checkpoint(): Promise<string> {
    return JSON.stringify({
      users: [...this.users], channels: [...this.channels], events: [...this.events],
      tasks: [...this.tasks], resources: [...this.resources], dependencies: [...this.dependencies],
      changeRequests: [...this.changeRequests], reports: [...this.reports],
      notificationJobs: [...this.notificationJobs], pushSubscriptions: [...this.pushSubscriptions], auditLog: this.auditLog,
    });
  }
  async commit(_cp: string): Promise<void> { /* in-memory: nothing to commit */ }
  async restore(cp: string): Promise<void> {
    const d = JSON.parse(cp) as Record<string, [string, never][]>;
    this.users = new Map(d['users']!); this.channels = new Map(d['channels']!);
    this.events = new Map(d['events']!); this.tasks = new Map(d['tasks']!);
    this.resources = new Map(d['resources']!); this.dependencies = new Map(d['dependencies']!);
    this.changeRequests = new Map(d['changeRequests']!); this.reports = new Map(d['reports']!);
    this.notificationJobs = new Map(d['notificationJobs']!); this.auditLog = d['auditLog'] as never[] as typeof this.auditLog;
    this.pushSubscriptions = new Map((d['pushSubscriptions'] ?? []) as [string, PushSubscription][]);
  }

  async createEvent(e: EventNode): Promise<EventNode> { this.events.set(e.id, e); return e; }
  async getEvent(id: ID): Promise<EventNode | undefined> { return this.events.get(id); }
  async updateEvent(id: ID, patch: Partial<EventNode>): Promise<EventNode | undefined> {
    const cur = this.events.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id: cur.id, orgId: cur.orgId, version: cur.version + 1 };
    this.events.set(id, next);
    return next;
  }
  async listEvents(orgId: ID): Promise<EventNode[]> { return [...this.events.values()].filter(e => e.orgId === orgId); }
  async snapshot(eventId: ID): Promise<GraphSnapshot | undefined> {
    const event = this.events.get(eventId);
    if (!event) return undefined;
    return {
      event,
      tasks: await this.listTasks(eventId),
      resources: await this.listResources(eventId),
      dependencies: await this.listDependencies(eventId),
    };
  }
  async bumpEventVersion(id: ID, expected: number): Promise<boolean> {
    const cur = this.events.get(id);
    if (!cur || cur.version !== expected) return false;
    this.events.set(id, { ...cur, version: cur.version + 1 });
    return true;
  }

  async createTask(t: TaskNode): Promise<TaskNode> { this.tasks.set(t.id, t); return t; }
  async getTask(id: ID): Promise<TaskNode | undefined> { return this.tasks.get(id); }
  async listTasks(eventId: ID): Promise<TaskNode[]> { return [...this.tasks.values()].filter(t => t.eventId === eventId); }
  async applyTaskUpdates(updates: { id: ID; expectedVersion: number; patch: Partial<TaskNode> }[]): Promise<boolean> {
    const staged: [ID, TaskNode][] = [];
    for (const u of updates) {
      const cur = this.tasks.get(u.id);
      if (!cur || cur.version !== u.expectedVersion) return false; // nothing written
      staged.push([u.id, { ...cur, ...u.patch, id: cur.id, eventId: cur.eventId, version: cur.version + 1 }]);
    }
    for (const [id, next] of staged) this.tasks.set(id, next);
    return true;
  }

  async createResource(r: ResourceNode): Promise<ResourceNode> { this.resources.set(r.id, r); return r; }
  async getResource(id: ID): Promise<ResourceNode | undefined> { return this.resources.get(id); }
  async updateResource(id: ID, patch: Partial<ResourceNode>): Promise<ResourceNode | undefined> {
    const cur = this.resources.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id: cur.id, version: cur.version + 1 };
    this.resources.set(id, next);
    return next;
  }
  async listResources(eventId: ID): Promise<ResourceNode[]> { return [...this.resources.values()].filter(r => r.eventId === eventId); }

  async createDependency(d: DependencyEdge): Promise<DependencyEdge> { this.dependencies.set(d.id, d); return d; }
  async getDependency(id: ID): Promise<DependencyEdge | undefined> { return this.dependencies.get(id); }
  async deleteTask(id: ID): Promise<boolean> {
    const existed = this.tasks.delete(id);
    for (const [depId, e] of [...this.dependencies]) {
      if (e.fromTaskId === id || e.toTaskId === id) this.dependencies.delete(depId);
    }
    return existed;
  }

  async deleteDependency(id: ID): Promise<boolean> { return this.dependencies.delete(id); }

  async deleteEvent(id: ID): Promise<boolean> {
    if (!this.events.delete(id)) return false;
    const taskIds = new Set([...this.tasks.values()].filter(t => t.eventId === id).map(t => t.id));
    for (const tid of taskIds) this.tasks.delete(tid);
    for (const [depId, dep] of [...this.dependencies]) {
      if (taskIds.has(dep.fromTaskId) || taskIds.has(dep.toTaskId)) this.dependencies.delete(depId);
    }
    for (const [crId, cr] of [...this.changeRequests]) if (cr.eventId === id) this.changeRequests.delete(crId);
    for (const [rId, r] of [...this.reports]) if (taskIds.has(r.taskId)) this.reports.delete(rId);
    for (const [jId, j] of [...this.notificationJobs]) if (j.eventId === id) this.notificationJobs.delete(jId);
    return true;
  }
  async listDependencies(eventId: ID): Promise<DependencyEdge[]> {
    const taskIds = new Set((await this.listTasks(eventId)).map(t => t.id));
    return [...this.dependencies.values()].filter(d => taskIds.has(d.fromTaskId) && taskIds.has(d.toTaskId));
  }

  async createChangeRequest(cr: ChangeRequest): Promise<ChangeRequest> { this.changeRequests.set(cr.id, cr); return cr; }
  async getChangeRequest(id: ID): Promise<ChangeRequest | undefined> { return this.changeRequests.get(id); }
  async updateChangeRequest(id: ID, patch: Partial<ChangeRequest>): Promise<ChangeRequest | undefined> {
    const cur = this.changeRequests.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id: cur.id };
    this.changeRequests.set(id, next);
    return next;
  }
  async listChangeRequests(filter: { eventId?: ID; state?: string }): Promise<ChangeRequest[]> {
    return [...this.changeRequests.values()].filter(cr =>
      (filter.eventId === undefined || cr.eventId === filter.eventId)
      && (filter.state === undefined || cr.state === filter.state));
  }

  async createReport(r: StatusReport): Promise<StatusReport> { this.reports.set(r.id, r); return r; }
  async getReportByClientId(clientReportId: string): Promise<StatusReport | undefined> {
    return [...this.reports.values()].find(r => r.clientReportId === clientReportId);
  }
  async listReports(eventId: ID): Promise<StatusReport[]> {
    const taskIds = new Set((await this.listTasks(eventId)).map(t => t.id));
    return [...this.reports.values()].filter(r => taskIds.has(r.taskId));
  }
  async getReport(id: ID): Promise<StatusReport | undefined> { return this.reports.get(id); }
  async resolveReport(id: ID, by: ID, at: string, noteHe?: string): Promise<{ report: StatusReport; applied: boolean } | undefined> {
    // No awaits inside: check-and-set is atomic on the JS runloop (ack pattern).
    const cur = this.reports.get(id);
    if (!cur) return undefined;
    if (cur.resolvedBy !== undefined) return { report: cur, applied: false };
    const next = { ...cur, resolvedBy: by, resolvedAt: at, ...(noteHe ? { resolutionNoteHe: noteHe } : {}) };
    this.reports.set(id, next);
    return { report: next, applied: true };
  }

  async createNotificationJob(j: NotificationJob): Promise<NotificationJob> { this.notificationJobs.set(j.id, j); return j; }
  async getNotificationJob(id: ID): Promise<NotificationJob | undefined> { return this.notificationJobs.get(id); }
  async updateNotificationJob(id: ID, patch: Partial<NotificationJob>): Promise<NotificationJob | undefined> {
    const cur = this.notificationJobs.get(id);
    if (!cur) return undefined;
    if (cur.acknowledgedBy !== undefined && patch.acknowledgedBy !== undefined) return cur; // ack write-once
    const next = { ...cur, ...patch, id: cur.id };
    this.notificationJobs.set(id, next);
    return next;
  }
  async ackNotificationJob(id: ID, by: ID, at: string): Promise<{ job: NotificationJob; applied: boolean } | undefined> {
    // No awaits inside: the check-and-set is atomic on the JS runloop, so
    // concurrent first-acks serialize exactly like PG's SELECT FOR UPDATE.
    const cur = this.notificationJobs.get(id);
    if (!cur) return undefined;
    if (cur.acknowledgedBy !== undefined) return { job: cur, applied: false };
    const next = { ...cur, acknowledgedBy: by, acknowledgedAt: at };
    this.notificationJobs.set(id, next);
    return { job: next, applied: true };
  }
  async getNotificationJobByIdempotencyKey(key: string): Promise<NotificationJob | undefined> {
    return [...this.notificationJobs.values()].find(j => j.idempotencyKey === key);
  }
  async listNotificationJobs(eventId: ID): Promise<NotificationJob[]> {
    return [...this.notificationJobs.values()].filter(j => j.eventId === eventId);
  }

  // ---- push subscriptions (contracts v1.10) ----
  async upsertPushSubscription(s: PushSubscription): Promise<PushSubscription> {
    const cur = this.pushSubscriptions.get(s.endpoint);
    // Idempotent re-register (AC-PUSH-1): same endpoint keeps id+createdAt,
    // refreshes keys/deviceClass/lastUsedAt — never a duplicate row.
    const next = cur
      ? { ...cur, keys: s.keys, deviceClass: s.deviceClass ?? cur.deviceClass, lastUsedAt: s.lastUsedAt }
      : s;
    this.pushSubscriptions.set(s.endpoint, next);
    return next;
  }
  async getPushSubscriptionByEndpoint(endpoint: string): Promise<PushSubscription | undefined> {
    return this.pushSubscriptions.get(endpoint);
  }
  async listPushSubscriptions(userId: ID): Promise<PushSubscription[]> {
    return [...this.pushSubscriptions.values()].filter(s => s.userId === userId);
  }
  async deletePushSubscription(userId: ID, endpoint: string): Promise<boolean> {
    const cur = this.pushSubscriptions.get(endpoint);
    if (!cur || cur.userId !== userId) return false;
    return this.pushSubscriptions.delete(endpoint);
  }
  async deletePushSubscriptionByEndpoint(endpoint: string): Promise<boolean> {
    return this.pushSubscriptions.delete(endpoint);
  }

  async appendAudit(e: AuditLogEntry): Promise<void> { this.auditLog.push(e); }
  async listAudit(orgId: ID): Promise<AuditLogEntry[]> { return this.auditLog.filter(a => a.orgId === orgId); }
}
