/**
 * @contake/core — Shared contracts v2 ADDITIVE module (r3 rebuild, 2026-09-17)
 * Built additively on the pinned canonical v1.18 file (contracts.v1.ts,
 * sha256 4c6629a788b33e604b75ff69a3f9ea5882225221d4a5d2e1bfe25e1ab0c9e761).
 * contracts.v1.ts is COPY-VERBATIM and UNTOUCHED; every v1.19/v1.20/v1.20.2/
 * v1.21.4/matrix-v1.5/v1.6 FE-facing shape lands HERE.
 *
 * Provenance (verified packages, sidecars checked):
 *  - v1.19 i18n drop-in (§16) ........ contake-contracts-v1.19-i18n-dropin-d33a5387.md
 *  - v1.19 addendum (§17 idempotency, §18 tombstone PENDING FOUNDER, §19 deliveries)
 *                                      contake-contracts-v1.19-addendum-...-bd7c6733.md
 *  - v1.20 final (§20-§25, §M) ....... contake-contracts-v1.20-93635ab7.md
 *  - v1.20.2 remediation (FE-facing pins; supersedes v1.20.1-for-implementation)
 *                                      contracts-v2-verified/contake-contracts-v1.20.2-remediation.md
 *  - v1.21.4 §26 clarifications ...... contracts-v2-verified/contake-contracts-v1.21.4-clarifications.md
 *  - matrix v1.5 additions ........... matrix.v1.5.additions-7a042ce7.json
 *  - matrix v1.6 additions ........... contracts-v2-verified/matrix.v1.6.additions.json
 * Backend enforcement rules (fail-closed webhook, HMAC token storage, FM scope
 * enforcement, CAS/idempotency tx semantics) are documented here as comments
 * only; this module carries the FE-facing shapes.
 */

import type {
  ID, ISODateTime, Role, Action as ActionV1, NotificationKind as NotificationKindV1,
  AuditEntityType as AuditEntityTypeV1, EventNode, TaskNode, StatusReport,
} from './contracts.v1';

// ============================================================
// §16 BILINGUAL SUPPORT [v1.19]
// ============================================================

export type Locale = 'he' | 'en';

/** v1.19 - display/notification language. Absent => 'he'. */
export interface UserSettings { locale?: Locale; }

/** v1.19 - keyed outbound message. Server renders per-recipient locale at
 *  dispatch (push/SMS) and stores rendered + {key, params} for in-app. */
export interface NotifyMessage {
  key: string;                       // e.g. 'domino.impact', 'task.assigned'
  params: Record<string, string | number>;
}

/** v1.19 - structured domino summary. `text` remains for backward compat
 *  (Hebrew); clients SHOULD render from code+params in user locale. */
export interface DominoSummaryLocalized {
  code: string;                      // e.g. 'domino.none', 'domino.cascade', 'domino.conflict'
  params: Record<string, string | number>;
  text: string;                      // legacy Hebrew rendering, unchanged
}

/** v1.19 - bilingual registry term (registry v1.4). */
export interface TermEntry { he: string; en: string; }

/** GET/PATCH /v1/users/me/settings (self-scope, action user.update-settings). */
export interface UserSettingsResponse { locale: Locale; }
export interface UserSettingsPatchRequest { locale: Locale; }

// ============================================================
// §19 READ-ONLY DELIVERIES SURFACE [v1.19 addendum-2]
// GET /v1/notifications/deliveries?eventId=&changeRequestId=&kind=
// Privacy: NO provider payloads, NO bodies beyond templateKey+params,
// external addresses masked (channel + last-2), in_app targets as userId.
// ============================================================

export type DeliveryTargetType = 'in_app' | 'external-masked';

export interface DeliveryRecord {
  jobId: ID;
  kind: string;
  templateKey: string;
  params: Record<string, string | number>;
  targetType: DeliveryTargetType;
  status: string;
  attempts: number;
  provider?: string;
  terminalState?: string;
  createdAt: ISODateTime;
  lastAttemptAt?: ISODateTime;
  terminalAt?: ISODateTime;
}

// ============================================================
// §20 CONTENT SURFACE [v1.20, amended v1.20.2 §20.1א]
// ============================================================

/** v1.20 §20: kind 'file' is BLOCKED in alpha (file = external URL only). */
export type ContentKind = 'text' | 'link' | 'checklist' | 'equipment' | 'form';

export interface ContentItem {
  id: ID;
  orgId: ID;
  kind: ContentKind;
  title: string;
  body?: string;
  url?: string;
  checklistItems?: string[];
  meta: Record<string, unknown>;
  createdBy: ID;
  createdAt: ISODateTime;
  version: number;
}

/** v1.20.2 §20.1א: every version is an immutable row with its own
 *  contentVersionId; head advances via CAS on (contentId, expectedVersion);
 *  conflict => 409 VERSION_CONFLICT. History returns ALL versions; delete is
 *  tombstone-only (admin), links and versions retained and readable. */
export interface ContentVersionEntry extends ContentItem {
  contentVersionId: ID;
  contentId: ID;
}

export type ContentRole = 'instructions' | 'script' | 'checklist' | 'equipment' | 'form';

export interface TaskResource {
  taskId: ID;
  contentId: ID;
  role: ContentRole;
  visibleFromOffsetMin: number;
  visibleUntil?: ISODateTime;
  ackRequired?: boolean;
}

export interface ContentCreateRequest {
  kind: ContentKind;
  title: string;
  body?: string;
  url?: string;
  checklistItems?: string[];
  meta?: Record<string, unknown>;
  clientMutationId: string;   // v1.20.2 §26.3א: required
}

export interface ContentUpdateRequest {
  title?: string;
  body?: string;
  url?: string;
  checklistItems?: string[];
  meta?: Record<string, unknown>;
  expectedVersion: number;    // v1.20.2 §20.1א CAS; conflict => 409 VERSION_CONFLICT
}

export interface ContentAttachRequest {
  contentId: ID;
  role: ContentRole;
  visibleFromOffsetMin: number;
  visibleUntil?: ISODateTime;
  ackRequired?: boolean;
  clientMutationId: string;   // v1.20.2 §26.3א: required (was optional/ignored)
}

/** POST /v1/content/:id/ack — v1.20.2 §26.3א: clientAckId required,
 *  dedupe isolated per org+actor (was global). */
export interface ContentAckRequest {
  clientAckId: string;
  taskId: ID;
}

/** GET /v1/focus/now [NEW in v1.20 — not an extension of an existing route]. */
export interface FocusNowResponse {
  currentTask: TaskNode | null;
  nextTask: TaskNode | null;
  visibleResources: TaskResource[];   // simple task => []
  window: { from: ISODateTime; until?: ISODateTime };
}

// ============================================================
// §22 EXTERNAL STAKEHOLDERS [v1.20]
// ============================================================

export type ExternalPartyKind = 'guardian' | 'supplier' | 'client';
export type ContactChannel = 'in_app' | 'whatsapp' | 'sms';
export type ConsentStatus = 'pending' | 'granted' | 'revoked';

/** Privacy: contactRefs visible to admin/field_manager ONLY — never in
 *  realtime frames, never in focus_worker payloads, never cross-party. */
export interface ContactRef {
  channel: ContactChannel;
  value: string;
  transport: 'deferred';            // whatsapp/sms deferred per founder decision 11.9
}

export interface ExternalPartyLink {
  entity: 'event' | 'task' | 'resource';
  entityId: ID;
  relation: string;
}

export interface ExternalParty {
  id: ID;
  orgId: ID;
  kind: ExternalPartyKind;
  displayName: string;
  contactRefs: ContactRef[];
  links: ExternalPartyLink[];
  consent: { status: ConsentStatus; at: ISODateTime };
  createdAt: ISODateTime;
  version: number;
}

export interface StakeholderCreateRequest {
  kind: ExternalPartyKind;
  displayName: string;
  contactRefs: ContactRef[];
  clientMutationId: string;         // v1.20.2 §26.3א
}

export interface StakeholderLinkRequest {
  entity: 'event' | 'task' | 'resource';
  entityId: ID;
  relation: string;
  clientMutationId: string;         // v1.20.2 §26.3א
}

/** §24.1א status tokens [v1.20.2]: plaintext shown ONCE at creation; server
 *  stores HMAC-SHA256(token, pepper) only. expiresAt required (default 72h,
 *  org-configurable). Revoke by id only. */
export interface StatusToken {
  id: ID;
  orgId: ID;
  partyId: ID;
  expiresAt: ISODateTime;
  revokedAt?: ISODateTime;
  createdAt: ISODateTime;
}

/** Response of POST /v1/stakeholders/:id/status-token — carries the one-time
 *  plaintext token. */
export interface StatusTokenCreateResponse {
  token: StatusToken;
  plaintext: string;                // shown once, never stored server-side
}

/** §22 G6: GET /v1/public/status/:accessToken — read-only guest surface;
 *  schedule + statuses of the linked participant/group only; no PII beyond
 *  participant name and schedule. Token-based, no matrix action. */
export interface PublicStatusResponse {
  participantName: string;
  schedule: Array<{ taskId: ID; name: string; start: ISODateTime; status: string }>;
}

// ============================================================
// §23 BRANCHES [v1.20]
// ============================================================

export interface Branch {
  id: ID;
  orgId: ID;
  name: string;
  location?: string;
  active: boolean;
  createdAt: ISODateTime;
  version: number;
}

export interface BranchCreateRequest {
  name: string;
  location?: string;
  clientMutationId: string;         // v1.20.2 §26.3א
}

export interface BranchUpdateRequest {
  name?: string;
  location?: string;
  active?: boolean;
}

/** §23 additive nullable EventNode.branchId — an existing event stays legal.
 *  Branch is org-level; siteId stays event-level. No domino impact. */
export type EventNodeV2 = EventNode & { branchId?: ID };

/** GET /v1/orgs/:orgId/matrix?from&to [NEW v1.20 §21] — read-only;
 *  events/tasks grouped by branchId. */
export interface OrgMatrixResponse {
  branches: Branch[];
  events: EventNodeV2[];
  tasksByEvent: Record<ID, TaskNode[]>;
}

// ============================================================
// §24 FIELD REPORT SURFACE [v1.20]
// ============================================================

/** GET /v1/reports?eventId=&status=&unread= [NEW] — admin allow,
 *  field_manager scope, focus_worker deny. */
export interface ReportListItem extends StatusReport {
  readBy: ID[];                     // per-manager read state
}

/** v1.21.4 §26: report.correct — reason required, non-empty, <=500 chars,
 *  stored unredacted in the audit row; access admin(same org)+author; FM sees
 *  own; never in public/shared views. actualFinishAt <= now+5min; before task
 *  start => 400 unless allowBeforeStart:true + dedicated audit event. */
export interface ReportCorrectRequest {
  reason: string;                   // required, 1..500 chars
  actualFinishAt: ISODateTime;
  allowBeforeStart?: boolean;
  clientMutationId: string;         // v1.21.2 §26, dedupe per v1.20.2 §26.3א
}

/** v1.21.4 §26: task.advance. */
export interface TaskAdvanceRequest {
  clientMutationId: string;
}

/** v1.21.4 ambiguity 11: legal proposal state machine.
 *  proposed -> approved | rejected | staled; approved -> applied | staled;
 *  applied/rejected/staled terminal. Any other transition => 409
 *  ILLEGAL_TRANSITION. Every transition is CAS on (id, expectedVersion);
 *  conflict => 409 VERSION_CONFLICT. */
export type ProposalState = 'proposed' | 'approved' | 'rejected' | 'staled' | 'applied';

// ============================================================
// §25 INBOUND OPT-OUT WEBHOOK [v1.20, amended v1.20.2 §25.1א/ב]
// ============================================================

/** POST /v1/webhooks/inbound [NEW] — provider-neutral input.
 *  v1.20.2: fail-closed (no secret => 503); timing-safe compare; malformed
 *  body => 400; replay protection keyed (channel, receivingAccount,
 *  providerEventId) else (channel, receivingAccount, from, bodyHash)/24h;
 *  identical replay => 200 idempotent + no-op audit.
 *  v1.20.2 §25.1ב: channel.optout is machine-principal-only (all user roles
 *  deny; executed solely by actor system-inbound). */
export interface InboundWebhookBody {
  channel: ContactChannel;
  receivingAccount: string;
  from: string;
  body: string;
  providerEventId?: string;
}

// ============================================================
// UNIONS — additive extensions (v1 unions untouched)
// ============================================================

/** v1.19: user.update-settings (all roles allow, scope=self).
 *  v1.19 addendum-2: notifications.deliveries.read (admin allow, scope=org,
 *  others deny). v1.5 rows + v1.6 rows per matrix.v2.json.
 *  QA-corrected counts (2026-09-17): runtime enforced on current main = 27
 *  (v1.4 rows); pending remediation target = 48 (+18 v1.5, +3 v1.6);
 *  committed universe = 50. The two v1.19 actions are pending-implementation
 *  and MUST NOT be exposed as functional UI permissions. */
export type Action =
  | ActionV1
  | 'user.update-settings'                // v1.19 - contract-committed, implementation-pending (route not in main; adjudication v1.0)
  | 'notifications.deliveries.read'       // v1.19 addendum-2 §19 - implementation-pending (adjudication v1.0)
  | 'content.create' | 'content.update' | 'content.delete'
  | 'content.attach' | 'content.read' | 'content.ack'          // v1.5
  | 'report.list' | 'report.mark_read'                         // v1.5
  | 'stakeholder.create' | 'stakeholder.update' | 'stakeholder.delete'
  | 'stakeholder.link' | 'stakeholder.read'                    // v1.5
  | 'branch.create' | 'branch.update' | 'branch.archive' | 'branch.read' // v1.5
  | 'org.matrix.read'                                          // v1.5
  | 'channel.optout'                      // v1.6 (machine-principal-only)
  | 'task.advance' | 'report.correct';    // v1.6 (v1.21.2 §26)

/** v1.20 §24: report_blocked (blocked reports surface to admins; no push). */
export type NotificationKind = NotificationKindV1 | 'report_blocked';

/** v1.5: content_item, external_party, status_token, branch.
 *  v1.20.2 §25.1ב: subscriber_channel, optout_suppression. */
export type AuditEntityType =
  | AuditEntityTypeV1
  | 'content_item' | 'external_party' | 'status_token' | 'branch'
  | 'subscriber_channel' | 'optout_suppression';

// ============================================================
// ERROR CODES — additive wire shape pins
// ============================================================

/** v1.20 rule 5: dependency cycle rejection stays 400 DEPENDENCY_CYCLE,
 *  additive details.cyclePath: ID[]. */
export interface DependencyCycleErrorDetails { cyclePath: ID[]; }

/** Error codes introduced by the v1.19-v1.21.4 chain (existing fail() shape). */
export type ErrorCodeV2 =
  | 'DEPENDENCY_CYCLE'          // 400, + details.cyclePath (v1.20)
  | 'VERSION_CONFLICT'          // 409, CAS conflicts (v1.20.2, v1.21.4)
  | 'IDEMPOTENCY_KEY_REUSED'    // 409, same key different hash (v1.19 §17)
  | 'IDEMPOTENCY_IN_PROGRESS'   // 409 + Retry-After (v1.19 §17)
  | 'IDEMPOTENCY_CONFLICT'      // 409, conflicting body on dedupe key (v1.20.2 §26.3א)
  | 'ILLEGAL_TRANSITION'        // 409, proposal state machine (v1.21.4)
  | 'GONE';                     // 410, mutation against tombstone (v1.19 §18, PENDING FOUNDER)

export type { Role, ID, ISODateTime };
