import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  AuditLogEntry, Branch, ChangeRequest, ContentAck, ContentItem, ContentItemVersion, DependencyEdge, EventNode,
  ExternalParty, GraphSnapshot, ID, IdempotencyRecord, NotificationJob, OptoutSuppression, PushSubscription, ReportReadState,
  ResourceNode, StatusReport, StatusToken, TaskNode, TaskResourceLink,
  WhitelistEntry, WhitelistStatus, AdvanceProposal, AdvanceOutbox,
} from '@contake/core';
import type { ChannelRecord, GraphRepository, SeedData, UserRecord } from './graph-repository.js';
import type { DispatchStateStore } from '../services/dispatch.js';
import type { AuthAuditEntry, OtpCodeEntry, OtpStateStore, OtpVerifyState } from '../auth.js';

/** Minimal query surface shared by node-pg Pool/PoolClient and PGlite (PR-1).
 *  Rows carry the canonical entity in `data` (jsonb) so contracts never drift
 *  through a column-mapping layer; index columns exist only for lookup/CAS. */
export interface QueryResult { rows: Record<string, unknown>[]; rowCount?: number | null }
export interface Queryable { query(text: string, params?: unknown[]): Promise<QueryResult> }
export interface Connectable extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
}

/** PGlite is a single connection: serialize `connect()` leases behind one mutex
 *  so transactional blocks never interleave statements. Hermetic test adapter. */
export function pgliteConnectable(db: { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; affectedRows?: number }> }): Connectable {
  let chain: Promise<void> = Promise.resolve();
  const asResult = (r: { rows: Record<string, unknown>[]; affectedRows?: number }): QueryResult => ({ rows: r.rows, rowCount: r.affectedRows ?? null });
  // PGlite serves ONE connection: every query serializes behind this chain, so
  // fire-and-forget subscribers (appEvents listeners) can never issue a query
  // concurrent with the mutation's own on the same wire. node-pg needs none of
  // this; it is a hermetic-test accommodation, not production semantics.
  let qchain: Promise<unknown> = Promise.resolve();
  const serial = (text: string, params?: unknown[]): Promise<QueryResult> => {
    const r = qchain.then(() => db.query(text, params));
    qchain = r.catch(() => undefined);
    return r.then(asResult);
  };
  const root: Connectable = {
    query: (text, params) => serial(text, params),
    connect: async () => {
      const prev = chain;
      let release!: () => void;
      chain = new Promise<void>(r => { release = r; });
      await prev;
      return {
        query: (text, params) => serial(text, params),
        release: () => release(),
      };
    },
  };
  return root;
}

const DDL = `
CREATE TABLE IF NOT EXISTS users(user_id text PRIMARY KEY, org_id text NOT NULL, email text, phone text, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS channels(id text PRIMARY KEY, org_id text NOT NULL, address text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS events(id text PRIMARY KEY, org_id text NOT NULL, version integer NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(id text PRIMARY KEY, event_id text NOT NULL, version integer NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS resources(id text PRIMARY KEY, event_id text NOT NULL, version integer NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS dependencies(id text PRIMARY KEY, from_task_id text NOT NULL, to_task_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS change_requests(id text PRIMARY KEY, event_id text NOT NULL, state text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS reports(id text PRIMARY KEY, task_id text NOT NULL, client_report_id text, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS notification_jobs(id text PRIMARY KEY, event_id text NOT NULL, idempotency_key text, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log(seq bigserial PRIMARY KEY, org_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS push_subscriptions(endpoint text PRIMARY KEY, user_id text NOT NULL, org_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS whitelist_entries(phone text PRIMARY KEY, org_id text NOT NULL, status text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS dispatch_sent_keys(key text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS dispatch_batch_windows(address text PRIMARY KEY, closes_at_ms bigint NOT NULL);
CREATE TABLE IF NOT EXISTS dispatch_suppressed(address text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS content_items(id text PRIMARY KEY, org_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS task_content_links(task_id text NOT NULL, content_id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(task_id, content_id));
CREATE TABLE IF NOT EXISTS content_acks(org_id text NOT NULL, user_id text NOT NULL, client_ack_id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(org_id, user_id, client_ack_id));
CREATE TABLE IF NOT EXISTS external_parties(id text PRIMARY KEY, org_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS status_tokens(id text PRIMARY KEY, org_id text NOT NULL, token_hash text UNIQUE NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS branches(id text PRIMARY KEY, org_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS report_read_states(report_id text NOT NULL, user_id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(report_id, user_id));
CREATE TABLE IF NOT EXISTS content_versions(id text PRIMARY KEY, content_id text NOT NULL, version integer NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS optout_suppressions(id text PRIMARY KEY, channel text NOT NULL, address text NOT NULL, org_id text, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency_records(org_id text NOT NULL, actor_id text NOT NULL, route text NOT NULL, client_mutation_id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(org_id, actor_id, route, client_mutation_id));
CREATE TABLE IF NOT EXISTS advance_proposals(id text PRIMARY KEY, event_id text NOT NULL, status text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS advance_outbox(id text PRIMARY KEY, proposal_id text NOT NULL, status text NOT NULL, data jsonb NOT NULL);
-- whitelist-PG gate: the PG REPO writes auth_audit (commitWhitelistRegistration),
-- so the table must exist even when the OTP store is memory-backed. Mirrors the
-- OTP DDL block (IF NOT EXISTS = idempotent when createPgOtpState also runs).
CREATE TABLE IF NOT EXISTS auth_audit(seq bigserial PRIMARY KEY, phone text NOT NULL, kind text NOT NULL, data jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS content_items_org ON content_items(org_id);
CREATE INDEX IF NOT EXISTS external_parties_org ON external_parties(org_id);
CREATE INDEX IF NOT EXISTS branches_org ON branches(org_id);
CREATE INDEX IF NOT EXISTS tasks_event_id ON tasks(event_id);
CREATE INDEX IF NOT EXISTS resources_event_id ON resources(event_id);
CREATE INDEX IF NOT EXISTS channels_address ON channels(address);
CREATE INDEX IF NOT EXISTS reports_client_report_id ON reports(client_report_id);
CREATE INDEX IF NOT EXISTS notification_jobs_idem ON notification_jobs(idempotency_key);
CREATE INDEX IF NOT EXISTS audit_log_org_id ON audit_log(org_id);
CREATE INDEX IF NOT EXISTS change_requests_event_id ON change_requests(event_id);
CREATE INDEX IF NOT EXISTS notification_jobs_event_id ON notification_jobs(event_id);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_id ON push_subscriptions(user_id);
`;

/** Postgres GraphRepository (PR-1). Semantics mirror MemoryGraphRepository:
 *  - checkpoint/commit/restore = real BEGIN/COMMIT/ROLLBACK on a leased client,
 *    bound to the mutation's async context (QA-M2-6: audit rolls back WITH the mutation)
 *  - version sequencing = compare-and-set UPDATEs (… WHERE version = expected),
 *    so concurrent mutations lose cleanly instead of interleaving (PR-1b)
 *  - every multi-statement method without an ambient tx runs in its own tx,
 *    preserving the all-or-nothing guarantees the in-memory repo had (QA AC-DOM-7). */
export class PostgresGraphRepository implements GraphRepository {
  private readonly als = new AsyncLocalStorage<{ client: Queryable } | null>();

  private constructor(private readonly db: Connectable) {}

  static async create(db: Connectable): Promise<PostgresGraphRepository> {
    for (const stmt of DDL.split(';').map(s => s.trim()).filter(Boolean)) await db.query(stmt);
    return new PostgresGraphRepository(db);
  }

  private q(text: string, params?: unknown[]): Promise<QueryResult> {
    const store = this.als.getStore();
    return (store?.client ?? this.db).query(text, params);
  }

  /** Run fn inside the ambient tx when present, else on a leased client with
   *  its own BEGIN/COMMIT (ROLLBACK on throw). */
  private async inTx<T>(fn: (c: Queryable) => Promise<T>): Promise<T> {
    const store = this.als.getStore();
    if (store?.client) return fn(store.client);
    const client = await this.db.connect();
    if (process.env['PG_DEBUG']) console.error('[checkpoint] BEGIN');
    await client.query('BEGIN');
    try {
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** PR-1 atomic unit: fn runs inside BEGIN/COMMIT on a leased client, bound to
   *  the ambient AsyncLocalStorage scope via .run (never enterWith — sequential
   *  test/request contexts made enterWith bindings unreliable). Nested calls
   *  flatten into the outer tx. On throw: ROLLBACK, so audit writes and the
   *  mutation live or die together (QA-M2-6). */
  async runInTx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.als.getStore()?.client) return fn(); // nested: outer tx owns atomicity
    const client = await this.db.connect();
    await client.query('BEGIN');
    try {
      const out = await this.als.run({ client }, fn);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async checkpoint(): Promise<unknown> { return undefined; } // runInTx supersedes
  async commit(_cp: unknown): Promise<void> { /* runInTx supersedes */ }
  async restore(_cp: unknown): Promise<void> { /* runInTx supersedes */ }

  // ---- users & channels -----------------------------------------------------
  async createUser(u: UserRecord): Promise<UserRecord> {
    await this.q(
      `INSERT INTO users(user_id, org_id, email, phone, data) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET org_id=EXCLUDED.org_id, email=EXCLUDED.email, phone=EXCLUDED.phone, data=EXCLUDED.data`,
      [u.userId, u.orgId, u.email ?? null, u.phone ?? null, JSON.stringify(u)]);
    return u;
  }
  async getUser(userId: ID): Promise<UserRecord | undefined> {
    const r = await this.q(`SELECT data FROM users WHERE user_id=$1`, [userId]);
    return r.rows[0]?.['data'] as UserRecord | undefined;
  }
  async findUserByEmail(email: string): Promise<UserRecord | undefined> {
    const r = await this.q(`SELECT data FROM users WHERE email=$1 LIMIT 1`, [email]);
    return r.rows[0]?.['data'] as UserRecord | undefined;
  }
  async findUserByPhone(phone: string): Promise<UserRecord | undefined> {
    const r = await this.q(`SELECT data FROM users WHERE phone=$1 LIMIT 1`, [phone]);
    return r.rows[0]?.['data'] as UserRecord | undefined;
  }
  async updateUser(userId: ID, patch: Partial<UserRecord>): Promise<UserRecord | undefined> {
    return this.inTx(async c => {
      const r = await c.query(`SELECT data FROM users WHERE user_id=$1 FOR UPDATE`, [userId]);
      const cur = r.rows[0]?.['data'] as UserRecord | undefined;
      if (!cur) return undefined;
      const next = { ...cur, ...patch, userId: cur.userId, orgId: cur.orgId };
      await c.query(`UPDATE users SET email=$2, phone=$3, data=$4 WHERE user_id=$1`,
        [userId, next.email ?? null, next.phone ?? null, JSON.stringify(next)]);
      return next;
    });
  }
  async listUsers(orgId: ID): Promise<UserRecord[]> {
    const r = await this.q(`SELECT data FROM users WHERE org_id=$1`, [orgId]);
    return r.rows.map(row => row['data'] as UserRecord);
  }

  // whitelist onboarding (v1.18 §15): upsert on phone, org-scoped list.
  async upsertWhitelistEntry(e: WhitelistEntry): Promise<WhitelistEntry> {
    await this.q(
      `INSERT INTO whitelist_entries(phone, org_id, status, data) VALUES($1,$2,$3,$4)
       ON CONFLICT (phone) DO UPDATE SET org_id=$2, status=$3, data=$4`,
      [e.phone, e.orgId, e.status, JSON.stringify(e)]);
    return e;
  }
  /** QA 2026-09-17 (register exactly-one-winner): create-only invite.
   *  Plain INSERT ... ON CONFLICT DO NOTHING - a concurrent winner's
   *  committed row makes the loser's insert match zero rows; NO overwrite,
   *  never a silent cross-org success (T2 defect class). Deterministic. */
  async createWhitelistInvite(e: WhitelistEntry): Promise<{ outcome: 'created' | 'exists'; entry: WhitelistEntry }> {
    const r = await this.q(
      `INSERT INTO whitelist_entries(phone, org_id, status, data) VALUES($1,$2,$3,$4)
       ON CONFLICT (phone) DO NOTHING RETURNING data`,
      [e.phone, e.orgId, e.status, JSON.stringify(e)]);
    const won = r.rows[0];
    if (won) return { outcome: 'created', entry: won['data'] as WhitelistEntry };
    const existing = await this.getWhitelistEntry(e.phone);
    if (!existing) throw new Error('createWhitelistInvite: row vanished between insert and read');
    return { outcome: 'exists', entry: existing };
  }
  async getWhitelistEntry(phone: string): Promise<WhitelistEntry | undefined> {
    const r = await this.q(`SELECT data FROM whitelist_entries WHERE phone=$1 LIMIT 1`, [phone]);
    return r.rows[0]?.['data'] as WhitelistEntry | undefined;
  }
  /** QA round-5 CAS primitive: the transition applies ONLY while the row is
   *  still 'invited' (UPDATE ... WHERE status='invited' RETURNING). A
   *  concurrent register blocks on the row lock, re-evaluates after the
   *  winner's COMMIT, matches zero rows and loses deterministically - exactly
   *  one transition. The committed audit row is inserted for the winner only,
   *  inside the same tx, so a failed insert ROLLBACKs the transition (state
   *  stays invited, no success row) and retry is unambiguous. */
  /** Round 8: ONE transaction holds the phone's row (SELECT ... FOR UPDATE)
   *  for the whole mutation - status check, account mutation, entry write and
   *  audit all share this tx client through the ambient scope (nested runInTx
   *  flattens into the outer tx). Concurrent decisions serialize on the row
   *  lock; the loser re-reads the DECIDED state and conflicts out. */
  async withWhitelistMutation<T>(phone: string, fn: (locked: WhitelistEntry | undefined) => Promise<T>): Promise<T> {
    return this.runInTx(async () => {
      const r = await this.q(`SELECT data FROM whitelist_entries WHERE phone=$1 FOR UPDATE`, [phone]);
      return fn(r.rows[0]?.['data'] as WhitelistEntry | undefined);
    });
  }

  async commitWhitelistRegistration(entry: WhitelistEntry, audit: AuthAuditEntry): Promise<'applied' | 'duplicate'> {
    return this.runInTx(async () => {
      const r = await this.q(
        `UPDATE whitelist_entries SET org_id=$2, status=$3, data=$4 WHERE phone=$1 AND status='invited' RETURNING phone`,
        [entry.phone, entry.orgId, entry.status, JSON.stringify(entry)]);
      if (r.rows.length === 0) return 'duplicate';
      await this.q(`INSERT INTO auth_audit(phone, kind, data) VALUES($1,$2,$3)`, [audit.phone, audit.kind, audit.detail ?? null]);
      return 'applied';
    });
  }
  async listWhitelist(orgId: ID, status?: WhitelistStatus): Promise<WhitelistEntry[]> {
    const r = status
      ? await this.q(`SELECT data FROM whitelist_entries WHERE org_id=$1 AND status=$2`, [orgId, status])
      : await this.q(`SELECT data FROM whitelist_entries WHERE org_id=$1`, [orgId]);
    return r.rows.map(row => row['data'] as WhitelistEntry);
  }

  async createChannel(c: ChannelRecord): Promise<ChannelRecord> {
    await this.q(
      `INSERT INTO channels(id, org_id, address, data) VALUES($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET org_id=EXCLUDED.org_id, address=EXCLUDED.address, data=EXCLUDED.data`,
      [c.id, c.orgId, c.address, JSON.stringify(c)]);
    return c;
  }
  async getChannel(id: ID): Promise<ChannelRecord | undefined> {
    const r = await this.q(`SELECT data FROM channels WHERE id=$1`, [id]);
    return r.rows[0]?.['data'] as ChannelRecord | undefined;
  }
  async findChannelByAddress(address: string): Promise<ChannelRecord | undefined> {
    const r = await this.q(`SELECT data FROM channels WHERE address=$1 LIMIT 1`, [address]);
    return r.rows[0]?.['data'] as ChannelRecord | undefined;
  }
  async updateChannel(id: ID, patch: Partial<ChannelRecord>): Promise<ChannelRecord | undefined> {
    return this.inTx(async c => {
      const r = await c.query(`SELECT data FROM channels WHERE id=$1 FOR UPDATE`, [id]);
      const cur = r.rows[0]?.['data'] as ChannelRecord | undefined;
      if (!cur) return undefined;
      const next = { ...cur, ...patch };
      await c.query(`UPDATE channels SET address=$2, data=$3 WHERE id=$1`, [id, next.address, JSON.stringify(next)]);
      return next;
    });
  }

  // ---- events & graph --------------------------------------------------------
  async createEvent(e: EventNode): Promise<EventNode> {
    await this.q(
      `INSERT INTO events(id, org_id, version, data) VALUES($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET org_id=EXCLUDED.org_id, version=EXCLUDED.version, data=EXCLUDED.data`,
      [e.id, e.orgId, e.version, JSON.stringify(e)]);
    return e;
  }
  async getEvent(id: ID): Promise<EventNode | undefined> {
    const r = await this.q(`SELECT data FROM events WHERE id=$1`, [id]);
    return r.rows[0]?.['data'] as EventNode | undefined;
  }
  async updateEvent(id: ID, patch: Partial<EventNode>): Promise<EventNode | undefined> {
    return this.inTx(async c => {
      const r = await c.query(`SELECT data FROM events WHERE id=$1 FOR UPDATE`, [id]);
      const cur = r.rows[0]?.['data'] as EventNode | undefined;
      if (!cur) return undefined;
      const next = { ...cur, ...patch, id: cur.id, orgId: cur.orgId, version: cur.version + 1 };
      await c.query(`UPDATE events SET version=$2, data=$3 WHERE id=$1`, [id, next.version, JSON.stringify(next)]);
      return next;
    });
  }
  async listEvents(orgId: ID): Promise<EventNode[]> {
    const r = await this.q(`SELECT data FROM events WHERE org_id=$1`, [orgId]);
    return r.rows.map(row => row['data'] as EventNode);
  }
  async snapshot(eventId: ID): Promise<GraphSnapshot | undefined> {
    const event = await this.getEvent(eventId);
    if (!event) return undefined;
    const [tasks, resources, dependencies] = await Promise.all([
      this.listTasks(eventId), this.listResources(eventId), this.listDependencies(eventId)]);
    return { event, tasks, resources, dependencies };
  }
  async bumpEventVersion(id: ID, expected: number): Promise<boolean> {
    const r = await this.q(
      `UPDATE events SET version=version+1,
         data=jsonb_set(data, '{version}', to_jsonb(version+1))
       WHERE id=$1 AND version=$2`, [id, expected]);
    return r.rowCount === 1;
  }

  async createTask(t: TaskNode): Promise<TaskNode> {
    await this.q(
      `INSERT INTO tasks(id, event_id, version, data) VALUES($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET event_id=EXCLUDED.event_id, version=EXCLUDED.version, data=EXCLUDED.data`,
      [t.id, t.eventId, t.version, JSON.stringify(t)]);
    return t;
  }
  async getTask(id: ID): Promise<TaskNode | undefined> {
    const r = await this.q(`SELECT data FROM tasks WHERE id=$1`, [id]);
    return r.rows[0]?.['data'] as TaskNode | undefined;
  }
  async listTasks(eventId: ID): Promise<TaskNode[]> {
    const r = await this.q(`SELECT data FROM tasks WHERE event_id=$1`, [eventId]);
    return r.rows.map(row => row['data'] as TaskNode);
  }
  async applyTaskUpdates(updates: { id: ID; expectedVersion: number; patch: Partial<TaskNode> }[]): Promise<boolean> {
    if (updates.length === 0) return true;
    const FAILED = Symbol('version-mismatch');
    try {
      return await this.inTx(async c => {
        for (const u of updates) {
          const r = await c.query(
            `UPDATE tasks SET version=version+1,
               data=(data || $2::jsonb) || jsonb_build_object('id', $1, 'eventId', data->>'eventId', 'version', version+1)
             WHERE id=$1 AND version=$3`,
            [u.id, JSON.stringify(u.patch), u.expectedVersion]);
          if (r.rowCount !== 1) throw FAILED;
        }
        return true;
      });
    } catch (e) {
      if (e === FAILED) return false; // nothing written: tx rolled back (QA AC-DOM-7)
      throw e;
    }
  }

  async createResource(r: ResourceNode): Promise<ResourceNode> {
    await this.q(
      `INSERT INTO resources(id, event_id, version, data) VALUES($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET event_id=EXCLUDED.event_id, version=EXCLUDED.version, data=EXCLUDED.data`,
      [r.id, r.eventId, r.version, JSON.stringify(r)]);
    return r;
  }
  async getResource(id: ID): Promise<ResourceNode | undefined> {
    const r = await this.q(`SELECT data FROM resources WHERE id=$1`, [id]);
    return r.rows[0]?.['data'] as ResourceNode | undefined;
  }
  async updateResource(id: ID, patch: Partial<ResourceNode>): Promise<ResourceNode | undefined> {
    return this.inTx(async c => {
      const r = await c.query(`SELECT data FROM resources WHERE id=$1 FOR UPDATE`, [id]);
      const cur = r.rows[0]?.['data'] as ResourceNode | undefined;
      if (!cur) return undefined;
      const next = { ...cur, ...patch, id: cur.id, version: cur.version + 1 };
      await c.query(`UPDATE resources SET version=$2, data=$3 WHERE id=$1`, [id, next.version, JSON.stringify(next)]);
      return next;
    });
  }
  async listResources(eventId: ID): Promise<ResourceNode[]> {
    const r = await this.q(`SELECT data FROM resources WHERE event_id=$1`, [eventId]);
    return r.rows.map(row => row['data'] as ResourceNode);
  }

  async createDependency(d: DependencyEdge): Promise<DependencyEdge> {
    await this.q(
      `INSERT INTO dependencies(id, from_task_id, to_task_id, data) VALUES($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET from_task_id=EXCLUDED.from_task_id, to_task_id=EXCLUDED.to_task_id, data=EXCLUDED.data`,
      [d.id, d.fromTaskId, d.toTaskId, JSON.stringify(d)]);
    return d;
  }
  async getDependency(id: ID): Promise<DependencyEdge | undefined> {
    const r = await this.q(`SELECT data FROM dependencies WHERE id=$1`, [id]);
    return r.rows[0]?.['data'] as DependencyEdge | undefined;
  }
  async deleteDependency(id: ID): Promise<boolean> {
    const r = await this.q(`DELETE FROM dependencies WHERE id=$1`, [id]);
    return (r.rowCount ?? 0) > 0;
  }
  async deleteTask(id: ID): Promise<boolean> {
    return this.inTx(async c => {
      await c.query(`DELETE FROM dependencies WHERE from_task_id=$1 OR to_task_id=$1`, [id]);
      const r = await c.query(`DELETE FROM tasks WHERE id=$1`, [id]);
      return (r.rowCount ?? 0) > 0;
    });
  }
  async deleteEvent(id: ID): Promise<boolean> {
    return this.inTx(async c => {
      const exists = await c.query(`SELECT 1 FROM events WHERE id=$1`, [id]);
      if (exists.rows.length === 0) return false;
      await c.query(`DELETE FROM dependencies WHERE from_task_id IN (SELECT id FROM tasks WHERE event_id=$1) OR to_task_id IN (SELECT id FROM tasks WHERE event_id=$1)`, [id]);
      await c.query(`DELETE FROM reports WHERE task_id IN (SELECT id FROM tasks WHERE event_id=$1)`, [id]);
      await c.query(`DELETE FROM tasks WHERE event_id=$1`, [id]);
      await c.query(`DELETE FROM change_requests WHERE event_id=$1`, [id]);
      await c.query(`DELETE FROM notification_jobs WHERE event_id=$1`, [id]);
      await c.query(`DELETE FROM events WHERE id=$1`, [id]);
      return true;
    });
  }
  async listDependencies(eventId: ID): Promise<DependencyEdge[]> {
    const r = await this.q(
      `SELECT data FROM dependencies
       WHERE from_task_id IN (SELECT id FROM tasks WHERE event_id=$1)
         AND to_task_id IN (SELECT id FROM tasks WHERE event_id=$1)`, [eventId]);
    return r.rows.map(row => row['data'] as DependencyEdge);
  }

  // ---- change requests -------------------------------------------------------
  async createChangeRequest(cr: ChangeRequest): Promise<ChangeRequest> {
    await this.q(
      `INSERT INTO change_requests(id, event_id, state, data) VALUES($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET event_id=EXCLUDED.event_id, state=EXCLUDED.state, data=EXCLUDED.data`,
      [cr.id, cr.eventId, cr.state, JSON.stringify(cr)]);
    return cr;
  }
  async getChangeRequest(id: ID): Promise<ChangeRequest | undefined> {
    const r = await this.q(`SELECT data FROM change_requests WHERE id=$1`, [id]);
    return r.rows[0]?.['data'] as ChangeRequest | undefined;
  }
  async updateChangeRequest(id: ID, patch: Partial<ChangeRequest>): Promise<ChangeRequest | undefined> {
    return this.inTx(async c => {
      const r = await c.query(`SELECT data FROM change_requests WHERE id=$1 FOR UPDATE`, [id]);
      const cur = r.rows[0]?.['data'] as ChangeRequest | undefined;
      if (!cur) return undefined;
      const next = { ...cur, ...patch, id: cur.id };
      await c.query(`UPDATE change_requests SET event_id=$2, state=$3, data=$4 WHERE id=$1`,
        [id, next.eventId, next.state, JSON.stringify(next)]);
      return next;
    });
  }
  async listChangeRequests(filter: { eventId?: ID; state?: string }): Promise<ChangeRequest[]> {
    const clauses: string[] = []; const params: unknown[] = [];
    if (filter.eventId !== undefined) { params.push(filter.eventId); clauses.push(`event_id=$${params.length}`); }
    if (filter.state !== undefined) { params.push(filter.state); clauses.push(`state=$${params.length}`); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const r = await this.q(`SELECT data FROM change_requests${where}`, params);
    return r.rows.map(row => row['data'] as ChangeRequest);
  }

  // ---- field reports ----------------------------------------------------------
  async createReport(r: StatusReport): Promise<StatusReport> {
    await this.q(
      `INSERT INTO reports(id, task_id, client_report_id, data) VALUES($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET task_id=EXCLUDED.task_id, client_report_id=EXCLUDED.client_report_id, data=EXCLUDED.data`,
      [r.id, r.taskId, r.clientReportId ?? null, JSON.stringify(r)]);
    return r;
  }
  async getReportByClientId(clientReportId: string): Promise<StatusReport | undefined> {
    const r = await this.q(`SELECT data FROM reports WHERE client_report_id=$1 LIMIT 1`, [clientReportId]);
    return r.rows[0]?.['data'] as StatusReport | undefined;
  }
  async listReports(eventId: ID): Promise<StatusReport[]> {
    const r = await this.q(`SELECT data FROM reports WHERE task_id IN (SELECT id FROM tasks WHERE event_id=$1)`, [eventId]);
    return r.rows.map(row => row['data'] as StatusReport);
  }
  async getReport(id: ID): Promise<StatusReport | undefined> {
    const r = await this.q(`SELECT data FROM reports WHERE id=$1`, [id]);
    return r.rows[0]?.['data'] as StatusReport | undefined;
  }
  async resolveReport(id: ID, by: ID, at: string, noteHe?: string): Promise<{ report: StatusReport; applied: boolean } | undefined> {
    return this.inTx(async c => {
      // FOR UPDATE serializes racers; only the winner returns applied=true (ack pattern).
      const r = await c.query(`SELECT data FROM reports WHERE id=$1 FOR UPDATE`, [id]);
      const cur = r.rows[0]?.['data'] as StatusReport | undefined;
      if (!cur) return undefined;
      if (cur.resolvedBy !== undefined) return { report: cur, applied: false };
      const next = { ...cur, resolvedBy: by, resolvedAt: at, ...(noteHe ? { resolutionNoteHe: noteHe } : {}) };
      await c.query(`UPDATE reports SET data=$2 WHERE id=$1`, [id, JSON.stringify(next)]);
      return { report: next, applied: true };
    });
  }

  async correctReport(id: ID, expectedVersion: number, patch: { actualFinishAt: string; lastCorrection: { reason: string; at: string; by: ID } }): Promise<StatusReport | 'conflict' | undefined> {
    return this.inTx(async c => {
      const r = await c.query(`SELECT data FROM reports WHERE id=$1 FOR UPDATE`, [id]);
      const cur = r.rows[0]?.['data'] as StatusReport | undefined;
      if (!cur) return undefined;
      if ((cur.version ?? 1) !== expectedVersion) return 'conflict';
      const next: StatusReport = { ...cur, actualFinishAt: patch.actualFinishAt, version: (cur.version ?? 1) + 1, lastCorrection: patch.lastCorrection };
      await c.query(`UPDATE reports SET data=$2 WHERE id=$1`, [id, JSON.stringify(next)]);
      return next;
    });
  }

  // ---- advance proposals + outbox (v1.21.2 §26) --------------------------------
  async createAdvanceProposal(p: AdvanceProposal): Promise<AdvanceProposal> {
    await this.q(`INSERT INTO advance_proposals(id, event_id, status, data) VALUES($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`, [p.proposalId, p.eventId, p.status, JSON.stringify(p)]);
    return p;
  }
  async getAdvanceProposal(id: ID): Promise<AdvanceProposal | undefined> {
    const r = await this.q(`SELECT data FROM advance_proposals WHERE id=$1`, [id]);
    return r.rows[0]?.['data'] as AdvanceProposal | undefined;
  }
  async listAdvanceProposals(eventId: ID): Promise<AdvanceProposal[]> {
    const r = await this.q(`SELECT data FROM advance_proposals WHERE event_id=$1`, [eventId]);
    return r.rows.map(x => x['data'] as AdvanceProposal);
  }
  async updateAdvanceProposal(id: ID, patch: Partial<Pick<AdvanceProposal, 'status'>>): Promise<AdvanceProposal | undefined> {
    return this.inTx(async c => {
      const r = await c.query(`SELECT data FROM advance_proposals WHERE id=$1 FOR UPDATE`, [id]);
      const cur = r.rows[0]?.['data'] as AdvanceProposal | undefined;
      if (!cur) return undefined;
      const next = { ...cur, ...patch, proposalId: cur.proposalId };
      await c.query(`UPDATE advance_proposals SET status=$2, data=$3 WHERE id=$1`, [id, next.status, JSON.stringify(next)]);
      return next;
    });
  }
  async findOpenAdvanceProposal(eventId: ID, anchorTaskId: ID, actualFinishAt: string, graphVersion: number): Promise<AdvanceProposal | undefined> {
    const r = await this.q(`SELECT data FROM advance_proposals WHERE event_id=$1 AND status='open'`, [eventId]);
    return (r.rows.map(x => x['data'] as AdvanceProposal)).find(p =>
      p.anchorTaskId === anchorTaskId && p.actualFinishAt === actualFinishAt && p.graphVersion === graphVersion);
  }
  async markProposalsStaleForReport(reportId: ID): Promise<ID[]> {
    return this.inTx(async c => {
      const r = await c.query(`SELECT data FROM advance_proposals WHERE status='open' FOR UPDATE`);
      const stale: ID[] = [];
      for (const row of r.rows) {
        const p = row['data'] as AdvanceProposal;
        if (p.sourceReportId === reportId) {
          const next = { ...p, status: 'stale' as const };
          await c.query(`UPDATE advance_proposals SET status='stale', data=$2 WHERE id=$1`, [p.proposalId, JSON.stringify(next)]);
          stale.push(p.proposalId);
        }
      }
      return stale;
    });
  }
  async createAdvanceOutbox(o: AdvanceOutbox): Promise<AdvanceOutbox> {
    await this.q(`INSERT INTO advance_outbox(id, proposal_id, status, data) VALUES($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`, [o.id, o.proposalId, o.status, JSON.stringify(o)]);
    return o;
  }
  async listPendingAdvanceOutbox(): Promise<AdvanceOutbox[]> {
    const r = await this.q(`SELECT data FROM advance_outbox WHERE status='pending'`);
    return r.rows.map(x => x['data'] as AdvanceOutbox);
  }
  async markAdvanceOutboxMaterialized(id: ID): Promise<void> {
    const r = await this.q(`SELECT data FROM advance_outbox WHERE id=$1`, [id]);
    const cur = r.rows[0]?.['data'] as AdvanceOutbox | undefined;
    if (cur) await this.q(`UPDATE advance_outbox SET status='materialized', data=$2 WHERE id=$1`, [id, JSON.stringify({ ...cur, status: 'materialized' })]);
  }

  // ---- notification jobs --------------------------------------------------------
  async createNotificationJob(j: NotificationJob): Promise<NotificationJob> {
    await this.q(
      `INSERT INTO notification_jobs(id, event_id, idempotency_key, data) VALUES($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET event_id=EXCLUDED.event_id, idempotency_key=EXCLUDED.idempotency_key, data=EXCLUDED.data`,
      [j.id, j.eventId, j.idempotencyKey ?? null, JSON.stringify(j)]);
    return j;
  }
  async getNotificationJob(id: ID): Promise<NotificationJob | undefined> {
    const r = await this.q(`SELECT data FROM notification_jobs WHERE id=$1`, [id]);
    return r.rows[0]?.['data'] as NotificationJob | undefined;
  }
  async updateNotificationJob(id: ID, patch: Partial<NotificationJob>): Promise<NotificationJob | undefined> {
    return this.inTx(async c => {
      // FOR UPDATE serializes concurrent first-acks: the loser re-reads the
      // winner's committed ack and leaves it untouched (write-once, PR-3).
      const r = await c.query(`SELECT data FROM notification_jobs WHERE id=$1 FOR UPDATE`, [id]);
      const cur = r.rows[0]?.['data'] as NotificationJob | undefined;
      if (!cur) return undefined;
      if (cur.acknowledgedBy !== undefined && patch.acknowledgedBy !== undefined) return cur;
      const next = { ...cur, ...patch, id: cur.id };
      await c.query(`UPDATE notification_jobs SET data=$2 WHERE id=$1`, [id, JSON.stringify(next)]);
      return next;
    });
  }
  async ackNotificationJob(id: ID, by: ID, at: string): Promise<{ job: NotificationJob; applied: boolean } | undefined> {
    return this.inTx(async c => {
      // FOR UPDATE serializes racers; only the winner returns applied=true.
      const r = await c.query(`SELECT data FROM notification_jobs WHERE id=$1 FOR UPDATE`, [id]);
      const cur = r.rows[0]?.['data'] as NotificationJob | undefined;
      if (!cur) return undefined;
      if (cur.acknowledgedBy !== undefined) return { job: cur, applied: false };
      const next = { ...cur, acknowledgedBy: by, acknowledgedAt: at };
      await c.query(`UPDATE notification_jobs SET data=$2 WHERE id=$1`, [id, JSON.stringify(next)]);
      return { job: next, applied: true };
    });
  }
  async getNotificationJobByIdempotencyKey(key: string): Promise<NotificationJob | undefined> {
    const r = await this.q(`SELECT data FROM notification_jobs WHERE idempotency_key=$1 LIMIT 1`, [key]);
    return r.rows[0]?.['data'] as NotificationJob | undefined;
  }
  async listNotificationJobs(eventId: ID): Promise<NotificationJob[]> {
    const r = await this.q(`SELECT data FROM notification_jobs WHERE event_id=$1`, [eventId]);
    return r.rows.map(row => row['data'] as NotificationJob);
  }
  async listNotificationJobsAll(): Promise<NotificationJob[]> {
    const r = await this.q(`SELECT data FROM notification_jobs`);
    return r.rows.map(row => row['data'] as NotificationJob);
  }

  // ---- push subscriptions (contracts v1.10) -------------------------------------
  async upsertPushSubscription(s: PushSubscription): Promise<PushSubscription> {
    return this.inTx(async c => {
      const cur = (await c.query(`SELECT data FROM push_subscriptions WHERE endpoint=$1 FOR UPDATE`, [s.endpoint])).rows[0]?.['data'] as PushSubscription | undefined;
      // Idempotent re-register (AC-PUSH-1): same endpoint keeps id+createdAt.
      const next = cur
        ? { ...cur, keys: s.keys, deviceClass: s.deviceClass ?? cur.deviceClass, lastUsedAt: s.lastUsedAt }
        : s;
      await c.query(
        `INSERT INTO push_subscriptions(endpoint, user_id, org_id, data) VALUES($1,$2,$3,$4)
         ON CONFLICT (endpoint) DO UPDATE SET data=EXCLUDED.data`,
        [next.endpoint, next.userId, next.orgId, JSON.stringify(next)]);
      return next;
    });
  }
  async getPushSubscriptionByEndpoint(endpoint: string): Promise<PushSubscription | undefined> {
    const r = await this.q(`SELECT data FROM push_subscriptions WHERE endpoint=$1`, [endpoint]);
    return r.rows[0]?.['data'] as PushSubscription | undefined;
  }
  async listPushSubscriptions(userId: ID): Promise<PushSubscription[]> {
    const r = await this.q(`SELECT data FROM push_subscriptions WHERE user_id=$1`, [userId]);
    return r.rows.map(row => row['data'] as PushSubscription);
  }
  async deletePushSubscription(userId: ID, endpoint: string): Promise<boolean> {
    const r = await this.q(`DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2`, [endpoint, userId]);
    return (r.rowCount ?? 0) > 0;
  }
  async deletePushSubscriptionByEndpoint(endpoint: string): Promise<boolean> {
    const r = await this.q(`DELETE FROM push_subscriptions WHERE endpoint=$1`, [endpoint]);
    return (r.rowCount ?? 0) > 0;
  }

  // ---- audit (append-only) ------------------------------------------------------
  // ---- v1.20 §20 content surface ----
  async createContentItem(c: ContentItem): Promise<ContentItem> {
    await this.q(`INSERT INTO content_items(id, org_id, data) VALUES($1,$2,$3) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`, [c.id, c.orgId, JSON.stringify(c)]);
    return c;
  }
  async getContentItem(id: ID): Promise<ContentItem | undefined> {
    const r = await this.q(`SELECT data FROM content_items WHERE id=$1`, [id]);
    return r.rows[0]?.['data'] as ContentItem | undefined;
  }
  async updateContentItem(id: ID, patch: Partial<ContentItem>): Promise<ContentItem | undefined> {
    return this.inTx(async c => {
      const r = await c.query(`SELECT data FROM content_items WHERE id=$1 FOR UPDATE`, [id]);
      const cur = r.rows[0]?.['data'] as ContentItem | undefined;
      if (!cur) return undefined;
      const next = { ...cur, ...patch, id: cur.id, orgId: cur.orgId };
      await c.query(`UPDATE content_items SET data=$2 WHERE id=$1`, [id, JSON.stringify(next)]);
      return next;
    });
  }
  async casUpdateContentItem(id: ID, expectedVersion: number, patch: Partial<ContentItem>): Promise<ContentItem | undefined | 'conflict'> {
    return this.inTx(async c => {
      const r = await c.query(`SELECT data FROM content_items WHERE id=$1 FOR UPDATE`, [id]);
      const cur = r.rows[0]?.['data'] as ContentItem | undefined;
      if (!cur) return undefined;
      if (cur.version !== expectedVersion) return 'conflict';
      const next = { ...cur, ...patch, id: cur.id, orgId: cur.orgId, version: cur.version + 1 };
      await c.query(`UPDATE content_items SET data=$2 WHERE id=$1`, [id, JSON.stringify(next)]);
      return next;
    });
  }
  async createContentVersion(v: ContentItemVersion): Promise<ContentItemVersion> {
    await this.q(`INSERT INTO content_versions(id, content_id, version, data) VALUES($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`, [v.contentVersionId, v.contentId, v.version, JSON.stringify(v)]);
    return v;
  }
  async listContentVersions(contentId: ID): Promise<ContentItemVersion[]> {
    const r = await this.q(`SELECT data FROM content_versions WHERE content_id=$1 ORDER BY version ASC`, [contentId]);
    return r.rows.map(row => row['data'] as ContentItemVersion);
  }
  async getContentVersion(contentId: ID, contentVersionId: ID): Promise<ContentItemVersion | undefined> {
    const r = await this.q(`SELECT data FROM content_versions WHERE id=$1 AND content_id=$2`, [contentVersionId, contentId]);
    return r.rows[0]?.['data'] as ContentItemVersion | undefined;
  }
  async deleteContentItem(id: ID): Promise<boolean> {
    await this.q(`DELETE FROM task_content_links WHERE content_id=$1`, [id]);
    const r = await this.q(`DELETE FROM content_items WHERE id=$1`, [id]);
    return (r.rowCount ?? 0) > 0;
  }
  async listContentItems(orgId: ID): Promise<ContentItem[]> {
    const r = await this.q(`SELECT data FROM content_items WHERE org_id=$1`, [orgId]);
    return r.rows.map(row => row['data'] as ContentItem);
  }
  async attachTaskContent(l: TaskResourceLink): Promise<TaskResourceLink> {
    await this.q(`INSERT INTO task_content_links(task_id, content_id, data) VALUES($1,$2,$3) ON CONFLICT (task_id, content_id) DO UPDATE SET data=EXCLUDED.data`, [l.taskId, l.contentId, JSON.stringify(l)]);
    return l;
  }
  async detachTaskContent(taskId: ID, contentId: ID): Promise<boolean> {
    const r = await this.q(`DELETE FROM task_content_links WHERE task_id=$1 AND content_id=$2`, [taskId, contentId]);
    return (r.rowCount ?? 0) > 0;
  }
  async listTaskContent(taskId: ID): Promise<TaskResourceLink[]> {
    const r = await this.q(`SELECT data FROM task_content_links WHERE task_id=$1`, [taskId]);
    return r.rows.map(row => row['data'] as TaskResourceLink);
  }
  async createContentAck(a: ContentAck & { orgId: ID }): Promise<ContentAck> {
    await this.q(`INSERT INTO content_acks(org_id, user_id, client_ack_id, data) VALUES($1,$2,$3,$4) ON CONFLICT (org_id, user_id, client_ack_id) DO NOTHING`, [a.orgId, a.userId, a.clientAckId, JSON.stringify(a)]);
    return a;
  }
  async getContentAck(orgId: ID, userId: ID, clientAckId: string): Promise<ContentAck | undefined> {
    const r = await this.q(`SELECT data FROM content_acks WHERE org_id=$1 AND user_id=$2 AND client_ack_id=$3`, [orgId, userId, clientAckId]);
    return r.rows[0]?.['data'] as ContentAck | undefined;
  }

  // ---- v1.20 §22 stakeholders ----
  async createExternalParty(p: ExternalParty): Promise<ExternalParty> {
    await this.q(`INSERT INTO external_parties(id, org_id, data) VALUES($1,$2,$3) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`, [p.id, p.orgId, JSON.stringify(p)]);
    return p;
  }
  async getExternalParty(id: ID): Promise<ExternalParty | undefined> {
    const r = await this.q(`SELECT data FROM external_parties WHERE id=$1`, [id]);
    return r.rows[0]?.['data'] as ExternalParty | undefined;
  }
  async updateExternalParty(id: ID, patch: Partial<ExternalParty>): Promise<ExternalParty | undefined> {
    return this.inTx(async c => {
      const r = await c.query(`SELECT data FROM external_parties WHERE id=$1 FOR UPDATE`, [id]);
      const cur = r.rows[0]?.['data'] as ExternalParty | undefined;
      if (!cur) return undefined;
      const next = { ...cur, ...patch, id: cur.id, orgId: cur.orgId, version: cur.version + 1 };
      await c.query(`UPDATE external_parties SET data=$2 WHERE id=$1`, [id, JSON.stringify(next)]);
      return next;
    });
  }
  async deleteExternalParty(id: ID): Promise<boolean> {
    const r = await this.q(`DELETE FROM external_parties WHERE id=$1`, [id]);
    return (r.rowCount ?? 0) > 0;
  }
  async listExternalParties(orgId: ID): Promise<ExternalParty[]> {
    const r = await this.q(`SELECT data FROM external_parties WHERE org_id=$1`, [orgId]);
    return r.rows.map(row => row['data'] as ExternalParty);
  }
  async createStatusToken(t: StatusToken): Promise<StatusToken> {
    await this.q(`INSERT INTO status_tokens(id, org_id, token_hash, data) VALUES($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`, [t.id, t.orgId, t.tokenHash, JSON.stringify(t)]);
    return t;
  }
  async getStatusToken(id: ID): Promise<StatusToken | undefined> {
    const r = await this.q(`SELECT data FROM status_tokens WHERE id=$1`, [id]);
    return r.rows[0]?.['data'] as StatusToken | undefined;
  }
  async findExternalPartyByContactRef(value: string): Promise<ExternalParty | undefined> {
    const r = await this.q(`SELECT data FROM external_parties WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(data->'contactRefs') cr WHERE cr->>'value' = $1) LIMIT 1`, [value]);
    return r.rows[0]?.['data'] as ExternalParty | undefined;
  }
  async getStatusTokenByHash(tokenHash: string): Promise<StatusToken | undefined> {
    const r = await this.q(`SELECT data FROM status_tokens WHERE token_hash=$1`, [tokenHash]);
    return r.rows[0]?.['data'] as StatusToken | undefined;
  }
  async updateStatusToken(id: ID, patch: Partial<StatusToken>): Promise<StatusToken | undefined> {
    const cur = (await this.q(`SELECT data FROM status_tokens WHERE id=$1`, [id])).rows[0]?.['data'] as StatusToken | undefined;
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id: cur.id, orgId: cur.orgId };
    await this.q(`UPDATE status_tokens SET data=$2 WHERE id=$1`, [id, JSON.stringify(next)]);
    return next;
  }

  // ---- v1.20 §23 branches ----
  async createBranch(b: Branch): Promise<Branch> {
    await this.q(`INSERT INTO branches(id, org_id, data) VALUES($1,$2,$3) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`, [b.id, b.orgId, JSON.stringify(b)]);
    return b;
  }
  async getBranch(id: ID): Promise<Branch | undefined> {
    const r = await this.q(`SELECT data FROM branches WHERE id=$1`, [id]);
    return r.rows[0]?.['data'] as Branch | undefined;
  }
  async updateBranch(id: ID, patch: Partial<Branch>): Promise<Branch | undefined> {
    return this.inTx(async c => {
      const r = await c.query(`SELECT data FROM branches WHERE id=$1 FOR UPDATE`, [id]);
      const cur = r.rows[0]?.['data'] as Branch | undefined;
      if (!cur) return undefined;
      const next = { ...cur, ...patch, id: cur.id, orgId: cur.orgId, version: cur.version + 1 };
      await c.query(`UPDATE branches SET data=$2 WHERE id=$1`, [id, JSON.stringify(next)]);
      return next;
    });
  }
  async listBranches(orgId: ID): Promise<Branch[]> {
    const r = await this.q(`SELECT data FROM branches WHERE org_id=$1`, [orgId]);
    return r.rows.map(row => row['data'] as Branch);
  }

  // ---- v1.20 §24 report read state ----
  async markReportRead(st: ReportReadState): Promise<ReportReadState> {
    await this.q(`INSERT INTO report_read_states(report_id, user_id, data) VALUES($1,$2,$3) ON CONFLICT (report_id, user_id) DO UPDATE SET data=EXCLUDED.data`, [st.reportId, st.userId, JSON.stringify(st)]);
    return st;
  }
  async getReportReadState(reportId: ID, userId: ID): Promise<ReportReadState | undefined> {
    const r = await this.q(`SELECT data FROM report_read_states WHERE report_id=$1 AND user_id=$2`, [reportId, userId]);
    return r.rows[0]?.['data'] as ReportReadState | undefined;
  }
  async listReportReadStates(userId: ID): Promise<ReportReadState[]> {
    const r = await this.q(`SELECT data FROM report_read_states WHERE user_id=$1`, [userId]);
    return r.rows.map(row => row['data'] as ReportReadState);
  }

  // ---- v1.20.2 opt-out suppressions + idempotency records ----
  async createOptoutSuppression(x: OptoutSuppression): Promise<OptoutSuppression> {
    await this.q(`INSERT INTO optout_suppressions(id, channel, address, org_id, data) VALUES($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`, [x.id, x.channel, x.address, x.orgId, JSON.stringify(x)]);
    return x;
  }
  async findActiveSuppression(channel: string, address: string, orgId?: ID): Promise<OptoutSuppression | undefined> {
    const r = await this.q(
      `SELECT data FROM optout_suppressions WHERE channel=$1 AND address=$2 AND (org_id IS NULL OR org_id=$3) AND data->>'removedAt' IS NULL LIMIT 1`, [channel, address, orgId ?? null]);
    return r.rows[0]?.['data'] as OptoutSuppression | undefined;
  }
  async listOptoutSuppressions(orgId?: ID): Promise<OptoutSuppression[]> {
    const r = orgId === undefined
      ? await this.q(`SELECT data FROM optout_suppressions`, [])
      : await this.q(`SELECT data FROM optout_suppressions WHERE org_id=$1 OR org_id IS NULL`, [orgId]);
    return r.rows.map(row => row['data'] as OptoutSuppression);
  }
  async removeOptoutSuppression(id: ID, by: ID, reason: string, at: string): Promise<OptoutSuppression | undefined> {
    return this.inTx(async c => {
      const r = await c.query(`SELECT data FROM optout_suppressions WHERE id=$1 FOR UPDATE`, [id]);
      const cur = r.rows[0]?.['data'] as OptoutSuppression | undefined;
      if (!cur || cur.removedAt) return undefined;
      const next = { ...cur, removedAt: at, removedBy: by, removeReason: reason };
      await c.query(`UPDATE optout_suppressions SET data=$2 WHERE id=$1`, [id, JSON.stringify(next)]);
      return next;
    });
  }
  async getIdempotencyRecord(orgId: ID, actorId: ID, route: string, clientMutationId: string): Promise<IdempotencyRecord | undefined> {
    const r = await this.q(`SELECT data FROM idempotency_records WHERE org_id=$1 AND actor_id=$2 AND route=$3 AND client_mutation_id=$4`, [orgId, actorId, route, clientMutationId]);
    return r.rows[0]?.['data'] as IdempotencyRecord | undefined;
  }
  async putIdempotencyRecord(rec: IdempotencyRecord): Promise<IdempotencyRecord> {
    await this.q(`INSERT INTO idempotency_records(org_id, actor_id, route, client_mutation_id, data) VALUES($1,$2,$3,$4,$5) ON CONFLICT (org_id, actor_id, route, client_mutation_id) DO NOTHING`, [rec.orgId, rec.actorId, rec.route, rec.clientMutationId, JSON.stringify(rec)]);
    return rec;
  }

  async appendAudit(e: AuditLogEntry): Promise<void> {
    await this.q(`INSERT INTO audit_log(org_id, data) VALUES($1,$2)`, [e.orgId, JSON.stringify(e)]);
  }
  async listAudit(orgId: ID): Promise<AuditLogEntry[]> {
    const r = await this.q(`SELECT data FROM audit_log WHERE org_id=$1 ORDER BY seq`, [orgId]);
    return r.rows.map(row => row['data'] as AuditLogEntry);
  }
}

/** PR-1(c): dispatcher restart-survival state (sent idempotency keys, recipient
 *  60s batch windows, staff opt-out suppressions) in Postgres. */
export function pgDispatchState(db: Queryable): DispatchStateStore {
  return {
    async hasDispatched(key) {
      const r = await db.query(`SELECT 1 FROM dispatch_sent_keys WHERE key=$1`, [key]);
      return r.rows.length > 0;
    },
    async markDispatched(key) {
      await db.query(`INSERT INTO dispatch_sent_keys(key) VALUES($1) ON CONFLICT (key) DO NOTHING`, [key]);
    },
    async getBatchWindowClose(address) {
      const r = await db.query(`SELECT closes_at_ms FROM dispatch_batch_windows WHERE address=$1`, [address]);
      const v = r.rows[0]?.['closes_at_ms'];
      return v === undefined || v === null ? undefined : Number(v);
    },
    async setBatchWindowClose(address, closeMs) {
      await db.query(
        `INSERT INTO dispatch_batch_windows(address, closes_at_ms) VALUES($1,$2)
         ON CONFLICT (address) DO UPDATE SET closes_at_ms=EXCLUDED.closes_at_ms`, [address, closeMs]);
    },
    async clearBatchWindow(address) {
      await db.query(`DELETE FROM dispatch_batch_windows WHERE address=$1`, [address]);
    },
    async isSuppressed(address) {
      const r = await db.query(`SELECT 1 FROM dispatch_suppressed WHERE address=$1`, [address]);
      return r.rows.length > 0;
    },
    async markSuppressed(address) {
      await db.query(`INSERT INTO dispatch_suppressed(address) VALUES($1) ON CONFLICT (address) DO NOTHING`, [address]);
    },
  };
}

export type { SeedData };

const OTP_DDL = `
CREATE TABLE IF NOT EXISTS otp_codes(phone text PRIMARY KEY, exp_ms bigint NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS otp_requests(phone text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS otp_verify_state(phone text PRIMARY KEY, attempts integer NOT NULL, locked_until_ms bigint);
CREATE TABLE IF NOT EXISTS auth_audit(seq bigserial PRIMARY KEY, phone text NOT NULL, kind text NOT NULL, data jsonb, created_at timestamptz NOT NULL DEFAULT now());
`;

/** Pilot-prep #4: shared OTP state in Postgres (multi-instance ready) — same
 *  adapter role as pgDispatchState. Code/request rows are plain upserts;
 *  the verify-attempt counter is an atomic INSERT .. ON CONFLICT .. RETURNING,
 *  so two instances racing wrong attempts still reach the lockout threshold
 *  exactly once. */
export async function createPgOtpState(db: Queryable): Promise<OtpStateStore> {
  for (const stmt of OTP_DDL.split(';').map(x => x.trim()).filter(Boolean)) await db.query(stmt);
  return {
    async getCode(phone) {
      const r = await db.query(`SELECT data, exp_ms FROM otp_codes WHERE phone=$1`, [phone]);
      const row = r.rows[0];
      if (!row) return undefined;
      return { ...(row['data'] as object), exp: Number(row['exp_ms']) } as OtpCodeEntry;
    },
    async setCode(phone, entry) {
      await db.query(
        `INSERT INTO otp_codes(phone, exp_ms, data) VALUES($1,$2,$3)
         ON CONFLICT (phone) DO UPDATE SET exp_ms=EXCLUDED.exp_ms, data=EXCLUDED.data`, [phone, entry.exp, entry]);
    },
    async deleteCode(phone) {
      await db.query(`DELETE FROM otp_codes WHERE phone=$1`, [phone]);
    },
    async recentRequests(phone, sinceMs) {
      const r = await db.query(`SELECT data->'ts' AS ts FROM otp_requests WHERE phone=$1`, [phone]);
      const ts = (r.rows[0]?.['ts'] as number[] | undefined) ?? [];
      return ts.filter(t => Number(t) > sinceMs);
    },
    async recordRequest(phone, tsMs) {
      await db.query(
        `INSERT INTO otp_requests(phone, data) VALUES($1, jsonb_build_object('ts', jsonb_build_array($2::bigint)))
         ON CONFLICT (phone) DO UPDATE SET data = jsonb_build_object('ts', (otp_requests.data->'ts') || to_jsonb($2::bigint))`, [phone, tsMs]);
    },
    async getVerifyState(phone) {
      const r = await db.query(`SELECT attempts, locked_until_ms FROM otp_verify_state WHERE phone=$1`, [phone]);
      const row = r.rows[0];
      if (!row) return undefined;
      const state: OtpVerifyState = { attempts: Number(row['attempts']) };
      if (row['locked_until_ms'] !== null && row['locked_until_ms'] !== undefined) state.lockedUntil = Number(row['locked_until_ms']);
      return state;
    },
    async incrementVerifyAttempts(phone) {
      const r = await db.query(
        `INSERT INTO otp_verify_state(phone, attempts, locked_until_ms) VALUES($1, 1, NULL)
         ON CONFLICT (phone) DO UPDATE SET attempts=otp_verify_state.attempts+1
         RETURNING attempts`, [phone]);
      return Number(r.rows[0]!['attempts']);
    },
    async setLockout(phone, untilMs) {
      await db.query(
        `INSERT INTO otp_verify_state(phone, attempts, locked_until_ms) VALUES($1, 0, $2)
         ON CONFLICT (phone) DO UPDATE SET attempts=0, locked_until_ms=$2`, [phone, untilMs]);
    },
    async resetVerifyState(phone) {
      await db.query(`DELETE FROM otp_verify_state WHERE phone=$1`, [phone]);
    },
    async appendAuthAudit(entry) {
      await db.query(`INSERT INTO auth_audit(phone, kind, data) VALUES($1,$2,$3)`, [entry.phone, entry.kind, entry.detail ?? null]);
    },
    async listAuthAudit(phone) {
      const r = phone
        ? await db.query(`SELECT phone, kind, data, created_at FROM auth_audit WHERE phone=$1 ORDER BY seq`, [phone])
        : await db.query(`SELECT phone, kind, data, created_at FROM auth_audit ORDER BY seq`);
      return r.rows.map(row => ({
        phone: String(row['phone']),
        kind: String(row['kind']),
        ...(row['data'] !== null && row['data'] !== undefined ? { detail: row['data'] } : {}),
        createdAt: row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']),
      }));
    },
  };
}
