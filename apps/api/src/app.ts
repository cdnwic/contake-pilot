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
import { ReportClientIdConflictError } from './repo/graph-repository.js';
import { ApiError, approveChange, proposeMutation, rejectChange, reportDecisionFor, applyDomino, actionOfChange , withAuditSafety } from './services/changes.js';
import { auditDenied, type DenialMeta, audit, deviceClassOf } from './services/audit.js';
import type { AuditEntityType, Branch, ContentItem, ContentItemVersion, ExternalParty, OptoutSuppression, StatusToken, TaskContentRole, TaskResourceLink } from '@contake/core';
import { bodyHashOf, maskAddress, mintStatusToken, normalizeAddress, peppersFromEnv, hashToken, rateOk, requestHashOf, timingSafeEqualStr, tokenTtlMs, containsSecretPattern } from './services/security.js';
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
    // v1.20.2: malformed/empty/non-JSON bodies on write routes fail as 400, never 500.
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      void reply.status(statusCode).send({ error: { code: 'BAD_REQUEST', messageHe: 'גוף הבקשה אינו JSON תקין' } });
      return;
    }
    void reply.status(500).send({ error: { code: 'INTERNAL', messageHe: 'שגיאת שרת' } });
  });

  // v1.20.2: non-JSON content-type on a write route -> 400 (empty JSON bodies are
  // rejected by the parser and mapped above; no-body POSTs stay route-decided).
  app.addHook('preHandler', async (req) => {
    if (!['POST', 'PATCH', 'PUT'].includes(req.method)) return;
    if (!req.url.startsWith('/v1/') || req.url.startsWith('/v1/auth/')) return;
    const ct = req.headers['content-type'];
    if (ct !== undefined && !(typeof ct === 'string' && ct.includes('application/json'))) {
      fail(400, 'BAD_REQUEST', 'נדרש גוף JSON');
    }
  });

  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/v1/auth/') || req.url === '/v1/health') return;
    // v1.20: token-gated guest surface (§22 G6) and provider-webhook intake (§25)
    // authenticate by their own secrets, not by user session.
    if (req.url.startsWith('/v1/public/status/') || req.url === '/v1/webhooks/inbound') return;
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
    // Register exactly-one-winner (QA 2026-09-17, T2 defect fix): the create
    // path uses the invite-only atomic primitive (plain INSERT, never an
    // overwrite). Explicit outcomes:
    //   created   - this invite won the row; whitelist.invite audit in the same tx.
    //   reinvited - SAME-ORG existing row: §15 reset to invited, decision fields
    //               cleared, createdAt preserved. Deterministic and idempotent
    //               under repetition (same final state on every repeat).
    //   conflict  - 409: the phone's row belongs to a DIFFERENT org (pre-existing
    //               or a concurrent create won it). NO overwrite, the row is
    //               never touched, and a conflict audit row is written in the
    //               ATTEMPTING org only; the response reveals nothing about the
    //               other org. Same-org concurrent loser: the winner's row
    //               already carries exactly this request's effect - idempotent
    //               success, no further write.
    type InviteResult = { outcome: 'conflict' } | { outcome: 'created' | 'reinvited'; entry: WhitelistEntry };
    const result: InviteResult = await repo.withWhitelistMutation(phone, async (before): Promise<InviteResult> => {
      const now = new Date().toISOString();
      const conflictAudit = () => audit(repo, {
        orgId: user.orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
        action: 'whitelist.invite', entityType: 'whitelist_entry', entityId: phone,
        after: { outcome: 'conflict', reason: 'phone_registered_other_org' }, deviceClass: deviceClassOf(ua(req)),
      });
      if (before && before.orgId !== user.orgId) {
        await conflictAudit();
        return { outcome: 'conflict' };
      }
      const entry: WhitelistEntry = { phone, status: 'invited', orgId: user.orgId, createdAt: before?.createdAt ?? now };
      if (before) {
        await withAuditSafety(repo, async () => {
          await repo.upsertWhitelistEntry(entry);
          await audit(repo, {
            orgId: user.orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
            action: 'whitelist.invite', entityType: 'whitelist_entry', entityId: phone,
            before, after: entry, deviceClass: deviceClassOf(ua(req)),
          });
        });
        return { outcome: 'reinvited', entry };
      }
      const createRes = await withAuditSafety(repo, async () => {
        const res = await repo.createWhitelistInvite(entry);
        if (res.outcome !== 'created') return res;
        await audit(repo, {
          orgId: user.orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
          action: 'whitelist.invite', entityType: 'whitelist_entry', entityId: phone,
          after: entry, deviceClass: deviceClassOf(ua(req)),
        });
        return res;
      });
      if (createRes.outcome === 'created') return { outcome: 'created', entry };
      if (createRes.entry.orgId !== user.orgId) {
        await conflictAudit();
        return { outcome: 'conflict' };
      }
      return { outcome: 'reinvited', entry: createRes.entry };
    });
    if (result.outcome === 'conflict') fail(409, 'WHITELIST_CONFLICT', 'המספר כבר רשום במערכת');
    // Emit AFTER the transition unit resolves - post-commit on PG, so a
    // rolled-back transaction can never publish phantom state (hardening note).
    appEvents.emit({ type: 'whitelist.updated', orgId: user.orgId, entry: result.entry });
    return result.entry;
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
    const decided = await repo.withWhitelistMutation(phone, async (before) => {
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
      return { entry, user: account };
    });
    // Post-commit emit (hardening note): no rolled-back state can be published.
    appEvents.emit({ type: 'whitelist.updated', orgId: user.orgId, entry: decided.entry });
    return decided;
  });

  app.post('/v1/whitelist/:phone/reject', async (req) => {
    const user = await me(req);
    const { phone } = req.params as { phone: string };
    const { reasonHe } = (req.body ?? {}) as { reasonHe?: string };
    wlDeny(user, 'whitelist.reject', phone);
    // Round 8: reject is one repository transition (same unit as approve).
    const rejected = await repo.withWhitelistMutation(phone, async (before) => {
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
      return entry;
    });
    // Post-commit emit (hardening note): no rolled-back state can be published.
    appEvents.emit({ type: 'whitelist.updated', orgId: user.orgId, entry: rejected });
    return rejected;
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
    const body = (req.body ?? {}) as {
      taskId?: ID; status?: StatusReport['status']; delayMin?: number; noteHe?: string;
      clientReportId?: string; clientTimestamp?: string;
    };
    // v1.20.2 (QA QM4 2026-09-17): runtime request validation runs BEFORE any
    // authorization, dedupe or write effect. Invalid input is a 400 with zero
    // report/audit/job/frame/CR. Bounds are explicit and disclosed:
    // clientReportId nonblank <= 200 (ULID is 26), noteHe <= 2000,
    // delayMin a finite integer 1..10080 (one week).
    const REPORT_CLIENT_ID_MAX = 200;
    const REPORT_NOTE_MAX = 2000;
    const DELAY_MIN_MAX = 10080;
    const REPORT_STATUSES = new Set(['on_track', 'delayed', 'done', 'blocked']);
    if (!body.taskId || !body.status || !body.clientReportId || !body.clientTimestamp) {
      fail(400, 'BAD_REQUEST', 'חסרים taskId / status / clientReportId / clientTimestamp');
    }
    if (!REPORT_STATUSES.has(body.status)) {
      fail(400, 'BAD_REQUEST', 'סטטוס לא חוקי');
    }
    if (typeof body.clientReportId !== 'string' || body.clientReportId.trim() === '' || body.clientReportId.length > REPORT_CLIENT_ID_MAX) {
      fail(400, 'BAD_REQUEST', 'מזהה דיווח לא חוקי');
    }
    if (typeof body.clientTimestamp !== 'string' || !Number.isFinite(Date.parse(body.clientTimestamp))) {
      fail(400, 'BAD_REQUEST', 'חותמת זמן לא חוקית');
    }
    if (body.noteHe !== undefined && (typeof body.noteHe !== 'string' || body.noteHe.length > REPORT_NOTE_MAX)) {
      fail(400, 'BAD_REQUEST', 'הערה ארוכה מדי');
    }
    if (body.status === 'delayed') {
      if (typeof body.delayMin !== 'number' || !Number.isInteger(body.delayMin) || body.delayMin < 1 || body.delayMin > DELAY_MIN_MAX) {
        fail(400, 'BAD_REQUEST', 'דיווח איחור מחייב delayMin שלם וחיובי (עד 10080)');
      }
    } else if (body.delayMin !== undefined) {
      fail(400, 'BAD_REQUEST', 'delayMin תקף רק לדיווח איחור');
    }
    if (rawDecision('report.status.create', user.role) === 'deny') {
      fail(403, 'FORBIDDEN', 'אין לך הרשאה לפעולה זו', {
        reason: 'matrix_deny', action: 'report.status.create', entityType: 'task', entityId: 'pending', eventId: 'pending',
      });
    }
    // v1.20.2 (QA QM3 2026-09-17): task resolution, same-org binding and
    // per-role scope authorization run BEFORE any idempotent replay, so a
    // clientReportId can never become a cross-tenant read oracle.
    const task = await repo.getTask(body.taskId);
    if (!task) fail(404, 'NOT_FOUND', 'המשימה לא נמצאה');
    const snapshot = await repo.snapshot(task.eventId);
    if (!snapshot || snapshot.event.orgId !== user.orgId) fail(404, 'NOT_FOUND', 'המשימה לא נמצאה');
    // All statuses: FM is limited to in-scope sites (matching the list route),
    // FW to their own assignment; admin passes on same-org binding above.
    if (user.role === 'field_manager' && !taskInScope(user, task.eventId, task.siteId)) {
      fail(403, 'FORBIDDEN', 'לא ניתן לדווח על משימה מחוץ לתחום', {
        reason: 'scope_violation', action: 'report.status.create', entityType: 'task', entityId: task.id, eventId: task.eventId,
      });
    }
    if (user.role === 'focus_worker' && (!user.linkedResourceId || !task.assigneeResourceIds.includes(user.linkedResourceId))) {
      fail(403, 'FORBIDDEN', 'לא ניתן לדווח על משימה שלא משובצת אליך', {
        reason: 'scope_violation', action: 'report.status.create', entityType: 'task', entityId: task.id, eventId: task.eventId,
      });
    }
    // Tenant/actor-safe idempotency: an exact same-actor replay returns the
    // existing report with no effects; any other collision (changed
    // task/payload, different actor, different org) is a 409 with a conflict
    // audit in the ATTEMPTING org and no leak of the stored row.
    const conflictAudit = () => audit(repo, {
      orgId: user.orgId, eventId: task.eventId, actorUserId: user.userId, role: user.role,
      action: 'report.status.create', entityType: 'task', entityId: task.id,
      after: { outcome: 'conflict', reason: 'client_report_id_taken' }, deviceClass: deviceClassOf(ua(req)),
    });
    const replayOrConflict = async (existing: StatusReport): Promise<{ report: StatusReport; deduped: true }> => {
      const samePayload = existing.taskId === task.id && existing.status === body.status
        && (existing.delayMin ?? undefined) === (body.delayMin ?? undefined)
        && (existing.noteHe ?? undefined) === (body.noteHe ?? undefined)
        && existing.clientTimestamp === body.clientTimestamp;
      if (existing.reportedBy === user.userId && samePayload) return { report: existing, deduped: true };
      await conflictAudit();
      return fail(409, 'REPORT_CONFLICT', 'כבר קיים דיווח עם מזהה זה');
    };
    const existing = await repo.getReportByClientId(body.clientReportId);
    if (existing) return replayOrConflict(existing);

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
    let outcome: { report: StatusReport; applied?: { domino: DominoResult }; changeRequest?: ChangeRequest };
    try {
    outcome = await withAuditSafety(repo, async () => {
      await repo.createReport(report);
      await audit(repo, {
        orgId: user.orgId, eventId: task.eventId, actorUserId: user.userId, role: user.role,
        action: 'report.status.create', entityType: 'task', entityId: task.id, after: report, deviceClass: deviceClassOf(ua(req)),
      });

      // v1.20.2 §26.1ב: a blocked field report raises its manager-surface job
      // ATOMICALLY with the report + audit (same tx). Recipients are verified:
      // active admins of the report's own org only.
      if (report.status === 'blocked') {
        const admins = (await repo.listUsers(user.orgId)).filter(u => u.role === 'admin' && u.active);
        await repo.createNotificationJob({
          id: newId('nj'), eventId: task.eventId, createdAt: new Date().toISOString(),
          kind: 'report_blocked',
          targets: admins.map(a => ({ channel: 'in_app' as const, address: a.userId, recipientLabel: a.name })),
          templateKey: 'report_blocked', params: { reportId: report.id, taskId: task.id },
          idempotencyKey: `report_blocked:${report.id}`, batchWindowSec: 60,
        });
      }

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
    } catch (e) {
      // Durable-uniqueness race: another request won this clientReportId
      // mid-transaction; our tx rolled back fully - resolve against the winner.
      if (e instanceof ReportClientIdConflictError) {
        const winner = await repo.getReportByClientId(body.clientReportId!);
        if (winner) return replayOrConflict(winner);
      }
      throw e;
    }
    // QA QM4: frames publish ONLY after the write unit commits - a rolled-back
    // transaction can never leak a ghost report.new (same post-commit rule as
    // change.pending below).
    appEvents.emit({ type: 'report.new', report, eventId: task.eventId, siteId: task.siteId });
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

  // v1.21.2 §26.1א: report.correct - the ONLY path that changes actualFinishAt.
  // CAS on expectedReportVersion; idempotent on clientMutationId; reason scanned
  // for secret patterns (v1.21.4 #8); allowBeforeStart honored for admin or for
  // an FM covered by an approved CR for the same correction (v1.21.4 #9).
  app.post('/v1/reports/:id/correct', async (req, reply) => {
    const user = await me(req);
    const { id } = req.params as { id: ID };
    const base = rawDecision('report.correct', user.role);
    if (base !== 'allow' && base !== 'propose') {
      fail(403, 'FORBIDDEN', 'אין לך הרשאה לפעולה זו', {
        reason: 'matrix_deny', action: 'report.correct', entityType: 'report', entityId: id, eventId: 'pending',
      });
    }
    const report = await repo.getReport(id);
    if (!report) fail(404, 'NOT_FOUND', 'הדיווח לא נמצא');
    const task = await repo.getTask(report.taskId);
    if (!task) fail(404, 'NOT_FOUND', 'הדיווח לא נמצא');
    const ev = await repo.getEvent(task.eventId);
    if (!ev || ev.orgId !== user.orgId) fail(404, 'NOT_FOUND', 'הדיווח לא נמצא'); // cross-org 404
    const body = (req.body ?? {}) as { actualFinishAt?: string; expectedReportVersion?: number; reason?: string; clientMutationId?: string; allowBeforeStart?: boolean };
    if (!body.actualFinishAt || typeof body.expectedReportVersion !== 'number' || !body.reason || body.reason.trim() === '') {
      fail(400, 'BAD_REQUEST', 'חסרים actualFinishAt / expectedReportVersion / reason');
    }
    if (!/(Z|[+-]\d{2}:\d{2})$/.test(body.actualFinishAt) || Number.isNaN(Date.parse(body.actualFinishAt))) {
      fail(400, 'BAD_REQUEST', 'actualFinishAt חייב להיות ISO עם offset');
    }
    if (containsSecretPattern(body.reason)) {
      fail(400, 'BAD_REQUEST', 'הסירו מהסיבה מידע שנראה כמו סוד (טוקן/סיסמה)');
    }
    const key = requireMutationKey(body.clientMutationId);
    // NOTE: the CAS precondition lives INSIDE the idemExec handler - a replay of
    // the same clientMutationId must return the stored result even after the
    // report version moved on (§26.1א idempotency).
    // before-start correction needs the override, honored per v1.21.4 #9
    if (task.start && Date.parse(body.actualFinishAt) < Date.parse(task.start)) {
      let honored = false;
      if (body.allowBeforeStart === true) {
        if (user.role === 'admin') honored = true;
        else {
          const covering = (await repo.listChangeRequests({ eventId: task.eventId, state: 'approved' })).find(cr =>
            cr.change.type === 'report.correct' && cr.change.reportId === id && cr.change.actualFinishAt === body.actualFinishAt);
          honored = covering !== undefined;
        }
        if (!honored) {
          await audit(repo, { orgId: user.orgId, eventId: task.eventId, actorUserId: user.userId, role: user.role,
            action: 'report.correct', entityType: 'report', entityId: id,
            after: { deniedBeforeStartOverride: true }, deviceClass: deviceClassOf(ua(req)) });
          fail(403, 'FORBIDDEN', 'תיקון לפני תחילת המשימה דורש אישור מנהל');
        }
      } else {
        fail(400, 'BAD_REQUEST', 'actualFinishAt לפני תחילת המשימה דורש allowBeforeStart');
      }
    }
    const change: ProposedChange = {
      type: 'report.correct', reportId: id, actualFinishAt: body.actualFinishAt,
      expectedReportVersion: body.expectedReportVersion, reason: body.reason,
      ...(body.allowBeforeStart === true ? { allowBeforeStart: true } : {}),
    };
    return idemExec('report.correct', user, key, body, reply, async (record) => {
      const fresh = await repo.getReport(id);
      if (!fresh) fail(404, 'NOT_FOUND', 'הדיווח לא נמצא');
      if ((fresh.version ?? 1) !== body.expectedReportVersion) {
        fail(409, 'VERSION_CONFLICT', 'גרסה לא עדכנית - נדרש רענון');
      }
      const outcome = await proposeMutation(repo, { userId: user.userId, role: user.role, scopes: user.scopes, orgId: user.orgId, name: user.name }, 'report.correct', change, task.eventId, ua(req));
      let out: object;
      if ('changeRequest' in outcome && outcome.changeRequest) {
        out = { changeRequest: outcome.changeRequest };
      } else if ('blockedPreview' in outcome && outcome.blockedPreview) {
        out = { blocked: true };
      } else {
        out = { report: await repo.getReport(id) };
      }
      await record(out);
      return out;
    });
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

  // ============================================================
  // v1.20 — Builder content surface / stakeholders / branches (additive-only)
  // ============================================================
  const gate120 = (user: UserRecord, action: Action, entityType: AuditEntityType, entityId: ID): void => {
    const d = rawDecision(action, user.role);
    if (d === 'allow' || d === 'scope') return;
    fail(403, 'FORBIDDEN', 'אין לך הרשאה לפעולה זו', {
      reason: 'matrix_deny', action, entityType, entityId, eventId: 'pending',
    });
  };
  const sameOrg = (user: UserRecord, orgId: ID, action: Action): void => {
    if (orgId !== user.orgId) fail(403, 'FORBIDDEN', 'אין לך הרשאה לפעולה זו', {
      reason: 'scope_violation', action, entityType: 'user', entityId: user.userId, eventId: 'pending',
    });
  };

  // ---- v1.20.2 §21.1א FM/FW site-scope helpers ----
  // 'scope' cells are conditional allows: event/site must intersect the
  // principal's assigned scopes. admin is never affected. A manager with no
  // assigned scopes fails every scope check (deny) and sees empty lists.
  const eventInScope = (user: UserRecord, e: EventNode): boolean =>
    user.role === 'admin' || user.scopes.some(sc => sc.eventId === e.id && (sc.siteId === undefined || e.siteIds.includes(sc.siteId)));
  const taskInScope = (user: UserRecord, eventId: ID, siteId: ID): boolean =>
    user.role === 'admin' || inScope(user.scopes, eventId, siteId);
  /** content item visibility: admin always; FM/FW only when linked to an
   *  in-scope task/event (org-level unlinked entities are admin-only, v2.1 #1). */
  const contentVisible = async (user: UserRecord, item: ContentItem): Promise<boolean> => {
    if (user.role === 'admin') return true;
    for (const e of await repo.listEvents(user.orgId)) {
      if (!eventInScope(user, e)) continue;
      for (const t of await repo.listTasks(e.id)) {
        if (!taskInScope(user, e.id, t.siteId)) continue;
        if ((await repo.listTaskContent(t.id)).some(l => l.contentId === item.id)) return true;
      }
    }
    return false;
  };
  const scopeDeny = (user: UserRecord, action: Action, entityType: AuditEntityType, entityId: ID): never =>
    fail(403, 'FORBIDDEN', 'אין לך הרשאה לפעולה זו', {
      reason: 'scope_violation', action, entityType, entityId, eventId: 'pending',
    });

  // ---- v1.20.2 §26.3א per-route idempotency executor ----
  // dedupe key (orgId, actorId, route, clientMutationId) + requestHash; replay
  // returns the stored response verbatim with Idempotency-Replayed:true; the
  // record is written by `record` INSIDE the business transaction.
  const requireMutationKey = (key: string | undefined): string => {
    if (!key) fail(400, 'BAD_REQUEST', 'חסר clientMutationId');
    return key;
  };
  const idemExec = async <T>(
    route: string, user: UserRecord, key: string, body: unknown, reply: FastifyReply,
    fn: (record: (responseBody: T, status?: number) => Promise<void>) => Promise<T>,
  ): Promise<T> => {
    const requestHash = requestHashOf(body);
    const existing = await repo.getIdempotencyRecord(user.orgId, user.userId, route, key);
    if (existing) {
      if (existing.requestHash !== requestHash) fail(409, 'IDEMPOTENCY_CONFLICT', 'מפתח קיים עם גוף בקשה שונה');
      reply.header('Idempotency-Replayed', 'true');
      void reply.code(existing.statusCode);
      return JSON.parse(existing.responseBody) as T;
    }
    const record = async (responseBody: T, status = 200): Promise<void> => {
      await repo.putIdempotencyRecord({
        orgId: user.orgId, actorId: user.userId, route, clientMutationId: key,
        requestHash, statusCode: status, responseBody: JSON.stringify(responseBody),
        createdAt: new Date().toISOString(),
      });
    };
    return fn(record);
  };

  // ---- §20 content items (v1.20.2: immutable versions + CAS + tombstones) ----
  const versionSnapshot = (item: ContentItem, version: number, by: ID): ContentItemVersion => ({
    contentVersionId: newId('cv'), contentId: item.id, version,
    title: item.title,
    ...(item.body !== undefined ? { body: item.body } : {}),
    ...(item.url !== undefined ? { url: item.url } : {}),
    ...(item.checklistItems !== undefined ? { checklistItems: item.checklistItems } : {}),
    ...(item.meta !== undefined ? { meta: item.meta } : {}),
    createdBy: by, createdAt: new Date().toISOString(),
  });

  app.post('/v1/orgs/:orgId/content', async (req, reply) => {
    const user = await me(req);
    const { orgId } = req.params as { orgId: ID };
    gate120(user, 'content.create', 'content_item', 'pending');
    sameOrg(user, orgId, 'content.create');
    // v2.1 #1: an org-level entity write is admin-only; FM scope cannot cover an
    // as-yet-unlinked org-level item.
    if (user.role !== 'admin') scopeDeny(user, 'content.create', 'content_item', 'pending');
    const body = (req.body ?? {}) as Partial<ContentItem> & { clientMutationId?: string };
    if (!body.kind || !body.title) fail(400, 'BAD_REQUEST', 'חסרים kind / title');
    if (!['text', 'link', 'checklist', 'equipment', 'form'].includes(body.kind)) fail(400, 'BAD_REQUEST', 'סוג תוכן לא תקין');
    const key = requireMutationKey(body.clientMutationId);
    return idemExec('content.create', user, key, body, reply, async (record) => {
      const item: ContentItem = {
        id: newId('ci'), orgId, kind: body.kind!, title: body.title!,
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.url !== undefined ? { url: body.url } : {}),
        ...(body.checklistItems !== undefined ? { checklistItems: body.checklistItems } : {}),
        meta: { ...(body.meta ?? {}), clientMutationId: key },
        createdBy: user.userId, createdAt: new Date().toISOString(), version: 1,
      };
      const out = { item };
      await withAuditSafety(repo, async () => {
        await repo.createContentItem(item);
        await repo.createContentVersion(versionSnapshot(item, 1, user.userId));
        await audit(repo, { orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
          action: 'content.create', entityType: 'content_item', entityId: item.id, after: item, deviceClass: deviceClassOf(ua(req)) });
        await record(out);
      });
      return out;
    });
  });

  app.get('/v1/orgs/:orgId/content', async (req) => {
    const user = await me(req);
    const { orgId } = req.params as { orgId: ID };
    gate120(user, 'content.read', 'content_item', 'list');
    sameOrg(user, orgId, 'content.read');
    const { includeDeleted, cursor, limit: limitRaw } = (req.query ?? {}) as { includeDeleted?: string; cursor?: string; limit?: string };
    const includeTombstoned = includeDeleted === 'true' && user.role === 'admin'; // v2.1 #2: admin-only
    const limit = Math.min(Math.max(Number(limitRaw ?? 50) || 50, 1), 200);
    let items = await repo.listContentItems(orgId);
    if (!includeTombstoned) items = items.filter(c => !c.deletedAt);
    const visible: ContentItem[] = [];
    for (const c of items) if (await contentVisible(user, c)) visible.push(c);
    visible.sort((a, b) => a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt));
    let startIdx = 0;
    if (cursor) {
      const [cat, cid] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
      startIdx = visible.findIndex(c => c.createdAt > cat! || (c.createdAt === cat && c.id > cid!));
      if (startIdx === -1) startIdx = visible.length;
    }
    const page = visible.slice(startIdx, startIdx + limit);
    const last = page[page.length - 1];
    const nextCursor = startIdx + limit < visible.length && last
      ? Buffer.from(`${last.createdAt}|${last.id}`, 'utf8').toString('base64url') : undefined;
    return { items: page, ...(nextCursor ? { nextCursor } : {}) };
  });

  // v2.1 #2: head read; tombstoned -> 410 {deletedAt, deletedBy} for admin, 404 others.
  app.get('/v1/content/:id', async (req, reply) => {
    const user = await me(req);
    const { id } = req.params as { id: ID };
    gate120(user, 'content.read', 'content_item', id);
    const item = await repo.getContentItem(id);
    if (!item || item.orgId !== user.orgId) fail(404, 'NOT_FOUND', 'פריט התוכן לא נמצא');
    if (item.deletedAt) {
      if (user.role !== 'admin') fail(404, 'NOT_FOUND', 'פריט התוכן לא נמצא');
      return reply.status(410).send({ error: { code: 'GONE', messageHe: 'פריט התוכן נמחק', deletedAt: item.deletedAt, deletedBy: item.deletedBy } });
    }
    if (!(await contentVisible(user, item))) fail(404, 'NOT_FOUND', 'פריט התוכן לא נמצא');
    return { item };
  });

  app.get('/v1/content/:id/versions', async (req) => {
    const user = await me(req);
    const { id } = req.params as { id: ID };
    gate120(user, 'content.read', 'content_item', id);
    const item = await repo.getContentItem(id);
    if (!item || item.orgId !== user.orgId) fail(404, 'NOT_FOUND', 'פריט התוכן לא נמצא');
    if (!(await contentVisible(user, item)) && !(item.deletedAt && user.role === 'admin')) fail(404, 'NOT_FOUND', 'פריט התוכן לא נמצא');
    return { versions: await repo.listContentVersions(id) }; // immutable, never deleted (preservation)
  });

  app.get('/v1/content/:id/versions/:versionId', async (req) => {
    const user = await me(req);
    const { id, versionId } = req.params as { id: ID; versionId: ID };
    gate120(user, 'content.read', 'content_item', id);
    const item = await repo.getContentItem(id);
    if (!item || item.orgId !== user.orgId) fail(404, 'NOT_FOUND', 'פריט התוכן לא נמצא');
    if (!(await contentVisible(user, item)) && !(item.deletedAt && user.role === 'admin')) fail(404, 'NOT_FOUND', 'פריט התוכן לא נמצא');
    const v = await repo.getContentVersion(id, versionId);
    if (!v) fail(404, 'NOT_FOUND', 'הגרסה לא נמצאה');
    return { version: v };
  });

  // v1.20.2 §20.1א: update = new immutable version; head advances by CAS on
  // (contentId, expectedVersion); conflict -> 409 VERSION_CONFLICT. Version row
  // + head + audit + dedupe record land in ONE transaction.
  app.patch('/v1/content/:id', async (req, reply) => {
    const user = await me(req);
    const { id } = req.params as { id: ID };
    gate120(user, 'content.update', 'content_item', id);
    const before = await repo.getContentItem(id);
    if (!before || before.orgId !== user.orgId) fail(404, 'NOT_FOUND', 'פריט התוכן לא נמצא');
    if (before.deletedAt) fail(410, 'GONE', 'פריט התוכן נמחק');
    if (!(await contentVisible(user, before))) scopeDeny(user, 'content.update', 'content_item', id);
    const patch = (req.body ?? {}) as Partial<ContentItem> & { clientMutationId?: string; expectedVersion?: number };
    const key = requireMutationKey(patch.clientMutationId);
    if (patch.expectedVersion === undefined) fail(400, 'BAD_REQUEST', 'חסר expectedVersion');
    return idemExec('content.update', user, key, patch, reply, async (record) => {
      const clean = { ...patch } as Record<string, unknown>;
      for (const f of ['id', 'orgId', 'version', 'clientMutationId', 'expectedVersion', 'createdAt', 'createdBy', 'deletedAt', 'deletedBy']) delete clean[f];
      const out = await withAuditSafety(repo, async () => {
        const n = await repo.casUpdateContentItem(id, patch.expectedVersion!, clean as Partial<ContentItem>);
        if (n === 'conflict') fail(409, 'VERSION_CONFLICT', 'גרסה לא עדכנית - נדרש רענון');
        if (!n) fail(404, 'NOT_FOUND', 'פריט התוכן לא נמצא');
        await repo.createContentVersion(versionSnapshot(n, n.version, user.userId));
        await audit(repo, { orgId: user.orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
          action: 'content.update', entityType: 'content_item', entityId: id, before, after: n, deviceClass: deviceClassOf(ua(req)) });
        const o = { item: n };
        await record(o);
        return o;
      });
      return out;
    });
  });

  // v1.20.2: delete = tombstone only (admin). Links + versions stay retrievable.
  app.delete('/v1/content/:id', async (req, reply) => {
    const user = await me(req);
    const { id } = req.params as { id: ID };
    if (user.role !== 'admin') {
      fail(403, 'FORBIDDEN', 'אין לך הרשאה לפעולה זו', {
        reason: 'matrix_deny', action: 'content.delete', entityType: 'content_item', entityId: id, eventId: 'pending',
      });
    }
    const before = await repo.getContentItem(id);
    if (!before || before.orgId !== user.orgId) fail(404, 'NOT_FOUND', 'פריט התוכן לא נמצא');
    const q = (req.query ?? {}) as { clientMutationId?: string };
    const b = (req.body ?? {}) as { clientMutationId?: string };
    const key = requireMutationKey(b.clientMutationId ?? q.clientMutationId);
    return idemExec('content.delete', user, key, { id, clientMutationId: key }, reply, async (record) => {
      const tombstoned = { deletedAt: new Date().toISOString(), deletedBy: user.userId };
      const out = { deleted: true, ...tombstoned };
      await withAuditSafety(repo, async () => {
        await repo.updateContentItem(id, tombstoned);
        await audit(repo, { orgId: user.orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
          action: 'content.delete', entityType: 'content_item', entityId: id, before, after: tombstoned, deviceClass: deviceClassOf(ua(req)) });
        await record(out);
      });
      return out;
    });
  });

  app.post('/v1/tasks/:id/content', async (req, reply) => {
    const user = await me(req);
    const { id } = req.params as { id: ID };
    gate120(user, 'content.attach', 'content_item', id);
    const task = await repo.getTask(id);
    if (!task) fail(404, 'NOT_FOUND', 'המשימה לא נמצאה');
    const ev = await repo.getEvent(task.eventId);
    if (!ev || ev.orgId !== user.orgId) fail(404, 'NOT_FOUND', 'המשימה לא נמצאה');
    if (!taskInScope(user, ev.id, task.siteId)) scopeDeny(user, 'content.attach', 'content_item', id);
    const body = (req.body ?? {}) as { contentId?: ID; role?: TaskResourceLink['role']; visibleFromOffsetMin?: number; visibleUntil?: string; ackRequired?: boolean; clientMutationId?: string };
    if (!body.contentId || !body.role) fail(400, 'BAD_REQUEST', 'חסרים contentId / role');
    if (!['instructions', 'script', 'checklist', 'equipment', 'form'].includes(body.role)) fail(400, 'BAD_REQUEST', 'תפקיד תוכן לא תקין');
    const key = requireMutationKey(body.clientMutationId);
    const item = await repo.getContentItem(body.contentId);
    if (!item || item.orgId !== user.orgId || item.deletedAt) fail(404, 'NOT_FOUND', 'פריט התוכן לא נמצא');
    return idemExec('content.attach', user, key, body, reply, async (record) => {
      const link: TaskResourceLink = {
        taskId: id, contentId: body.contentId as ID, role: body.role as TaskContentRole,
        visibleFromOffsetMin: body.visibleFromOffsetMin ?? 0,
        ...(body.visibleUntil ? { visibleUntil: body.visibleUntil } : {}),
        ...(body.ackRequired !== undefined ? { ackRequired: body.ackRequired } : {}),
      };
      const existed = (await repo.listTaskContent(id)).some(l => l.contentId === body.contentId);
      const out = { link, deduped: existed };
      await withAuditSafety(repo, async () => {
        await repo.attachTaskContent(link);
        await audit(repo, { orgId: user.orgId, eventId: task.eventId, actorUserId: user.userId, role: user.role,
          action: 'content.attach', entityType: 'content_item', entityId: body.contentId as ID, after: link, deviceClass: deviceClassOf(ua(req)) });
        await record(out);
      });
      return out;
    });
  });

  app.delete('/v1/tasks/:id/content/:contentId', async (req) => {
    const user = await me(req);
    const { id, contentId } = req.params as { id: ID; contentId: ID };
    gate120(user, 'content.attach', 'content_item', contentId);
    const task = await repo.getTask(id);
    if (!task) fail(404, 'NOT_FOUND', 'המשימה לא נמצאה');
    const ev = await repo.getEvent(task.eventId);
    if (!ev || ev.orgId !== user.orgId) fail(404, 'NOT_FOUND', 'המשימה לא נמצאה');
    if (!taskInScope(user, ev.id, task.siteId)) scopeDeny(user, 'content.attach', 'content_item', contentId);
    const before = (await repo.listTaskContent(id)).find(l => l.contentId === contentId);
    const removed = await repo.detachTaskContent(id, contentId);
    if (!removed) fail(404, 'NOT_FOUND', 'הקישור לא נמצא');
    await audit(repo, { orgId: user.orgId, eventId: task.eventId, actorUserId: user.userId, role: user.role,
      action: 'content.attach', entityType: 'content_item', entityId: contentId, before, deviceClass: deviceClassOf(ua(req)) });
    return { removed: true };
  });

  // §20 focus surface: current/next task + in-window visible content. A simple
  // task always returns visibleResources: [] (progressive disclosure in contract).
  app.get('/v1/focus/now', async (req) => {
    const user = await me(req);
    const orgEvents = await repo.listEvents(user.orgId);
    const scoped = orgEvents.filter(e => eventInScope(user, e));
    const now = Date.now();
    let currentTask: TaskNode | undefined;
    let nextTask: TaskNode | undefined;
    for (const e of scoped) {
      for (const t of await repo.listTasks(e.id)) {
        if (!t.start || t.status === 'cancelled' || t.status === 'done') continue;
        const st = Date.parse(t.start);
        const en = st + t.durationMin * 60000;
        if (now >= st && now < en && (!currentTask || st < Date.parse(currentTask.start!))) currentTask = t;
        else if (st > now && (!nextTask || st < Date.parse(nextTask.start!))) nextTask = t;
      }
    }
    const visibleResources: { link: TaskResourceLink; item: ContentItem }[] = [];
    if (currentTask) {
      for (const link of await repo.listTaskContent(currentTask.id)) {
        const st = Date.parse(currentTask.start!);
        const from = st - link.visibleFromOffsetMin * 60000;
        const until = link.visibleUntil ? Date.parse(link.visibleUntil) : Number.POSITIVE_INFINITY;
        if (now < from || now > until) continue;
        const item = await repo.getContentItem(link.contentId);
        if (item && !item.deletedAt) visibleResources.push({ link, item });
      }
    }
    return {
      currentTask: currentTask ?? null,
      nextTask: nextTask ?? null,
      visibleResources,
      window: currentTask ? { from: currentTask.start, until: new Date(Date.parse(currentTask.start!) + currentTask.durationMin * 60000).toISOString() } : null,
    };
  });

  app.post('/v1/content/:id/ack', async (req, reply) => {
    const user = await me(req);
    const { id } = req.params as { id: ID };
    gate120(user, 'content.ack', 'content_item', id);
    const body = (req.body ?? {}) as { clientAckId?: string; taskId?: ID };
    if (!body.clientAckId || !body.taskId) fail(400, 'BAD_REQUEST', 'חסרים clientAckId / taskId');
    const item = await repo.getContentItem(id);
    if (!item || item.orgId !== user.orgId || item.deletedAt) fail(404, 'NOT_FOUND', 'פריט התוכן לא נמצא');
    const task = await repo.getTask(body.taskId);
    if (!task || task.eventId === undefined) fail(404, 'NOT_FOUND', 'המשימה לא נמצאה');
    if (!taskInScope(user, task.eventId, task.siteId)) scopeDeny(user, 'content.ack', 'content_item', id);
    return idemExec('content.ack', user, body.clientAckId, body, reply, async (record) => {
      // v1.20.2: ack dedupe isolated per org+actor (was global on clientAckId).
      const existing = await repo.getContentAck(user.orgId, user.userId, body.clientAckId!);
      if (existing) {
        const out = { ack: existing, deduped: true };
        await record(out);
        return out;
      }
      const ack = { clientAckId: body.clientAckId!, contentId: id, taskId: body.taskId!, userId: user.userId, at: new Date().toISOString() };
      const out = { ack };
      await withAuditSafety(repo, async () => {
        await repo.createContentAck({ ...ack, orgId: user.orgId });
        await audit(repo, { orgId: user.orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
          action: 'content.ack', entityType: 'content_item', entityId: id, after: ack, deviceClass: deviceClassOf(ua(req)) });
        await record(out);
      });
      return out;
    });
  });


  // ---- §21 org matrix (read-only, grouped by branchId) ----
  app.get('/v1/orgs/:orgId/matrix', async (req) => {
    const user = await me(req);
    const { orgId } = req.params as { orgId: ID };
    gate120(user, 'org.matrix.read', 'branch', 'matrix');
    sameOrg(user, orgId, 'org.matrix.read');
    const { from, to } = (req.query ?? {}) as { from?: string; to?: string };
    const events = (await repo.listEvents(orgId))
      .filter(e => (!from || e.date >= from) && (!to || e.date <= to))
      .filter(e => eventInScope(user, e)); // v1.20.2 §21.1א: scope-filtered lists
    const grouped: Record<string, { event: EventNode; tasks: TaskNode[] }[]> = {};
    for (const e of events) {
      const key = e.branchId ?? '_unassigned';
      (grouped[key] ??= []).push({ event: e, tasks: await repo.listTasks(e.id) });
    }
    return { branches: await repo.listBranches(orgId), grouped };
  });

  // ---- §22 stakeholders (v1.20.2: link validation + dedupe + state machine) ----
  const validateLinks = async (user: UserRecord, links: { entity?: string; entityId?: ID; relation?: string }[]): Promise<import('@contake/core').StakeholderLink[]> => {
    const out: import('@contake/core').StakeholderLink[] = [];
    for (const l of links) {
      if (!l.entity || !l.entityId || !l.relation || typeof l.relation !== 'string' || l.relation.trim() === '') {
        fail(400, 'BAD_REQUEST', 'קישור חסר entity / entityId / relation');
      }
      if (!['event', 'task', 'resource'].includes(l.entity)) fail(400, 'BAD_REQUEST', 'סוג ישות קישור לא תקין');
      // v1.20.2 §23.1א: target must exist in the same org; no blind casts.
      if (l.entity === 'event') {
        const e = await repo.getEvent(l.entityId);
        if (!e || e.orgId !== user.orgId) fail(400, 'BAD_REQUEST', 'יעד הקישור לא נמצא');
      } else if (l.entity === 'task') {
        const t = await repo.getTask(l.entityId);
        const e = t ? await repo.getEvent(t.eventId) : undefined;
        if (!t || !e || e.orgId !== user.orgId) fail(400, 'BAD_REQUEST', 'יעד הקישור לא נמצא');
      } else {
        const snap = await repo.getResource(l.entityId);
        if (!snap) fail(400, 'BAD_REQUEST', 'יעד הקישור לא נמצא');
        const e = await repo.getEvent(snap.eventId);
        if (!e || e.orgId !== user.orgId) fail(400, 'BAD_REQUEST', 'יעד הקישור לא נמצא');
      }
      out.push({ entity: l.entity as 'event' | 'task' | 'resource', entityId: l.entityId, relation: l.relation });
    }
    return out;
  };
  // consent legal transitions: pending -> granted|revoked; granted -> revoked; revoked terminal.
  const consentTransitionOk = (fromS: string, toS: string): boolean =>
    fromS === toS || (fromS === 'pending' && (toS === 'granted' || toS === 'revoked')) || (fromS === 'granted' && toS === 'revoked');
  /** stakeholder visibility for scope roles: linked to an in-scope event (directly
   *  or via a linked task). Org-level unlinked parties are admin-visible only. */
  const partyVisible = async (user: UserRecord, party: ExternalParty): Promise<boolean> => {
    if (user.role === 'admin') return true;
    for (const l of party.links) {
      if (l.entity === 'event') {
        const e = await repo.getEvent(l.entityId);
        if (e && e.orgId === user.orgId && eventInScope(user, e)) return true;
      } else if (l.entity === 'task') {
        const t = await repo.getTask(l.entityId);
        const e = t ? await repo.getEvent(t.eventId) : undefined;
        if (t && e && e.orgId === user.orgId && taskInScope(user, e.id, t.siteId)) return true;
      }
    }
    return false;
  };

  app.post('/v1/orgs/:orgId/stakeholders', async (req, reply) => {
    const user = await me(req);
    const { orgId } = req.params as { orgId: ID };
    gate120(user, 'stakeholder.create', 'external_party', 'pending');
    sameOrg(user, orgId, 'stakeholder.create');
    const body = (req.body ?? {}) as Partial<ExternalParty> & { clientMutationId?: string };
    if (!body.kind || !body.displayName) fail(400, 'BAD_REQUEST', 'חסרים kind / displayName');
    if (!['guardian', 'supplier', 'client'].includes(body.kind)) fail(400, 'BAD_REQUEST', 'סוג נמען לא תקין');
    if (body.consent?.status !== undefined && !['pending', 'granted', 'revoked'].includes(body.consent.status)) fail(400, 'BAD_REQUEST', 'סטטוס הסכמה לא תקין');
    const key = requireMutationKey(body.clientMutationId);
    // v1.20.2: initial links are validated, never injected unchecked.
    const links = await validateLinks(user, body.links ?? []);
    return idemExec('stakeholder.create', user, key, body, reply, async (record) => {
      const party: ExternalParty = {
        id: newId('xp'), orgId, kind: body.kind!, displayName: body.displayName!,
        contactRefs: (body.contactRefs ?? []).map(c => ({ ...c, transport: 'deferred' as const })),
        links,
        consent: { status: body.consent?.status ?? 'pending', at: new Date().toISOString() },
        createdAt: new Date().toISOString(), version: 1,
      };
      const out = { party };
      await withAuditSafety(repo, async () => {
        await repo.createExternalParty(party);
        await audit(repo, { orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
          action: 'stakeholder.create', entityType: 'external_party', entityId: party.id, after: party, deviceClass: deviceClassOf(ua(req)) });
        await record(out);
      });
      return out;
    });
  });

  app.get('/v1/stakeholders', async (req) => {
    const user = await me(req);
    gate120(user, 'stakeholder.read', 'external_party', 'list');
    // contactRefs carry the contactPhone privacy class: admin/field_manager only,
    // which are exactly the roles stakeholder.read allows; focus_worker is denied above.
    const parties = await repo.listExternalParties(user.orgId);
    const visible: ExternalParty[] = [];
    for (const p of parties) if (await partyVisible(user, p)) visible.push(p);
    return { parties: visible };
  });

  app.patch('/v1/stakeholders/:id', async (req, reply) => {
    const user = await me(req);
    const { id } = req.params as { id: ID };
    gate120(user, 'stakeholder.update', 'external_party', id);
    const before = await repo.getExternalParty(id);
    if (!before || before.orgId !== user.orgId) fail(404, 'NOT_FOUND', 'הנמען לא נמצא');
    const patch = (req.body ?? {}) as Partial<ExternalParty> & { clientMutationId?: string };
    const key = requireMutationKey(patch.clientMutationId);
    if (patch.links) fail(400, 'BAD_REQUEST', 'עדכון קישורים דרך /links בלבד');
    if (patch.consent?.status !== undefined) {
      if (!['pending', 'granted', 'revoked'].includes(patch.consent.status)) fail(400, 'BAD_REQUEST', 'סטטוס הסכמה לא תקין');
      if (!consentTransitionOk(before.consent.status, patch.consent.status)) fail(409, 'ILLEGAL_TRANSITION', 'מעבר מצב הסכמה לא חוקי');
    }
    return idemExec('stakeholder.update', user, key, patch, reply, async (record) => {
      const clean = { ...patch } as Record<string, unknown>;
      for (const f of ['id', 'orgId', 'version', 'clientMutationId', 'createdAt']) delete clean[f];
      if (patch.consent?.status !== undefined) clean['consent'] = { status: patch.consent.status, at: new Date().toISOString() };
      const out = await withAuditSafety(repo, async () => {
        const n = await repo.updateExternalParty(id, clean as Partial<ExternalParty>);
        await audit(repo, { orgId: user.orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
          action: 'stakeholder.update', entityType: 'external_party', entityId: id, before, after: n, deviceClass: deviceClassOf(ua(req)) });
        const o = { party: n };
        await record(o);
        return o;
      });
      return out;
    });
  });

  app.delete('/v1/stakeholders/:id', async (req) => {
    const user = await me(req);
    const { id } = req.params as { id: ID };
    gate120(user, 'stakeholder.delete', 'external_party', id);
    const before = await repo.getExternalParty(id);
    if (!before || before.orgId !== user.orgId) fail(404, 'NOT_FOUND', 'הנמען לא נמצא');
    await withAuditSafety(repo, async () => {
      await repo.deleteExternalParty(id);
      await audit(repo, { orgId: user.orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
        action: 'stakeholder.delete', entityType: 'external_party', entityId: id, before, deviceClass: deviceClassOf(ua(req)) });
    });
    return { deleted: true };
  });

  app.post('/v1/stakeholders/:id/links', async (req, reply) => {
    const user = await me(req);
    const { id } = req.params as { id: ID };
    gate120(user, 'stakeholder.link', 'external_party', id);
    const before = await repo.getExternalParty(id);
    if (!before || before.orgId !== user.orgId) fail(404, 'NOT_FOUND', 'הנמען לא נמצא');
    const body = (req.body ?? {}) as { entity?: 'event' | 'task' | 'resource'; entityId?: ID; relation?: string; clientMutationId?: string };
    const key = requireMutationKey(body.clientMutationId);
    const [link] = await validateLinks(user, [body]);
    return idemExec('stakeholder.link', user, key, body, reply, async (record) => {
      const out = await withAuditSafety(repo, async () => {
        const n = await repo.updateExternalParty(id, { links: [...before.links, link!] });
        await audit(repo, { orgId: user.orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
          action: 'stakeholder.link', entityType: 'external_party', entityId: id, before: before.links, after: n?.links, deviceClass: deviceClassOf(ua(req)) });
        const o = { party: n };
        await record(o);
        return o;
      });
      return out;
    });
  });

  // §22 G6: manager-issued, revocable guest status token.
  // v1.20.2 §24.1א: >=128-bit random, HMAC+pepper storage, 72h expiry, rate-limited.
  app.post('/v1/stakeholders/:id/status-token', async (req) => {
    const user = await me(req);
    const { id } = req.params as { id: ID };
    if (user.role === 'focus_worker') {
      fail(403, 'FORBIDDEN', 'אין לך הרשאה לפעולה זו', {
        reason: 'matrix_deny', action: 'stakeholder.link', entityType: 'status_token', entityId: id, eventId: 'pending',
      });
    }
    // v2.1 #4: intentionally NOT deduped - every call mints a new token (bounded
    // by this rate limit; retries may create multiple tokens, UI shows them all).
    if (!rateOk(`sttok:${user.userId}`, Number(process.env['CONTAKE_RL_TOKEN_CREATE'] ?? 10), 3_600_000)) {
      fail(429, 'RATE_LIMITED', 'יותר מדי בקשות - נסו שוב מאוחר יותר');
    }
    const party = await repo.getExternalParty(id);
    if (!party || party.orgId !== user.orgId) fail(404, 'NOT_FOUND', 'הנמען לא נמצא');
    const peppers = peppersFromEnv();
    const plaintext = mintStatusToken();
    const now = Date.now();
    const tok: StatusToken = {
      id: newId('st'), orgId: user.orgId, externalPartyId: id,
      tokenHash: hashToken(peppers.current, plaintext),
      createdBy: user.userId, createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + tokenTtlMs()).toISOString(),
    };
    await withAuditSafety(repo, async () => {
      await repo.createStatusToken(tok);
      await audit(repo, { orgId: user.orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
        action: 'stakeholder.link', entityType: 'status_token', entityId: tok.id, after: { externalPartyId: id, expiresAt: tok.expiresAt }, deviceClass: deviceClassOf(ua(req)) });
    });
    // Plaintext is returned exactly once here; only the HMAC is persisted.
    return { statusToken: { ...tok, token: plaintext } };
  });

  app.delete('/v1/status-tokens/:id', async (req) => {
    const user = await me(req);
    const { id } = req.params as { id: ID };
    if (user.role === 'focus_worker') {
      fail(403, 'FORBIDDEN', 'אין לך הרשאה לפעולה זו', {
        reason: 'matrix_deny', action: 'stakeholder.link', entityType: 'status_token', entityId: id, eventId: 'pending',
      });
    }
    // revoke by token id only (TL pre-merge review: raw token in URL path is 404)
    const target = await repo.getStatusToken(id);
    if (!target) fail(404, 'NOT_FOUND', 'הטוקן לא נמצא');
    if (target.orgId !== user.orgId) fail(404, 'NOT_FOUND', 'הטוקן לא נמצא');
    // v2.1 #4: naturally idempotent - re-revoke returns current state, no dup audit.
    if (target.revokedAt) return { statusToken: target };
    const next = await repo.updateStatusToken(target.id, { revokedAt: new Date().toISOString() });
    await audit(repo, { orgId: user.orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
      action: 'stakeholder.link', entityType: 'status_token', entityId: target.id, after: { revokedAt: next?.revokedAt }, deviceClass: deviceClassOf(ua(req)) });
    return { statusToken: next };
  });

  // §22 G6 public guest surface (token-authenticated, no session). Read-only;
  // schedule + statuses of linked entities only; no PII beyond participant name.
  app.get('/v1/public/status/:accessToken', async (req) => {
    const { accessToken } = req.params as { accessToken: string };
    if (!rateOk(`pubstatus:${req.ip}`, Number(process.env['CONTAKE_RL_PUBLIC_STATUS'] ?? 60), 60_000)) {
      fail(429, 'RATE_LIMITED', 'יותר מדי בקשות - נסו שוב מאוחר יותר');
    }
    const peppers = peppersFromEnv();
    // Lookup by HMAC against the indexed hash column; dual-pepper rotation window.
    let tok = await repo.getStatusTokenByHash(hashToken(peppers.current, accessToken));
    if (!tok && peppers.previous) tok = await repo.getStatusTokenByHash(hashToken(peppers.previous, accessToken));
    if (!tok || tok.revokedAt || Date.parse(tok.expiresAt) <= Date.now()) fail(404, 'NOT_FOUND', 'הקישור אינו זמין');
    const party = await repo.getExternalParty(tok.externalPartyId);
    if (!party) fail(404, 'NOT_FOUND', 'הקישור אינו זמין');
    const schedule: { eventId: ID; name: string; date: string; status: string; tasks: { id: ID; name: string; start: string | null; status: string }[] }[] = [];
    for (const l of party.links.filter(l => l.entity === 'event')) {
      const e = await repo.getEvent(l.entityId);
      if (!e || e.orgId !== tok.orgId) continue;
      schedule.push({
        eventId: e.id, name: e.name, date: e.date, status: e.status,
        tasks: (await repo.listTasks(e.id)).map(t => ({ id: t.id, name: t.name, start: t.start, status: t.status })),
      });
    }
    return { participant: party.displayName, schedule };
  });


  // ---- §23 branches ----
  app.post('/v1/orgs/:orgId/branches', async (req, reply) => {
    const user = await me(req);
    const { orgId } = req.params as { orgId: ID };
    gate120(user, 'branch.create', 'branch', 'pending');
    sameOrg(user, orgId, 'branch.create');
    const body = (req.body ?? {}) as { name?: string; location?: string; clientMutationId?: string };
    if (!body.name) fail(400, 'BAD_REQUEST', 'חסר שם סניף');
    const key = requireMutationKey(body.clientMutationId);
    return idemExec('branch.create', user, key, body, reply, async (record) => {
      const branch: Branch = { id: newId('br'), orgId, name: body.name!, ...(body.location ? { location: body.location } : {}), active: true, createdAt: new Date().toISOString(), version: 1 };
      const out = { branch };
      await withAuditSafety(repo, async () => {
        await repo.createBranch(branch);
        await audit(repo, { orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
          action: 'branch.create', entityType: 'branch', entityId: branch.id, after: branch, deviceClass: deviceClassOf(ua(req)) });
        await record(out);
      });
      return out;
    });
  });

  app.get('/v1/branches', async (req) => {
    const user = await me(req);
    gate120(user, 'branch.read', 'branch', 'list');
    const branches = await repo.listBranches(user.orgId);
    if (user.role === 'admin') return { branches };
    // v2.1 #1: org-level entities reach scope roles only via in-scope events.
    const scoped: Branch[] = [];
    for (const b of branches) {
      const events = await repo.listEvents(user.orgId);
      if (events.some(e => e.branchId === b.id && eventInScope(user, e))) scoped.push(b);
    }
    return { branches: scoped };
  });

  app.patch('/v1/branches/:id', async (req, reply) => {
    const user = await me(req);
    const { id } = req.params as { id: ID };
    gate120(user, 'branch.update', 'branch', id);
    const before = await repo.getBranch(id);
    if (!before || before.orgId !== user.orgId) fail(404, 'NOT_FOUND', 'הסניף לא נמצא');
    const patch = (req.body ?? {}) as Partial<Branch> & { clientMutationId?: string };
    const key = requireMutationKey(patch.clientMutationId);
    return idemExec('branch.update', user, key, patch, reply, async (record) => {
      const clean = { ...patch } as Record<string, unknown>;
      for (const f of ['id', 'orgId', 'version', 'clientMutationId', 'createdAt']) delete clean[f];
      const out = await withAuditSafety(repo, async () => {
        const n = await repo.updateBranch(id, clean as Partial<Branch>);
        await audit(repo, { orgId: user.orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
          action: 'branch.update', entityType: 'branch', entityId: id, before, after: n, deviceClass: deviceClassOf(ua(req)) });
        const o = { branch: n };
        await record(o);
        return o;
      });
      return out;
    });
  });

  app.post('/v1/branches/:id/archive', async (req) => {
    const user = await me(req);
    const { id } = req.params as { id: ID };
    gate120(user, 'branch.archive', 'branch', id);
    const before = await repo.getBranch(id);
    if (!before || before.orgId !== user.orgId) fail(404, 'NOT_FOUND', 'הסניף לא נמצא');
    const next = await withAuditSafety(repo, async () => {
      const n = await repo.updateBranch(id, { active: false });
      await audit(repo, { orgId: user.orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
        action: 'branch.archive', entityType: 'branch', entityId: id, before, after: n, deviceClass: deviceClassOf(ua(req)) });
      return n;
    });
    return { branch: next };
  });

  // ---- §24 report list + read state ----
  app.get('/v1/reports', async (req) => {
    const user = await me(req);
    gate120(user, 'report.list', 'report', 'list');
    const { eventId, status, unread, cursor, limit: limitRaw } = (req.query ?? {}) as { eventId?: ID; status?: string; unread?: string; cursor?: string; limit?: string };
    const limit = Math.min(Math.max(Number(limitRaw ?? 50) || 50, 1), 200);
    const orgEvents = await repo.listEvents(user.orgId);
    const events = (eventId ? orgEvents.filter(e => e.id === eventId) : orgEvents)
      .filter(e => eventInScope(user, e)); // v1.20.2 §21.1א
    if (eventId && events.length === 0) fail(404, 'NOT_FOUND', 'האירוע לא נמצא');
    const readStates = await repo.listReportReadStates(user.userId);
    const readAtByReport = new Map(readStates.map(r => [r.reportId, r.readAt]));
    const reports: (StatusReport & { readAt?: string })[] = [];
    for (const e of events) {
      for (const r of await repo.listReports(e.id)) {
        // v1.20.2 §21.1א (QA pre-adjudication 2026-09-17): list visibility is
        // task/site-scoped, matching mark-read. Event-level admission alone
        // leaked other-site reports to site-scoped FMs in multi-site events.
        // An unresolvable task is fail-closed for every role.
        const task = await repo.getTask(r.taskId);
        if (!task || !taskInScope(user, e.id, task.siteId)) continue;
        if (status && r.status !== status) continue;
        const readAt = readAtByReport.get(r.id);
        if (unread === 'true' && readAt) continue;
        reports.push({ ...r, ...(readAt ? { readAt } : {}) });
      }
    }
    // v1.20.2 §26.1ב: stable order (createdAt, id) + cursor pagination.
    reports.sort((a, b) => a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt));
    let startIdx = 0;
    if (cursor) {
      const [cat, cid] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
      startIdx = reports.findIndex(r => r.createdAt > cat! || (r.createdAt === cat && r.id > cid!));
      if (startIdx === -1) startIdx = reports.length;
    }
    const page = reports.slice(startIdx, startIdx + limit);
    const last = page[page.length - 1];
    const nextCursor = startIdx + limit < reports.length && last
      ? Buffer.from(`${last.createdAt}|${last.id}`, 'utf8').toString('base64url') : undefined;
    return { reports: page, ...(nextCursor ? { nextCursor } : {}) };
  });

  app.post('/v1/reports/:id/read', async (req) => {
    const user = await me(req);
    const { id } = req.params as { id: ID };
    gate120(user, 'report.mark_read', 'report', id);
    const report = await repo.getReport(id);
    if (!report) fail(404, 'NOT_FOUND', 'הדיווח לא נמצא');
    const task = await repo.getTask(report.taskId);
    const ev = task ? await repo.getEvent(task.eventId) : undefined;
    if (!ev || ev.orgId !== user.orgId) fail(404, 'NOT_FOUND', 'הדיווח לא נמצא');
    if (!taskInScope(user, ev.id, task!.siteId)) scopeDeny(user, 'report.mark_read', 'report', id);
    // v1.20.2 §26.1ב: mark-read is audited in the same write; a repeat is a no-op
    // returning the existing state with NO second audit row.
    const existing = await repo.getReportReadState(id, user.userId);
    if (existing) return { readState: existing };
    const st = { reportId: id, userId: user.userId, readAt: new Date().toISOString() };
    await withAuditSafety(repo, async () => {
      await repo.markReportRead(st);
      await audit(repo, { orgId: user.orgId, eventId: ev.id, actorUserId: user.userId, role: user.role,
        action: 'report.mark_read', entityType: 'report', entityId: id, after: st, deviceClass: deviceClassOf(ua(req)) });
    });
    return { readState: st };
  });

  // ---- §25 inbound opt-out webhook (v1.20.2 §25.1א/ב: fail-closed, timing-safe,
  // rate-limited, replay-protected; deterministic STOP routing with durable
  // suppression and channel.optout machine-principal audit taxonomy) ----
  app.post('/v1/webhooks/inbound', async (req, reply) => {
    // Fail-closed: without a configured secret (outside explicit test mode) NO
    // request is processed.
    const expected = process.env['CONTAKE_INBOUND_SECRET'];
    if (!expected) {
      if (process.env['CONTAKE_TEST_MODE'] !== 'true') fail(503, 'UNAVAILABLE', 'השירות אינו מוגדר');
    } else {
      const provided = req.headers['x-inbound-secret'];
      if (typeof provided !== 'string' || !timingSafeEqualStr(provided, expected)) {
        fail(401, 'UNAUTHENTICATED', 'נדרש אימות');
      }
    }
    const body = (req.body ?? {}) as { channel?: string; receivingAccount?: string; from?: string; body?: string; providerEventId?: string };
    if (!body.channel || !body.receivingAccount || !body.from || typeof body.body !== 'string') {
      fail(400, 'BAD_REQUEST', 'חסרים channel / receivingAccount / from / body');
    }
    if (!rateOk(`webhook:${req.ip}:${body.channel}`, Number(process.env['CONTAKE_RL_WEBHOOK'] ?? 30), 60_000)) {
      fail(429, 'RATE_LIMITED', 'יותר מדי בקשות - נסו שוב מאוחר יותר');
    }
    const channel = body.channel!;
    const receivingAccount = body.receivingAccount!;
    const address = normalizeAddress(body.from!);
    const text = body.body!.trim();
    const bodyHash = bodyHashOf(body.body!);
    const receivedAt = new Date().toISOString();
    const correlation = {
      from: maskAddress(address), channel, receivingAccount, receivedAt, bodyHash,
      ...(body.providerEventId ? { providerEventId: body.providerEventId } : {}),
    };
    // Replay protection (§25.1א): providerEventId key when supplied, else
    // (channel, receivingAccount, from, bodyHash) inside a 24h window.
    const idemKey = body.providerEventId
      ? `pe:${channel}:${receivingAccount}:${body.providerEventId}`
      : `bh:${channel}:${receivingAccount}:${address}:${bodyHash}`;
    const replayRec = await repo.getIdempotencyRecord('system', 'system-inbound', 'webhook.inbound', idemKey);
    if (replayRec && (body.providerEventId !== undefined || Date.now() - Date.parse(replayRec.createdAt) < 24 * 3_600_000)) {
      const stored = JSON.parse(replayRec.responseBody) as { handled: number; reason?: string; _ctx?: { suppressionId?: string; partyId?: string; optOutAt?: string } };
      if (stored.handled === 1 && stored._ctx) {
        // Identical STOP replay: 200 idempotent + no-op audit correlated to the original.
        await audit(repo, { orgId: 'system', eventId: 'pending', actorUserId: 'system-inbound', role: 'system',
          action: 'channel.optout', entityType: 'optout_suppression', entityId: stored._ctx.suppressionId ?? stored._ctx.partyId ?? 'unknown',
          after: { noOp: true, replayOf: idemKey, suppressionId: stored._ctx.suppressionId ?? null, partyId: stored._ctx.partyId ?? null, optOutAt: stored._ctx.optOutAt ?? null, correlation } });
      }
      reply.header('Idempotency-Replayed', 'true');
      // Public response never reveals which path hit: strip internal correlation.
      return { handled: stored.handled, ...(stored.reason ? { reason: stored.reason } : {}) };
    }
    const recordWebhook = async (responseBody: object): Promise<void> => {
      await repo.putIdempotencyRecord({
        orgId: 'system', actorId: 'system-inbound', route: 'webhook.inbound', clientMutationId: idemKey,
        requestHash: bodyHash, statusCode: 200, responseBody: JSON.stringify(responseBody), createdAt: receivedAt,
      });
    };

    const isStop = /^(stop|remove)\b/i.test(text) || /^(הסרה?|ביטול|בטל)(\s|$)/.test(text);
    if (!isStop) {
      const out = { handled: 0, reason: 'not_opt_out' };
      await recordWebhook(out);
      return out;
    }

    // Deterministic STOP routing on (channel, receivingAccount, normalizedAddress).
    // Path (א): modelled ExternalParty -> consent revoked (entityType external_party).
    const party = await repo.findExternalPartyByContactRef(address);
    // Path (ב): modelled subscriber channel -> optedOut=true (entityType subscriber_channel).
    const ch = await repo.findChannelByAddress(address);
    const involvedOrgs = [...new Set([party?.orgId, ch?.orgId].filter((o): o is ID => o !== undefined))];
    if (involvedOrgs.length > 1) {
      // Multi-tenant ambiguity (or no routing): deterministic rule - GLOBAL
      // optout_suppression (orgId NULL) suppressing this (channel, address) in
      // every tenant. No cross-tenant revoke, no arbitrary pick.
      const existing = await repo.findActiveSuppression(channel, address);
      if (existing) {
        await recordWebhook({ handled: 1, _ctx: { suppressionId: existing.id, optOutAt: existing.createdAt } });
        await audit(repo, { orgId: 'system', eventId: 'pending', actorUserId: 'system-inbound', role: 'system',
          action: 'channel.optout', entityType: 'optout_suppression', entityId: existing.id,
          after: { noOp: true, alreadySuppressed: true, suppressionId: existing.id, optOutAt: existing.createdAt, correlation } });
        return { handled: 1 };
      }
      const suppression: OptoutSuppression = {
        id: newId('os'), channel, address, addressMasked: maskAddress(address), orgId: null,
        createdAt: receivedAt, correlation: { from: address, channel, receivingAccount, receivedAt, bodyHash, ...(body.providerEventId ? { providerEventId: body.providerEventId } : {}) },
      };
      await repo.createOptoutSuppression(suppression);
      for (const orgId of involvedOrgs) {
        await audit(repo, { orgId, eventId: 'pending', actorUserId: 'system-inbound', role: 'system',
          action: 'channel.optout', entityType: 'optout_suppression', entityId: suppression.id,
          after: { ambiguousMultiTenant: true, global: true, addressMasked: suppression.addressMasked, correlation } });
      }
      await recordWebhook({ handled: 1, _ctx: { suppressionId: suppression.id, optOutAt: suppression.createdAt } });
      return { handled: 1 };
    }
    if (party && party.consent.status !== 'revoked') {
      const before = party.consent;
      const after = { status: 'revoked' as const, at: receivedAt };
      await withAuditSafety(repo, async () => {
        await repo.updateExternalParty(party.id, { consent: after });
        await audit(repo, { orgId: party.orgId, eventId: 'pending', actorUserId: 'system-inbound', role: 'system',
          action: 'channel.optout', entityType: 'external_party', entityId: party.id,
          before, after: { ...after, via: 'inbound_webhook', correlation } });
      });
      await recordWebhook({ handled: 1, _ctx: { partyId: party.id, optOutAt: after.at } });
      return { handled: 1 };
    }
    if (ch && !ch.optedOut) {
      const after = { optedOut: true, via: 'inbound_webhook', channel };
      await withAuditSafety(repo, async () => {
        await repo.updateChannel(ch.id, { optedOut: true });
        await audit(repo, { orgId: ch.orgId, eventId: 'pending', actorUserId: 'system-inbound', role: 'system',
          action: 'channel.optout', entityType: 'subscriber_channel', entityId: ch.id,
          before: { optedOut: false }, after: { ...after, correlation } });
      });
      await recordWebhook({ handled: 1, _ctx: { optOutAt: receivedAt } });
      return { handled: 1 };
    }
    if ((party && party.consent.status === 'revoked') || (ch?.optedOut)) {
      // Already opted out on the modelled path: idempotent 200 + no-op audit.
      await recordWebhook({ handled: 1, _ctx: party ? { partyId: party.id, optOutAt: party.consent.at } : { optOutAt: receivedAt } });
      await audit(repo, { orgId: (party?.orgId ?? ch!.orgId), eventId: 'pending', actorUserId: 'system-inbound', role: 'system',
        action: 'channel.optout', entityType: party ? 'external_party' : 'subscriber_channel', entityId: party?.id ?? ch!.id,
        after: { noOp: true, alreadyOptedOut: true, correlation } });
      return { handled: 1 };
    }
    // Path (ג): unmatched - durable optout_suppression (org-scoped when a single
    // tenant context exists, else global-ambiguous NULL).
    const existing = await repo.findActiveSuppression(channel, address);
    if (existing) {
      await recordWebhook({ handled: 1, _ctx: { suppressionId: existing.id, optOutAt: existing.createdAt } });
      return { handled: 1 };
    }
    const suppression: OptoutSuppression = {
      id: newId('os'), channel, address, addressMasked: maskAddress(address), orgId: null,
      createdAt: receivedAt, correlation: { from: address, channel, receivingAccount, receivedAt, bodyHash, ...(body.providerEventId ? { providerEventId: body.providerEventId } : {}) },
    };
    await repo.createOptoutSuppression(suppression);
    await audit(repo, { orgId: 'system', eventId: 'pending', actorUserId: 'system-inbound', role: 'system',
      action: 'channel.optout', entityType: 'optout_suppression', entityId: suppression.id,
      after: { unmatched: true, global: true, addressMasked: suppression.addressMasked, correlation } });
    await recordWebhook({ handled: 1, _ctx: { suppressionId: suppression.id, optOutAt: suppression.createdAt } });
    return { handled: 1 };
  });

  // v2.1 #6: org-admin may remove ONLY an org-scoped suppression of their own org
  // (reason + audit mandatory). Global-ambiguous rows have no user route - their
  // removal is a documented manual ops path only.
  app.delete('/v1/optout-suppressions/:id', async (req) => {
    const user = await me(req);
    const { id } = req.params as { id: ID };
    if (user.role !== 'admin') {
      fail(403, 'FORBIDDEN', 'אין לך הרשאה לפעולה זו', {
        reason: 'matrix_deny', action: 'channel.optout', entityType: 'optout_suppression', entityId: id, eventId: 'pending',
      });
    }
    const all = await repo.listOptoutSuppressions(user.orgId);
    const target = all.find(x => x.id === id);
    if (!target || target.orgId !== user.orgId) fail(404, 'NOT_FOUND', 'רשומת הדיכוי לא נמצאה');
    const q = (req.query ?? {}) as { reason?: string };
    if (!q.reason || q.reason.trim() === '') fail(400, 'BAD_REQUEST', 'חסר reason');
    const removed = await repo.removeOptoutSuppression(id, user.userId, q.reason, new Date().toISOString());
    if (!removed) fail(404, 'NOT_FOUND', 'רשומת הדיכוי לא נמצאה');
    await audit(repo, { orgId: user.orgId, eventId: 'pending', actorUserId: user.userId, role: user.role,
      action: 'channel.optout', entityType: 'optout_suppression', entityId: id,
      before: { active: true }, after: { removedAt: removed.removedAt, reason: q.reason }, deviceClass: deviceClassOf(ua(req)) });
    return { suppression: removed };
  });


  return app;
}

const withOrg = (user: UserRecord): UserRecord => user;
