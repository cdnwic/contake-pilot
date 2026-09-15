import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import type {
  Action, AuditLogEntry, ChangeRequest, DominoResult, EventNode, GraphSnapshot, ID, ProposedChange, PushSubscription, StatusReport, TaskNode,
  WhitelistEntry,
} from '@contake/core';
import {
  assertAcyclic, dependencyPath, getProfile, hasProfile, inScope, listProfiles, parseInstant,
  rawDecision, renderInstant, computeDomino, wouldCreateCycle, PROFILES_VERSION,
} from '@contake/core';
import { appEvents } from './services/events.js';
import { stripContactPhone, stripSubscriberFields } from './services/sanitize.js';
import { AuthService } from './auth.js';
import type { GraphRepository, UserRecord } from './repo/graph-repository.js';
import { ApiError, approveChange, proposeMutation, rejectChange, reportDecisionFor, applyDomino, actionOfChange , withAuditSafety } from './services/changes.js';
import { auditDenied, type DenialMeta, audit, deviceClassOf } from './services/audit.js';
import { buildApprovalNeededJob, recordJobs } from './services/notify.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: UserRecord;
  }
}

let seq = 0;
const newId = (p: string): ID => `${p}_${Date.now().toString(36)}_${(seq += 1)}`;

function fail(statusCode: number, code: string, messageHe: string, denial?: DenialMeta): never {
  throw new ApiError(statusCode, code, messageHe, denial);
}

/** Role-filtered graph (QA AC-RBAC-4 focus minimization, AC-ISO-2 site isolation). */
export function filteredGraph(snapshot: GraphSnapshot, user: UserRecord): GraphSnapshot {
  if (user.role === 'admin') return snapshot;
  const resources = stripSubscriberFields(snapshot.resources);
  if (user.role === 'field_manager') {
    const tasks = snapshot.tasks.filter(t => inScope(user.scopes, snapshot.event.id, t.siteId));
    const taskIds = new Set(tasks.map(t => t.id));
    const used = new Set(tasks.flatMap(t => t.assigneeResourceIds));
    return {
      event: snapshot.event,
      tasks,
      resources: resources.filter(r => used.has(r.id)),
      dependencies: snapshot.dependencies.filter(d => taskIds.has(d.fromTaskId) && taskIds.has(d.toTaskId)),
    };
  }
  // focus_worker: own active/planned tasks only, referenced resources only, no deps
  const own = snapshot.tasks.filter(
    t => user.linkedResourceId !== undefined
      && t.assigneeResourceIds.includes(user.linkedResourceId)
      && (t.status === 'planned' || t.status === 'active' || t.status === 'delayed'),
  );
  const used = new Set(own.flatMap(t => t.assigneeResourceIds));
  return {
    event: snapshot.event,
    tasks: own,
    // v1.12: focus_worker never receives contactPhone (manager-roles visibility only)
    resources: stripContactPhone(resources.filter(r => used.has(r.id))),
    dependencies: [],
  };
}

export function buildApp(repo: GraphRepository, auth: AuthService): FastifyInstance {
  const app = Fastify({ logger: false });

  // Pre-publish deploy-prep: CORS is opt-in via CORS_ORIGIN (comma-separated
  // allowed origins). Env absent -> no CORS headers at all (same-origin only),
  // so existing clients/tests see zero behavioral change.
  const corsOrigin = process.env['CORS_ORIGIN']?.split(',').map(o => o.trim()).filter(Boolean);
  if (corsOrigin && corsOrigin.length > 0) {
    void app.register(cors, { origin: corsOrigin });
  }

  app.setErrorHandler(async (err, req, reply) => {
    if (err instanceof ApiError) {
      // contracts v1.9: denied mutating-endpoint attempts append a standalone
      // outcome:'denied' audit row. Metadata is attached ONLY at mutating deny
      // sites, so reads, the domino.compute dry-run and 401s are excluded by
      // construction. auditDenied never throws - a broken audit store never
      // upgrades a denial.
      if (err.denial && req.principal) {
        const p = req.principal as UserRecord;
        await auditDenied(repo, {
          orgId: p.orgId, actorUserId: p.userId, role: p.role,
          deviceClass: deviceClassOf(req.headers['user-agent']),
        }, err.denial);
      }
      void reply.status(err.statusCode).send({ error: { code: err.code, messageHe: err.messageHe } });
      return;
    }
    void reply.status(500).send({ error: { code: 'INTERNAL', messageHe: 'שגיאת שרת' } });
  });

  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/v1/auth/') || req.url === '/v1/health') return;
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const user = await auth.authenticate(token);
    if (!user) {
      await reply.status(401).send({ error: { code: 'UNAUTHENTICATED', messageHe: 'נדרשת התחברות' } });
      return;
    }
    req.principal = user;
  });

  const me = (req: FastifyRequest): UserRecord => req.principal as UserRecord;
  const ua = (req: FastifyRequest): string | undefined => req.headers['user-agent'];

  // ---------- auth ----------
  app.post('/v1/auth/login', async (req) => {
    const body = (req.body ?? {}) as { email?: string; password?: string; phone?: string };
    // v1.18 §15: phone login is whitelist-gated - approved entries get a session
    // with NO OTP challenge; every other state 403s with the status in the code
    // so the FE renders the matching screen.
    if (body.phone) {
      const phone = normalizePhone(body.phone);
      if (wlThrottled(phone)) {
        await wlAudit(req, phone, 'whitelist.login', 'rate_limited', 'throttle_429');
        fail(429, 'RATE_LIMITED', 'יותר מדי בקשות — נסה שוב מאוחר יותר');
      }
      const res = await auth.loginWithPhone(phone);
      if ('token' in res) {
        await wlAudit(req, phone, 'whitelist.login', 'session', 'approved');
        return res;
      }
      await wlAudit(req, phone, 'whitelist.login', 'denied', 'not_approved', { status: res.status });
      const codeBy = { invited: 'WHITELIST_INVITED', pending_approval: 'WHITELIST_PENDING_APPROVAL', rejected: 'WHITELIST_REJECTED', unknown: 'WHITELIST_UNKNOWN' } as const;
      const msg = res.status === 'pending_approval' ? 'ממתין לאישור ההנהלה' : 'צור קשר עם המנהל';
      fail(403, codeBy[res.status as keyof typeof codeBy] ?? 'WHITELIST_UNKNOWN', msg);
    }
    if (!body.email || !body.password) fail(400, 'BAD_REQUEST', 'חסר אימייל או סיסמה');
    const res = await auth.login(body.email as string, body.password as string);
    if (!res) fail(401, 'BAD_CREDENTIALS', 'פרטי התחברות שגויים');
    return res;
  });
  app.post('/v1/auth/refresh', async (req) => ({ token: auth.issueToken((await me(req)).userId) }));
  app.post('/v1/auth/otp/request', async (req) => {
    const { phone } = (req.body ?? {}) as { phone?: string };
    if (!phone) fail(400, 'BAD_REQUEST', 'חסר מספר טלפון');
    const r = await auth.requestOtp(phone as string);
    if (r.rateLimited) fail(429, 'RATE_LIMITED', 'יותר מדי בקשות — נסה שוב מאוחר יותר');
    return { sent: true, ...(process.env['CONTAKE_DEV_OTP'] !== 'false' ? { devCode: r.devCode } : {}) };
  });
  app.post('/v1/auth/otp/verify', async (req) => {
    const { phone, code } = (req.body ?? {}) as { phone?: string; code?: string };
    if (!phone || !code) fail(400, 'BAD_REQUEST', 'חסר טלפון או קוד');
    const res = await auth.verifyOtp(phone as string, code as string);
    if (!res) fail(401, 'BAD_OTP', 'קוד שגוי או פג תוקף');
    return res;
  });
  // ---------- whitelist onboarding (contracts v1.18 §15) ----------
  // Matrix v1.4: whitelist.* = admin allow, every other role deny. Public auth
  // endpoints are per-phone rate-limited; whitelist-check is a phone-registered
  // oracle by design (demo posture, revisited at real pilot with OTP re-arm).
  const wlRate = new Map<string, number[]>();
  const wlThrottled = (key: string): boolean => {
    const nowMs = Date.now();
    const ts = (wlRate.get(key) ?? []).filter(t => nowMs - t < 60_000);
    ts.push(nowMs);
    wlRate.set(key, ts);
    return ts.length > 10;
  };
  // QA integrity acceptance: auth_audit rows carry normalized phone (or the
  // 'unknown' key when absent), stable kind, outcome + reasonCode, request
  // correlation id, UA-derived deviceClass - never IP, OTP, devCode, or token.
  // Appends are awaited: an auth_audit failure fails the request LOUD (500),
  // never a silent drop.
  const normalizePhone = (p: string): string => p.replace(/[\s()-]/g, '');
  const wlAudit = async (req: FastifyRequest, phone: string, kind: string, outcome: string, reasonCode: string, extra: Record<string, unknown> = {}): Promise<void> => {
    await auth.appendWhitelistAudit(phone, kind, {
      outcome, reasonCode, deviceClass: deviceClassOf(ua(req)), requestId: String(req.id), ...extra,
    });
  };
  const wlDeny = (user: UserRecord, action: Action, phone: string): void => {
    if (rawDecision(action, user.role) !== 'deny') return;
    fail(403, 'FORBIDDEN', 'אין לך הרשאה לפעולה זו', {
      reason: 'matrix_deny', action, entityType: 'whitelist_entry', entityId: phone, eventId: 'pending',
    });
  };

  app.post('/v1/whitelist', async (req) => {
    const user = await me(req);
    const { phone } = (req.body ?? {}) as { phone?: string };
    if (!phone) fail(400, 'BAD_REQUEST', 'חסר מספר טלפון');
    wlDeny(user, 'whitelist.invite', phone);
    // Round 8: the WHOLE invite mutation runs as one repository transition -
    // memory per-phone mutex / PG one tx holding the row. It can never
    // interleave a paused or rolling-back registration for the same phone.
    return repo.withWhitelistMutation(phone, async (before) => {
      const now = new Date().toISOString();
      // Upsert: re-invite resets to invited and clears decision fields (§15).
      const entry: WhitelistEntry = { phone, status: 'invited', orgId: user.orgId, createdAt: before?.createdAt ?? now };
      await withAuditSafety(repo, async () => {
        await repo.upsertWhitelistEntry(entry);
        await audit(repo, {
          orgId: user.orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
          action: 'whitelist.invite', entityType: 'whitelist_entry', entityId: phone,
          before, after: entry, deviceClass: deviceClassOf(ua(req)),
        });
      });
      appEvents.emit({ type: 'whitelist.updated', orgId: user.orgId, entry });
      return entry;
    });
  });

  app.get('/v1/whitelist', async (req) => {
    const user = await me(req);
    // Read endpoint: a non-admin is 403 without a denied-audit row (v1.9 mutating-only).
    if (rawDecision('whitelist.list', user.role) === 'deny') fail(403, 'FORBIDDEN', 'אין לך הרשאה לפעולה זו');
    const { status } = (req.query ?? {}) as { status?: WhitelistEntry['status'] };
    return { entries: await repo.listWhitelist(user.orgId, status) };
  });

  app.post('/v1/whitelist/:phone/approve', async (req) => {
    const user = await me(req);
    const { phone } = req.params as { phone: string };
    const body = (req.body ?? {}) as { role?: UserRecord['role']; linkedResourceId?: ID };
    wlDeny(user, 'whitelist.approve', phone);
    // Round 8: approve is one repository transition - the pending check and
    // every write share the unit (PG: row lock in one tx), so a concurrent
    // approve/reject re-reads the DECIDED state and conflicts out: exactly
    // one decision, one audit row, at most one account.
    return repo.withWhitelistMutation(phone, async (before) => {
      if (!before || before.status !== 'pending_approval') fail(409, 'WHITELIST_NOT_PENDING', 'הבקשה אינה ממתינה לאישור');
      if (!body.role || !['admin', 'field_manager', 'focus_worker'].includes(body.role)) fail(400, 'BAD_REQUEST', 'חסר תפקיד לאישור');
      if (body.role === 'focus_worker' && !body.linkedResourceId) fail(400, 'BAD_REQUEST', 'עובד מיקוד דורש קישור למשאב');
      // Create or bind the user account: role is ADMIN-assigned (requestedRole advisory).
      const existing = await repo.findUserByPhone(phone);
      const account = existing
        ? await repo.updateUser(existing.userId, { role: body.role, ...(body.linkedResourceId ? { linkedResourceId: body.linkedResourceId } : {}), active: true })
        : await repo.createUser({
            userId: newId('u'), orgId: user.orgId, name: before.displayName ?? phone,
            role: body.role, scopes: [], phone,
            ...(body.linkedResourceId ? { linkedResourceId: body.linkedResourceId } : {}), active: true,
          });
      const now = new Date().toISOString();
      const entry: WhitelistEntry = {
        ...before, status: 'approved', assignedRole: body.role,
        ...(body.linkedResourceId ? { linkedResourceId: body.linkedResourceId } : {}),
        decidedBy: user.userId, decidedAt: now,
      };
      await withAuditSafety(repo, async () => {
        await repo.upsertWhitelistEntry(entry);
        await audit(repo, {
          orgId: user.orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
          action: 'whitelist.approve', entityType: 'whitelist_entry', entityId: phone,
          before, after: entry, deviceClass: deviceClassOf(ua(req)),
        });
      });
      appEvents.emit({ type: 'whitelist.updated', orgId: user.orgId, entry });
      return { entry, user: account };
    });
  });

  app.post('/v1/whitelist/:phone/reject', async (req) => {
    const user = await me(req);
    const { phone } = req.params as { phone: string };
    const { reasonHe } = (req.body ?? {}) as { reasonHe?: string };
    wlDeny(user, 'whitelist.reject', phone);
    // Round 8: reject is one repository transition (same unit as approve).
    return repo.withWhitelistMutation(phone, async (before) => {
      if (!before || before.status !== 'pending_approval') fail(409, 'WHITELIST_NOT_PENDING', 'הבקשה אינה ממתינה לאישור');
      const entry: WhitelistEntry = {
        ...before, status: 'rejected', decidedBy: user.userId, decidedAt: new Date().toISOString(),
        ...(reasonHe ? { rejectedReasonHe: reasonHe } : {}),
      };
      await withAuditSafety(repo, async () => {
        await repo.upsertWhitelistEntry(entry);
        await audit(repo, {
          orgId: user.orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
          action: 'whitelist.reject', entityType: 'whitelist_entry', entityId: phone,
          before, after: entry, deviceClass: deviceClassOf(ua(req)),
        });
      });
      appEvents.emit({ type: 'whitelist.updated', orgId: user.orgId, entry });
      return entry;
    });
  });

  // Public (unauthenticated) auth endpoints.
  app.post('/v1/auth/whitelist-check', async (req) => {
    const rawPhone = ((req.body ?? {}) as { phone?: string }).phone;
    if (!rawPhone) {
      await wlAudit(req, 'unknown', 'whitelist.check', 'validation_failed', 'missing_phone');
      fail(400, 'BAD_REQUEST', 'חסר מספר טלפון');
    }
    const phone = normalizePhone(rawPhone);
    if (wlThrottled(phone)) {
      await wlAudit(req, phone, 'whitelist.check', 'rate_limited', 'throttle_429');
      fail(429, 'RATE_LIMITED', 'יותר מדי בקשות — נסה שוב מאוחר יותר');
    }
    const entry = await repo.getWhitelistEntry(phone);
    await wlAudit(req, phone, 'whitelist.check', entry ? 'found' : 'not_found', entry ? 'entry_exists' : 'no_entry', { status: entry?.status ?? 'unknown' });
    return { status: entry?.status ?? 'unknown' };
  });

  app.post('/v1/auth/whitelist-register', async (req) => {
    const body = (req.body ?? {}) as { phone?: string; displayName?: string; requestedRole?: UserRecord['role'] };
    if (!body.phone) {
      await wlAudit(req, 'unknown', 'whitelist.register', 'validation_failed', 'missing_phone');
      fail(400, 'BAD_REQUEST', 'חסרים שדות: phone, displayName, requestedRole');
    }
    const phone = normalizePhone(body.phone);
    if (!body.displayName || !body.requestedRole) {
      await wlAudit(req, phone, 'whitelist.register', 'validation_failed', 'missing_fields');
      fail(400, 'BAD_REQUEST', 'חסרים שדות: phone, displayName, requestedRole');
    }
    if (wlThrottled(phone)) {
      await wlAudit(req, phone, 'whitelist.register', 'rate_limited', 'throttle_429');
      fail(429, 'RATE_LIMITED', 'יותר מדי בקשות — נסה שוב מאוחר יותר');
    }
    if (!['admin', 'field_manager', 'focus_worker'].includes(body.requestedRole)) {
      await wlAudit(req, phone, 'whitelist.register', 'validation_failed', 'bad_role');
      fail(400, 'BAD_REQUEST', 'תפקיד לא תקין');
    }
    const entry = await repo.getWhitelistEntry(phone);
    if (!entry) {
      await wlAudit(req, phone, 'whitelist.register', 'rejected', 'unknown_phone');
      fail(409, 'WHITELIST_UNKNOWN', 'צור קשר עם המנהל');
    }
    // Idempotent re-submit of the SAME details returns 200 with the unchanged entry.
    if (entry.status === 'pending_approval' && entry.displayName === body.displayName && entry.requestedRole === body.requestedRole) {
      await wlAudit(req, phone, 'whitelist.register', 'duplicate', 'already_pending');
      return entry;
    }
    if (entry.status !== 'invited') {
      await wlAudit(req, phone, 'whitelist.register', 'rejected', 'not_invited', { status: entry.status });
      fail(409, 'WHITELIST_NOT_INVITED', 'הבקשה אינה פתוחה לרישום');
    }
    const next: WhitelistEntry = { ...entry, status: 'pending_approval', displayName: body.displayName, requestedRole: body.requestedRole };
    // QA gate (round 5): the pre-write row records the ACCEPTED request (fail
    // loud - a failed append aborts before any mutation). The transition and
    // the committed SUCCESS row then commit as ONE repository-level CAS unit
    // (PG: UPDATE ... WHERE status='invited' + INSERT in one tx; memory: one
    // synchronous block with exact-prior-object restore): no false success
    // ledger, exactly one winner under concurrency, and a failed unit leaves
    // the entry invited so a retry is unambiguous.
    await wlAudit(req, phone, 'whitelist.register', 'accepted', 'pending_approval');
    const commit = await auth.commitWhitelistRegistration(next, 'whitelist.register', {
      outcome: 'success', reasonCode: 'committed', deviceClass: deviceClassOf(ua(req)), requestId: String(req.id),
    });
    if (commit === 'duplicate') {
      // Deterministic loser: a concurrent winner took the transition - no
      // state write and no committed row from this request.
      await wlAudit(req, phone, 'whitelist.register', 'duplicate', 'concurrent_lost');
      fail(409, 'WHITELIST_NOT_INVITED', 'הבקשה אינה פתוחה לרישום');
    }
    // NOTE: no audit_log row for this unauthenticated transition (AuditLogEntry.role
    // is the strict Role union and a fabricated role would corrupt QA's AC-AUD
    // trail). The immutable record lives in auth_audit (appended above, QA
    // integrity gate); the transition also emits whitelist.updated and appears as
    // beforeJson of the eventual admin approve/reject row.
    appEvents.emit({ type: 'whitelist.updated', orgId: entry.orgId, entry: next });
    // In-app notify to org admins (§15); outbound channels stay OFF (demo posture).
    const admins = (await repo.listUsers(entry.orgId)).filter(u => u.role === 'admin');
    if (admins.length > 0) {
      await recordJobs(repo, [{
        id: newId('job'), eventId: 'pending', kind: 'change_needs_approval',
        targets: admins.map(u => ({ channel: 'in_app' as const, address: u.userId, recipientLabel: u.name })).sort((a, b) => a.address.localeCompare(b.address)),
        templateKey: 'change_needs_approval',
        params: { summaryHe: `משתמש חדש ממתין לאישור: ${body.displayName} (${body.phone})` },
        idempotencyKey: `${entry.orgId}+whitelist+${body.phone}+pending_approval`,
        batchWindowSec: 60, createdAt: new Date().toISOString(),
      }]);
    }
    return next;
  });

  app.get('/v1/health', () => ({ ok: true }));


  // ---------- web push (contracts v1.10) ----------
  // Self-service subscription management, OUTSIDE the 22-action matrix (same
  // precedent as auth/OTP endpoints): the owner check is the authorization.
  // Mutations are audited (QA §9); a cross-user attempt is an authz failure ->
  // 403 + v1.9 denied audit. endpoint/keys never leave this surface for any
  // principal but their owner (QA-M2-3 analog).

  // Minimal per-user mutation throttle (20/min), same role as auth rate limits.
  const pushRate = new Map<ID, number[]>();
  const pushThrottled = (userId: ID): boolean => {
    const nowMs = Date.now();
    const ts = (pushRate.get(userId) ?? []).filter(t => nowMs - t < 60_000);
    ts.push(nowMs);
    pushRate.set(userId, ts);
    return ts.length > 20;
  };

  app.get('/v1/push/vapid-public-key', async () => ({ publicKey: process.env['VAPID_PUBLIC_KEY'] ?? null }));

  app.post('/v1/push/subscriptions', async (req) => {
    const user = await me(req);
    if (pushThrottled(user.userId)) fail(429, 'RATE_LIMITED', 'יותר מדי בקשות — נסה שוב מאוחר יותר');
    const body = (req.body ?? {}) as { endpoint?: string; keys?: { p256dh?: string; auth?: string }; deviceClass?: string };
    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) fail(400, 'BAD_REQUEST', 'מנוי push לא תקין');
    // An endpoint already registered to ANOTHER user is an authz failure, not a takeover.
    const existing = await repo.getPushSubscriptionByEndpoint(body.endpoint);
    if (existing && existing.userId !== user.userId) {
      fail(403, 'FORBIDDEN', 'אין הרשאה למנוי זה', {
        reason: 'scope_violation', action: 'push.subscribe', entityType: 'push_subscription',
        entityId: existing.id, eventId: 'pending',
      });
    }
    const sub: PushSubscription = {
      id: existing?.id ?? newId('psub'),
      orgId: user.orgId,
      userId: user.userId,
      endpoint: body.endpoint,
      keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
      deviceClass: body.deviceClass ?? deviceClassOf(ua(req)),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    const saved = await withAuditSafety(repo, async () => {
      const out = await repo.upsertPushSubscription(sub);
      await audit(repo, {
        orgId: user.orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
        action: 'push.subscribe', entityType: 'push_subscription', entityId: out.id,
        after: { endpoint: out.endpoint, deviceClass: out.deviceClass },
        deviceClass: deviceClassOf(ua(req)),
      });
      return out;
    });
    return { subscription: saved };
  });

  app.get('/v1/push/subscriptions', async (req) => {
    const user = await me(req);
    return { subscriptions: await repo.listPushSubscriptions(user.userId) };
  });

  app.delete('/v1/push/subscriptions', async (req) => {
    const user = await me(req);
    if (pushThrottled(user.userId)) fail(429, 'RATE_LIMITED', 'יותר מדי בקשות — נסה שוב מאוחר יותר');
    const { endpoint } = (req.body ?? {}) as { endpoint?: string };
    if (!endpoint) fail(400, 'BAD_REQUEST', 'חסר endpoint');
    const existing = await repo.getPushSubscriptionByEndpoint(endpoint);
    if (!existing) fail(404, 'NOT_FOUND', 'המנוי לא נמצא');
    if (existing.userId !== user.userId) {
      fail(403, 'FORBIDDEN', 'אין הרשאה למנוי זה', {
        reason: 'scope_violation', action: 'push.unsubscribe', entityType: 'push_subscription',
        entityId: existing.id, eventId: 'pending',
      });
    }
    await withAuditSafety(repo, async () => {
      await repo.deletePushSubscription(user.userId, endpoint);
      await audit(repo, {
        orgId: user.orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
        action: 'push.unsubscribe', entityType: 'push_subscription', entityId: existing.id,
        before: { endpoint }, deviceClass: deviceClassOf(ua(req)),
      });
    });
    return { deleted: true };
  });

  // ---------- profiles ----------
  app.get('/v1/profiles', () => ({ version: PROFILES_VERSION, profiles: listProfiles() }));

  // ---------- events ----------
  app.get('/v1/events', async (req) => {
    const user = await me(req);
    let events = await repo.listEvents(user.orgId);
    if (user.role === 'field_manager') {
      events = events.filter(e => e.siteIds.some(s => inScope(user.scopes, e.id, s)));
    } else if (user.role === 'focus_worker') {
      const kept: EventNode[] = [];
      for (const e of events) {
        const ts = await repo.listTasks(e.id);
        if (ts.some(t => user.linkedResourceId !== undefined && t.assigneeResourceIds.includes(user.linkedResourceId))) kept.push(e);
      }
      events = kept;
    }
    return { events };
  });

  app.post('/v1/events', async (req) => {
    const user = await me(req);
    const body = (req.body ?? {}) as { name?: string; date?: string; timezone?: string; domainProfileId?: string; siteIds?: ID[] };
    if (!body.name || !body.date || !body.timezone || !body.domainProfileId || !body.siteIds?.length) {
      fail(400, 'BAD_REQUEST', 'חסרים שדות חובה: name, date, timezone, domainProfileId, siteIds');
    }
    // Stage 1 hardening: unknown domain profiles are a client error, not a silent fallback.
    if (!hasProfile(body.domainProfileId as string)) fail(400, 'UNKNOWN_PROFILE', 'פרופיל תחום לא מוכר');
    const change: ProposedChange = {
      type: 'event.create',
      event: {
        kind: 'event', orgId: user.orgId, domainProfileId: body.domainProfileId as string,
        name: body.name as string, date: body.date as string, timezone: body.timezone as string,
        siteIds: body.siteIds as ID[], status: 'draft',
      },
    };
    // event.create has no graph context yet; decide from the matrix directly
    const decision = rawDecision('event.create', user.role);
    if (decision === 'deny') {
      fail(403, 'FORBIDDEN', 'אין לך הרשאה לפעולה זו', {
        reason: 'matrix_deny', action: 'event.create', entityType: 'event', entityId: 'pending', eventId: 'pending',
      });
    }
    if (decision === 'propose') {
      const cr: ChangeRequest = {
        id: newId('cr'), eventId: 'pending', proposedBy: user.userId, role: user.role,
        baseGraphVersion: 0, change, dominoResult: {
          ok: true, movedTasks: [], blockedTaskIds: [], impacts: [], conflicts: [], maxImpactClass: 'S0',
          summaryHe: 'אין אפקט דומינו: רק המשימה עצמה משתנה',
        },
        state: 'pending_review', reasonHe: 'יצירת אירוע חדש — נדרש אישור מנהל-על', createdAt: new Date().toISOString(),
      };
      await withAuditSafety(repo, async () => {
        await repo.createChangeRequest(cr);
        await audit(repo, {
          orgId: user.orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
          action: 'event.create', entityType: 'change_request', entityId: cr.id, after: cr, deviceClass: deviceClassOf(ua(req)),
        });
      });
      appEvents.emit({ type: 'change.pending', changeRequest: cr });
      // RT-PIN-1 (TL ruling): every CR-originating path records the approval job.
      // The event does not exist yet — the job hangs on eventId 'pending'; targets
      // are org admins regardless.
      await recordJobs(repo, [await buildApprovalNeededJob({
        repo,
        event: { ...change.event, id: 'pending', version: 0 },
        profile: getProfile(change.event.domainProfileId),
        changeRequestId: cr.id,
        summaryHe: cr.dominoResult.summaryHe,
      })]);
      return { changeRequest: cr };
    }
    const event = { ...change.event, id: newId('evt'), version: 1 };
    await withAuditSafety(repo, async () => {
      await repo.createEvent(event);
      await audit(repo, {
        orgId: user.orgId, eventId: event.id, actorUserId: user.userId, role: user.role,
        action: 'event.create', entityType: 'event', entityId: event.id, after: event, deviceClass: deviceClassOf(ua(req)),
      });
    });
    return { applied: { event } };
  });

  // Builder WP (additive, contracts v1.11 candidate): duplicate an event's full
  // day graph (tasks + dependencies + resources) onto a new date. Event-per-day
  // model: powers "same schedule tomorrow". Task starts keep their wall time;
  // only the date prefix is swapped (event-local rendering does the rest).
  // RBAC: same gate as event.create; 'propose' roles get 403 for now (no CR
  // path in v1 of this route — flagged to TL).
  app.post('/v1/events/:id/duplicate', async (req) => {
    const user = await me(req);
    const { id } = req.params as { id: string };
    const src = await loadEvent(req, id);
    const body = (req.body ?? {}) as { date?: string; name?: string };
    if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) fail(400, 'BAD_REQUEST', 'חסר שדה חובה: date (YYYY-MM-DD)');
    const decision = rawDecision('event.create', user.role);
    if (decision !== 'allow') {
      fail(403, 'FORBIDDEN', 'אין לך הרשאה לפעולה זו', {
        reason: 'matrix_deny', action: 'event.create', entityType: 'event', entityId: 'pending', eventId: id,
      });
    }
    const [tasks, resources, deps] = await Promise.all([
      repo.listTasks(id), repo.listResources(id), repo.listDependencies(id),
    ]);
    const event: EventNode = {
      kind: 'event', id: newId('evt'), orgId: src.orgId, domainProfileId: src.domainProfileId,
      name: body.name ?? src.name, date: body.date, timezone: src.timezone,
      siteIds: [...src.siteIds], status: 'draft', version: 1,
    };
    const resIdMap = new Map<ID, ID>();
    const taskIdMap = new Map<ID, ID>();
    const shiftStart = (start: string | null): string | null =>
      start === null ? null : body.date + start.slice(10);
    await withAuditSafety(repo, async () => {
      await repo.createEvent(event);
      for (const r of resources) {
        const nid = newId('res');
        resIdMap.set(r.id, nid);
        await repo.createResource({
          kind: 'resource', id: nid, eventId: event.id, resourceKind: r.resourceKind, name: r.name,
          exclusive: r.exclusive, ...(r.capacity !== undefined ? { capacity: r.capacity } : {}),
          ...(r.memberIds ? { memberIds: r.memberIds.map(m => resIdMap.get(m) ?? m) } : {}),
          ...(r.subscriberChannelIds ? { subscriberChannelIds: [...r.subscriberChannelIds] } : {}),
          version: 1,
        });
      }
      // second pass fixes memberIds that pointed at not-yet-copied resources
      for (const r of resources) {
        if (!r.memberIds) continue;
        const mapped = r.memberIds.map(m => resIdMap.get(m) ?? m);
        if (mapped.some((m, i) => m !== r.memberIds![i])) {
          await repo.updateResource(resIdMap.get(r.id)!, { memberIds: mapped });
        }
      }
      for (const t of tasks) {
        const nid = newId('tsk');
        taskIdMap.set(t.id, nid);
        await repo.createTask({
          kind: 'task', id: nid, eventId: event.id, siteId: t.siteId, name: t.name,
          start: shiftStart(t.start), durationMin: t.durationMin, status: 'planned',
          locked: t.locked, assigneeResourceIds: t.assigneeResourceIds.map(a => resIdMap.get(a) ?? a),
          version: 1,
        });
      }
      for (const d of deps) {
        await repo.createDependency({
          kind: 'depends_on', id: newId('dep'),
          fromTaskId: taskIdMap.get(d.fromTaskId) ?? d.fromTaskId,
          toTaskId: taskIdMap.get(d.toTaskId) ?? d.toTaskId,
          lagMin: d.lagMin, hard: d.hard,
        });
      }
      // TL ruling 2026-09-14: counselor bindings survive event duplication - same
      // userIds, scope preserved, eventId repointed to the new event, siteIds remapped
      // positionally (the duplicate keeps the SAME site ids today, so the map is the
      // identity). Implicit like the tasks/resources copy: no contract surface change.
      const siteIdMap = new Map(src.siteIds.map((s, i) => [s, event.siteIds[i] ?? s]));
      let bindingsCloned = 0;
      for (const u of await repo.listUsers(src.orgId)) {
        const bound = u.scopes.filter(s => s.eventId === id);
        if (bound.length === 0) continue;
        const clones = bound.map(s => ({ eventId: event.id as ID, ...(s.siteId !== undefined ? { siteId: siteIdMap.get(s.siteId) ?? s.siteId } : {}) }));
        await repo.updateUser(u.userId, { scopes: [...u.scopes, ...clones] });
        bindingsCloned += clones.length;
      }
      await audit(repo, {
        orgId: user.orgId, eventId: event.id, actorUserId: user.userId, role: user.role,
        action: 'event.create', entityType: 'event', entityId: event.id,
        after: { ...event, duplicatedFrom: id, counts: { tasks: tasks.length, resources: resources.length, dependencies: deps.length, bindings: bindingsCloned } },
        deviceClass: deviceClassOf(ua(req)),
      });
    });
    return { applied: { event, duplicatedFrom: id, copied: { tasks: tasks.length, resources: resources.length, dependencies: deps.length } } };
  });

  const loadEvent = async (req: FastifyRequest, id: string) => {
    const event = await repo.getEvent(id);
    if (!event || event.orgId !== await me(req).orgId) fail(404, 'NOT_FOUND', 'האירוע לא נמצא');
    return event;
  };

  app.get('/v1/events/:id/graph', async (req) => {
    const { id } = req.params as { id: string };
    await loadEvent(req, id);
    const snapshot = await repo.snapshot(id);
    if (!snapshot) fail(404, 'NOT_FOUND', 'האירוע לא נמצא');
    return filteredGraph(snapshot, await me(req));
  });

  app.patch('/v1/events/:id', async (req) => {
    const user = await me(req);
    const { id } = req.params as { id: string };
    const event = await loadEvent(req, id);
    const body = (req.body ?? {}) as { version?: number; patch?: { name?: string; date?: string; timezone?: string } };
    if (body.version !== event.version) fail(409, 'VERSION_CONFLICT', 'הגרף השתנה במקביל — רענן ונסה שוב');
    const change: ProposedChange = { type: 'event.update', eventId: id, patch: body.patch ?? {} };
    return proposeMutation(repo, withOrg(user), 'event.update', change, id, ua(req));
  });

  app.delete('/v1/events/:id', async (req) => {
    const user = await me(req);
    const { id } = req.params as { id: string };
    const event = await loadEvent(req, id);
    if (rawDecision('event.delete', user.role) !== 'allow') {
      fail(403, 'FORBIDDEN', 'אין לך הרשאה לפעולה זו', {
        reason: 'matrix_deny', action: 'event.delete', entityType: 'event', entityId: id, eventId: id,
      });
    }
    // QA-M2-7: actually delete (cascade); QA-M2-4: deletion+audit are atomic.
    await withAuditSafety(repo, async () => {
      await repo.deleteEvent(id);
      await audit(repo, {
        orgId: user.orgId, eventId: id, actorUserId: user.userId, role: user.role,
        action: 'event.delete', entityType: 'event', entityId: id, before: event, after: { deleted: true },
        deviceClass: deviceClassOf(ua(req)),
      });
    });
    return { applied: { deleted: id } };
  });

  app.post('/v1/events/:id/publish', async (req) => {
    const user = await me(req);
    const { id } = req.params as { id: string };
    await loadEvent(req, id);
    const change: ProposedChange = { type: 'event.publish', eventId: id };
    return proposeMutation(repo, withOrg(user), 'event.publish', change, id, ua(req));
  });

  // ---------- tasks ----------
  app.post('/v1/events/:id/tasks', async (req) => {
    const user = await me(req);
    const { id } = req.params as { id: string };
    await loadEvent(req, id);
    const body = (req.body ?? {}) as { task?: Partial<TaskNode> };
    const t = body.task;
    if (!t?.name || t.durationMin === undefined || !t.siteId) fail(400, 'BAD_REQUEST', 'חסרים שדות משימה: name, durationMin, siteId');
    // same envelope class as QA C4: a floating client-supplied start would 500
    // inside computeDomino - validate at the envelope with the pinned 400
    if (t.start !== undefined && t.start !== null) {
      try { parseInstant(t.start); } catch { fail(400, 'BAD_REQUEST', 'start חייב לכלול אזור זמן (למשל 2026-09-14T10:00:00+03:00)'); }
    }
    const change: ProposedChange = {
      type: 'task.create',
      task: {
        kind: 'task', eventId: id, siteId: t.siteId, name: t.name,
        start: t.start ?? null, durationMin: t.durationMin, status: 'planned',
        locked: t.locked ?? false, assigneeResourceIds: t.assigneeResourceIds ?? [],
      },
    };
    return proposeMutation(repo, withOrg(user), 'task.create', change, id, ua(req));
  });

  app.patch('/v1/tasks/:id', async (req) => {
    const user = await me(req);
    const { id } = req.params as { id: string };
    const task = await repo.getTask(id);
    if (!task) fail(404, 'NOT_FOUND', 'המשימה לא נמצאה');
    await loadEvent(req, task.eventId);
    const body = (req.body ?? {}) as {
      version?: number;
      patch?: { name?: string; durationMin?: number; status?: TaskNode['status'] };
      move?: { newStart: string };
      assign?: { assigneeResourceIds: ID[] };
    };
    if (body.version !== task.version) fail(409, 'VERSION_CONFLICT', 'הגרף השתנה במקביל — רענן ונסה שוב');
    let change: ProposedChange;
    if (body.move) {
      // QA C4 / contracts §11: floating local time -> the pinned 400, never a 500
      try { parseInstant(body.move.newStart); } catch { fail(400, 'BAD_REQUEST', 'newStart חייב לכלול אזור זמן (למשל 2026-09-14T10:00:00+03:00)'); }
      // QA-M1-1 (Sev-1): locked-trigger move rejected for EVERY role; unlock first.
      if (task.locked) fail(409, 'LOCK_VIOLATION', 'המשימה נעולה — שחרר נעילה לפני הזזה');
      change = { type: 'task.move', taskId: id, newStart: body.move.newStart };
    } else if (body.assign) {
      change = { type: 'task.assign', taskId: id, assigneeResourceIds: body.assign.assigneeResourceIds };
    } else if (body.patch) {
      change = { type: 'task.update', taskId: id, patch: body.patch };
    } else {
      fail(400, 'BAD_REQUEST', 'חסר שינוי: patch / move / assign');
    }
    return proposeMutation(repo, withOrg(user), actionOfChange(change), change, task.eventId, ua(req));
  });

  app.delete('/v1/tasks/:id', async (req) => {
    const user = await me(req);
    const { id } = req.params as { id: string };
    const task = await repo.getTask(id);
    if (!task) fail(404, 'NOT_FOUND', 'המשימה לא נמצאה');
    const event = await loadEvent(req, task.eventId);
    // QA-M1-3: delete of a published task with external subscribers is forbidden —
    // cancel (task.update status=cancelled) is the only path, so subscribers hear.
    if (event.status === 'published') {
      let hasSubscribers = false;
      for (const rid of task.assigneeResourceIds) {
        const r = await repo.getResource(rid);
        if ((r?.subscriberChannelIds?.length ?? 0) > 0) { hasSubscribers = true; break; }
      }
      if (hasSubscribers) fail(409, 'TASK_HAS_SUBSCRIBERS', 'למשימה שפורסמה יש נרשמים — בטל את המשימה במקום למחוק');
    }
    const change: ProposedChange = { type: 'task.delete', taskId: id };
    return proposeMutation(repo, withOrg(user), 'task.delete', change, task.eventId, ua(req));
  });

  for (const [path, lock] of [['/v1/tasks/:id/lock', true], ['/v1/tasks/:id/unlock', false]] as const) {
    app.post(path, async (req) => {
      const user = await me(req);
      const { id } = req.params as { id: string };
      const task = await repo.getTask(id);
      if (!task) fail(404, 'NOT_FOUND', 'המשימה לא נמצאה');
      await loadEvent(req, task.eventId);
      const change: ProposedChange = lock
        ? { type: 'constraint.lock', taskId: id }
        : { type: 'constraint.unlock', taskId: id };
      return proposeMutation(repo, withOrg(user), lock ? 'constraint.lock' : 'constraint.unlock', change, task.eventId, ua(req));
    });
  }

  // ---------- resources ----------
  app.post('/v1/events/:id/resources', async (req) => {
    const user = await me(req);
    const { id } = req.params as { id: string };
    await loadEvent(req, id);
    const body = (req.body ?? {}) as { resource?: { resourceKind?: never; name?: string; exclusive?: boolean; memberIds?: ID[]; subscriberChannelIds?: ID[]; capacity?: number; contactPhone?: string } };
    const r = body.resource;
    if (!r?.resourceKind || !r.name || r.exclusive === undefined) fail(400, 'BAD_REQUEST', 'חסרים שדות משאב: resourceKind, name, exclusive');
    // v1.12: contactPhone is an operational contact for kind 'person' only
    if (r.contactPhone !== undefined && r.resourceKind !== 'person') fail(400, 'BAD_REQUEST', 'contactPhone זמין רק למשאב מסוג person');
    const change: ProposedChange = {
      type: 'resource.create',
      resource: {
        kind: 'resource', eventId: id, resourceKind: r.resourceKind, name: r.name,
        exclusive: r.exclusive, ...(r.memberIds ? { memberIds: r.memberIds } : {}),
        ...(r.subscriberChannelIds ? { subscriberChannelIds: r.subscriberChannelIds } : {}),
        ...(r.capacity !== undefined ? { capacity: r.capacity } : {}),
        ...(r.contactPhone ? { contactPhone: r.contactPhone } : {}),
      },
    };
    return proposeMutation(repo, withOrg(user), 'resource.create', change, id, ua(req));
  });

  app.patch('/v1/resources/:id', async (req) => {
    const user = await me(req);
    const { id } = req.params as { id: string };
    const res = await repo.getResource(id);
    if (!res) fail(404, 'NOT_FOUND', 'המשאב לא נמצא');
    await loadEvent(req, res.eventId);
    const body = (req.body ?? {}) as { patch?: { name?: string; exclusive?: boolean; memberIds?: ID[]; subscriberChannelIds?: ID[]; contactPhone?: string } };
    // v1.12: contactPhone stays a person-only field on update too
    if (body.patch?.contactPhone !== undefined && res.resourceKind !== 'person') fail(400, 'BAD_REQUEST', 'contactPhone זמין רק למשאב מסוג person');
    const change: ProposedChange = { type: 'resource.update', resourceId: id, patch: body.patch ?? {} };
    return proposeMutation(repo, withOrg(user), 'resource.update', change, res.eventId, ua(req));
  });

  app.delete('/v1/resources/:id', async (req) => {
    const user = await me(req);
    const { id } = req.params as { id: string };
    const res = await repo.getResource(id);
    if (!res) fail(404, 'NOT_FOUND', 'המשאב לא נמצא');
    await loadEvent(req, res.eventId);
    const change: ProposedChange = { type: 'resource.delete', resourceId: id };
    return proposeMutation(repo, withOrg(user), 'resource.delete', change, res.eventId, ua(req));
  });

  // ---------- dependencies ----------
  app.post('/v1/events/:id/dependencies', async (req) => {
    const user = await me(req);
    const { id } = req.params as { id: string };
    const snapshot = await repo.snapshot(id);
    if (!snapshot || snapshot.event.orgId !== user.orgId) fail(404, 'NOT_FOUND', 'האירוע לא נמצא');
    const body = (req.body ?? {}) as { fromTaskId?: ID; toTaskId?: ID; lagMin?: number; hard?: boolean };
    if (!body.fromTaskId || !body.toTaskId) fail(400, 'BAD_REQUEST', 'חסרים fromTaskId / toTaskId');
    const nameOf = (tid: ID): string => snapshot.tasks.find(t => t.id === tid)?.name ?? tid;
    if (!snapshot.tasks.some(t => t.id === body.fromTaskId) || !snapshot.tasks.some(t => t.id === body.toTaskId)) {
      fail(400, 'BAD_REQUEST', 'קצות התלות חייבים להיות משימות של האירוע');
    }
    if (wouldCreateCycle(snapshot.dependencies, body.fromTaskId, body.toTaskId)) {
      const cycle = dependencyPath(snapshot.dependencies, body.toTaskId, body.fromTaskId) ?? [body.fromTaskId, body.toTaskId];
      fail(400, 'DEPENDENCY_CYCLE', `קשר תלות מעגלי אסור: ${cycle.map(nameOf).join(' ← ')}`);
    }
    const change: ProposedChange = {
      type: 'dependency.create',
      edge: {
        kind: 'depends_on', fromTaskId: body.fromTaskId, toTaskId: body.toTaskId,
        lagMin: body.lagMin ?? 0, hard: body.hard ?? true,
      },
    };
    return proposeMutation(repo, withOrg(user), 'dependency.create', change, id, ua(req));
  });

  app.delete('/v1/dependencies/:id', async (req) => {
    const user = await me(req);
    const { id } = req.params as { id: string };
    const dep = await repo.getDependency(id);
    if (!dep) fail(404, 'NOT_FOUND', 'התלות לא נמצאה');
    const task = await repo.getTask(dep.fromTaskId);
    if (!task) fail(404, 'NOT_FOUND', 'התלות לא נמצאה');
    await loadEvent(req, task.eventId);
    const change: ProposedChange = { type: 'dependency.delete', dependencyId: id };
    return proposeMutation(repo, withOrg(user), 'dependency.delete', change, task.eventId, ua(req));
  });

  // ---------- domino dry-run (scope-checked, QA C6; never a CR, matrix v1.2) ----------
  app.post('/v1/domino/compute', async (req) => {
    const user = await me(req);
    if (rawDecision('domino.compute', user.role) === 'deny') fail(403, 'FORBIDDEN', 'אין לך הרשאה לפעולה זו');
    const body = (req.body ?? {}) as { eventId?: ID; change?: ProposedChange };
    if (!body.eventId || !body.change) fail(400, 'BAD_REQUEST', 'חסרים eventId / change');
    const snapshot = await repo.snapshot(body.eventId);
    if (!snapshot || snapshot.event.orgId !== user.orgId) fail(404, 'NOT_FOUND', 'האירוע לא נמצא');
    const changeTaskId = 'taskId' in body.change ? body.change.taskId : undefined;
    const task = changeTaskId ? snapshot.tasks.find(t => t.id === changeTaskId) : undefined;
    if (changeTaskId && !task) fail(404, 'NOT_FOUND', 'המשימה לא נמצאה');
    if (user.role === 'field_manager' && task && !inScope(user.scopes, snapshot.event.id, task.siteId)) {
      fail(403, 'OUT_OF_SCOPE', 'המשימה מחוץ לתחום האחריות שלך');
    }
    const result = computeDomino(snapshot, body.change, getProfile(snapshot.event.domainProfileId));
    if (user.role === 'field_manager') {
      const keep = new Set(snapshot.tasks.filter(t => inScope(user.scopes, snapshot.event.id, t.siteId)).map(t => t.id));
      return {
        ...result,
        movedTasks: result.movedTasks.filter(m => keep.has(m.taskId)),
        blockedTaskIds: result.blockedTaskIds.filter(t => keep.has(t)),
        impacts: result.impacts.filter(i => keep.has(i.taskId)),
        conflicts: result.conflicts.map(c => ({ ...c, taskIds: c.taskIds.filter(t => keep.has(t)) })),
      };
    }
    return result;
  });

  // ---------- change requests ----------
  app.get('/v1/changes', async (req) => {
    const user = await me(req);
    const { eventId, state } = req.query as { eventId?: ID; state?: string };
    let crs = await repo.listChangeRequests({ ...(eventId ? { eventId } : {}), ...(state ? { state } : {}) });
    {
      const kept: ChangeRequest[] = [];
      for (const cr of crs) {
        const ev = await repo.getEvent(cr.eventId);
        if (cr.eventId === 'pending' ? cr.proposedBy === user.userId || user.role === 'admin' : ev?.orgId === user.orgId) kept.push(cr);
      }
      crs = kept;
    }
    if (user.role === 'field_manager') {
      const kept: ChangeRequest[] = [];
      for (const cr of crs) {
        if (cr.proposedBy === user.userId) { kept.push(cr); continue; }
        const tid = 'taskId' in cr.change ? cr.change.taskId : undefined;
        const task = tid ? await repo.getTask(tid) : undefined;
        if (task ? inScope(user.scopes, task.eventId, task.siteId) : false) kept.push(cr);
      }
      crs = kept;
    }
    if (user.role === 'focus_worker') {
      crs = crs.filter(cr => cr.proposedBy === user.userId);
    }
    return { changeRequests: crs };
  });

  app.post('/v1/changes/:id/approve', async (req) => {
    const { id } = req.params as { id: string };
    return approveChange(repo, withOrg(await me(req)), id, ua(req));
  });

  app.post('/v1/changes/:id/reject', async (req) => {
    const { id } = req.params as { id: string };
    const { reasonHe } = (req.body ?? {}) as { reasonHe?: string };
    const cr = await rejectChange(repo, withOrg(await me(req)), id, reasonHe, ua(req));
    return { changeRequest: cr };
  });

  // ---------- field reports (Focus Mode; dedupe on clientReportId, QA C3) ----------
  app.post('/v1/reports', async (req) => {
    const user = await me(req);
    if (rawDecision('report.status.create', user.role) === 'deny') {
      fail(403, 'FORBIDDEN', 'אין לך הרשאה לפעולה זו', {
        reason: 'matrix_deny', action: 'report.status.create', entityType: 'task', entityId: 'pending', eventId: 'pending',
      });
    }
    const body = (req.body ?? {}) as {
      taskId?: ID; status?: StatusReport['status']; delayMin?: number; noteHe?: string;
      clientReportId?: string; clientTimestamp?: string;
    };
    if (!body.taskId || !body.status || !body.clientReportId || !body.clientTimestamp) {
      fail(400, 'BAD_REQUEST', 'חסרים taskId / status / clientReportId / clientTimestamp');
    }
    const existing = await repo.getReportByClientId(body.clientReportId);
    if (existing) return { report: existing, deduped: true };
    const task = await repo.getTask(body.taskId);
    if (!task) fail(404, 'NOT_FOUND', 'המשימה לא נמצאה');
    const snapshot = await repo.snapshot(task.eventId);
    if (!snapshot || snapshot.event.orgId !== user.orgId) fail(404, 'NOT_FOUND', 'המשימה לא נמצאה');

    const report: StatusReport = {
      id: newId('rep'),
      clientReportId: body.clientReportId,
      taskId: task.id,
      reportedBy: user.userId,
      status: body.status,
      ...(body.delayMin !== undefined ? { delayMin: body.delayMin } : {}),
      ...(body.noteHe ? { noteHe: body.noteHe } : {}),
      clientTimestamp: body.clientTimestamp,
      createdAt: new Date().toISOString(),
    };
    // contracts v1.9: a scope-denied delay report is rejected BEFORE any write -
    // no report row, no applied audit row, no phantom report.new frame (the deny
    // previously fired mid-tx after the emit). The denied row itself is appended
    // standalone by the central error handler.
    let delayed: { change: ProposedChange; domino: DominoResult; decision: 'auto-apply' | 'pending_review' } | undefined;
    if (body.status === 'delayed' && body.delayMin !== undefined && task.start !== null) {
      const newStart = renderInstant(parseInstant(task.start) + body.delayMin * 60000, snapshot.event.timezone);
      const change: ProposedChange = { type: 'task.move', taskId: task.id, newStart };
      const domino = computeDomino(snapshot, change, getProfile(snapshot.event.domainProfileId));
      const decision = reportDecisionFor(user, task, domino);
      if (decision === 'deny') {
        fail(403, 'FORBIDDEN', 'לא ניתן לדווח על משימה שלא משובצת אליך', {
          reason: 'scope_violation', action: 'report.status.create', entityType: 'task', entityId: task.id, eventId: task.eventId,
        });
      }
      delayed = { change, domino, decision };
    }
    const outcome = await withAuditSafety(repo, async () => {
      await repo.createReport(report);
      await audit(repo, {
        orgId: user.orgId, eventId: task.eventId, actorUserId: user.userId, role: user.role,
        action: 'report.status.create', entityType: 'task', entityId: task.id, after: report, deviceClass: deviceClassOf(ua(req)),
      });
      appEvents.emit({ type: 'report.new', report, eventId: task.eventId, siteId: task.siteId });

      if (!delayed) {
        return { report };
      }
      const { change, domino, decision } = delayed;
      if (decision === 'auto-apply' && domino.ok) {
        applyDomino(repo, snapshot, domino, change, withOrg(user), 'task.move', deviceClassOf(ua(req)));
        return { report, applied: { domino } };
      }
      const cr: ChangeRequest = {
        id: newId('cr'), eventId: task.eventId, proposedBy: user.userId, role: user.role,
        baseGraphVersion: snapshot.event.version, change, dominoResult: domino,
        state: 'pending_review',
        reasonHe: `דיווח שטח: איחור של ${body.delayMin} דקות ב"${task.name}" (${domino.summaryHe})`,
        createdAt: new Date().toISOString(),
      };
      await repo.createChangeRequest(cr);
      await audit(repo, {
        orgId: user.orgId, eventId: task.eventId, actorUserId: user.userId, role: user.role,
        action: 'report.status.create', entityType: 'change_request', entityId: cr.id, after: cr, deviceClass: deviceClassOf(ua(req)),
      });
      return { report, changeRequest: cr };
    });
    // TL pinned semantic: a report-originated escalated CR mirrors proposeMutation —
    // admins see change.pending in realtime AND get the admin-only approval-needed job.
    if ('changeRequest' in outcome) {
      const cr = outcome.changeRequest as ChangeRequest;
      appEvents.emit({ type: 'change.pending', changeRequest: cr });
      await recordJobs(repo, [await buildApprovalNeededJob({ repo, event: snapshot.event, profile: getProfile(snapshot.event.domainProfileId), changeRequestId: cr.id, summaryHe: cr.dominoResult.summaryHe })]);
    }
    return outcome;
  });

  // ---------- report resolution (contracts v1.12) ----------
  // Pure handled-state on the report: NO graph effect, NO effect on CRs the
  // report spawned. Ack-style idempotent: a re-resolve 200s with the EXISTING
  // resolvedBy/resolvedAt - no overwrite, no second audit row, no second frame.
  app.post('/v1/reports/:id/resolve', async (req) => {
    const user = await me(req);
    const { id } = req.params as { id: ID };
    const base = rawDecision('report.resolve', user.role);
    if (base !== 'allow' && base !== 'scope') {
      fail(403, 'FORBIDDEN', 'אין לך הרשאה לפעולה זו', {
        reason: 'matrix_deny', action: 'report.resolve', entityType: 'report', entityId: id, eventId: 'pending',
      });
    }
    const report = await repo.getReport(id);
    if (!report) fail(404, 'NOT_FOUND', 'הדיווח לא נמצא');
    const task = await repo.getTask(report.taskId);
    if (!task) fail(404, 'NOT_FOUND', 'הדיווח לא נמצא');
    const snapshot = await repo.snapshot(task.eventId);
    if (!snapshot || snapshot.event.orgId !== user.orgId) fail(404, 'NOT_FOUND', 'הדיווח לא נמצא'); // cross-org 404
    if (base === 'scope' && !inScope(user.scopes, task.eventId, task.siteId)) {
      fail(403, 'FORBIDDEN', 'לא ניתן לטפל בדיווח מחוץ לתחום האחריות שלך', {
        reason: 'scope_violation', action: 'report.resolve', entityType: 'report', entityId: id, eventId: task.eventId,
      });
    }
    if (report.resolvedBy !== undefined) return { report }; // already handled: return existing state
    const { resolutionNoteHe } = (req.body ?? {}) as { resolutionNoteHe?: string };
    const resolvedAt = new Date().toISOString();
    const resolved = await withAuditSafety(repo, async () => {
      const r = await repo.resolveReport(id, user.userId, resolvedAt, resolutionNoteHe);
      if (r?.applied) {
        await audit(repo, {
          orgId: user.orgId, eventId: task.eventId, actorUserId: user.userId, role: user.role,
          action: 'report.resolve', entityType: 'report', entityId: id,
          after: { resolvedBy: user.userId, resolvedAt, ...(resolutionNoteHe ? { resolutionNoteHe } : {}) },
          deviceClass: deviceClassOf(ua(req)),
        });
        appEvents.emit({ type: 'report.resolved', report: r.report, eventId: task.eventId, siteId: task.siteId });
      }
      return r;
    });
    return { report: resolved?.report ?? report };
  });

  // ---------- users directory (contracts v1.12) ----------
  // Org-scoped, admin + field_manager only (hard role check - no matrix row,
  // notify.ack precedent; READ endpoint so no denied-audit row per v1.9).
  // Powers display names for proposedBy/resolvedBy. No credentials, no phones.
  app.get('/v1/users', async (req) => {
    const user = await me(req);
    if (user.role !== 'admin' && user.role !== 'field_manager') fail(403, 'FORBIDDEN', 'אין גישה לרשימת המשתמשים');
    const users = await repo.listUsers(user.orgId);
    return { users: users.map(u => ({ id: u.userId, displayName: u.name, role: u.role })) };
  });

  // ---------- audit & notification evidence (admin; ISO-4) ----------
  app.get('/v1/audit', async (req) => {
    const user = await me(req);
    const { eventId } = req.query as { eventId?: ID };
    if (user.role === 'focus_worker') fail(403, 'FORBIDDEN', 'אין גישה ליומן ביקורת');
    let entries = await repo.listAudit(user.orgId);
    if (eventId) entries = entries.filter(e => e.eventId === eventId);
    if (user.role === 'field_manager') {
      const kept: AuditLogEntry[] = [];
      for (const e of entries) {
        const task = await repo.getTask(e.entityId);
        if (task ? inScope(user.scopes, task.eventId, task.siteId) : e.actorUserId === user.userId) kept.push(e);
      }
      entries = kept;
    }
    return { audit: entries };
  });

  app.get('/v1/notifications', async (req) => {
    const user = await me(req);
    if (user.role !== 'admin') fail(403, 'FORBIDDEN', 'אין גישה לרשימות נמענים');
    const { eventId } = req.query as { eventId?: ID };
    if (!eventId) fail(400, 'BAD_REQUEST', 'חסר eventId');
    await loadEvent(req, eventId);
    return { jobs: await repo.listNotificationJobs(eventId) };
  });

  // PR-3 (contracts v1.6/v1.7): shared FYI handled-state. Admin only (matches
  // GET /v1/notifications scope; matrix untouched, denyByDefault covers it).
  // Idempotent: re-ack 200s with the existing ack, never overwrites.
  app.post('/v1/notify-jobs/:id/ack', async (req) => {
    const user = await me(req);
    const { id } = req.params as { id: ID };
    if (user.role !== 'admin') {
      // admin-only per pinned pattern (no matrix row; denyByDefault) -> matrix_deny
      fail(403, 'FORBIDDEN', 'אין גישה לרשימות נמענים', {
        reason: 'matrix_deny', action: 'notify.ack', entityType: 'notification', entityId: id, eventId: 'pending',
      });
    }
    const job = await repo.getNotificationJob(id);
    if (!job) fail(404, 'NOT_FOUND', 'ההתראה לא נמצאה');
    if (job.acknowledgedBy !== undefined) return { job }; // already handled: return existing ack
    const ackAt = new Date().toISOString();
    // contracts v1.8: ack is a mutation -> audit row in the SAME transaction
    // (every-mutation-is-audited, QA §9). Re-ack never reaches here, so it never
    // writes a second row. The job's ack fields stay the state record.
    const acked = await withAuditSafety(repo, async () => {
      const r = await repo.ackNotificationJob(id, user.userId, ackAt);
      if (r?.applied) {
        await audit(repo, {
          orgId: user.orgId, eventId: job.eventId, actorUserId: user.userId, role: user.role,
          action: 'notify.ack', entityType: 'notification', entityId: id,
          after: { acknowledgedBy: user.userId, acknowledgedAt: ackAt },
        });
      }
      return r;
    });
    if (!acked) fail(404, 'NOT_FOUND', 'ההתראה לא נמצאה');
    if (acked.applied) {
      appEvents.emit({ type: 'notify.acked', eventId: acked.job.eventId, orgId: user.orgId, jobId: id, acknowledgedBy: user.userId, acknowledgedAt: ackAt });
    }
    return { job: acked.job }; // lost a concurrent first-ack race -> carries the winner's ack
  });

  return app;
}

const withOrg = (user: UserRecord): UserRecord => user;
