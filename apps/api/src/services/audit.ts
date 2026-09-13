import type { Action, AuditEntityType, AuditLogEntry, ID, Role } from '@contake/core';

/** contracts v1.9: metadata attached to an ApiError at a mutating-endpoint authz
 *  deny site; the central error handler turns it into a standalone denied row.
 *  Attached ONLY at mutating deny sites, so reads, the domino.compute dry-run and
 *  401s are excluded by construction. eventId is the target event when
 *  determinable, else the established 'pending' sentinel (RT-PIN-1 precedent). */
export interface DenialMeta {
  reason: 'matrix_deny' | 'scope_violation';
  action: Action;
  entityType: AuditEntityType;
  entityId: ID;
  eventId: ID;
}
import type { GraphRepository } from '../repo/graph-repository.js';

let seq = 0;

/** Every mutation flows through here (QA AC-AUD-1): actor, role, action,
 *  before/after, ChangeRequest linkage, timestamp, device class. */
export async function audit(
  repo: GraphRepository,
  entry: {
    orgId: ID;
    eventId: ID;
    actorUserId: ID;
    role: Role;
    action: Action;
    entityType: AuditEntityType;
    entityId: ID;
    before?: unknown;
    after?: unknown;
    changeRequestId?: ID;
    deviceClass?: string;
  },
): Promise<void> {
  seq += 1;
  const record: AuditLogEntry = {
    id: `aud_${Date.now().toString(36)}_${seq}`,
    orgId: entry.orgId,
    eventId: entry.eventId,
    actorUserId: entry.actorUserId,
    role: entry.role,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    beforeJson: entry.before === undefined ? null : JSON.stringify(entry.before),
    afterJson: entry.after === undefined ? null : JSON.stringify(entry.after),
    ...(entry.changeRequestId ? { changeRequestId: entry.changeRequestId } : {}),
    ...(entry.deviceClass ? { deviceClass: entry.deviceClass } : {}),
    createdAt: new Date().toISOString(),
  };
  await repo.appendAudit(record);
}

/** contracts v1.9: every mutating-endpoint attempt that passes authentication but
 *  fails authorization appends a denied row (null before/afterJson). Standalone -
 *  no mutation tx exists - and NEVER throws: if the append fails the denial still
 *  stands and the failure is logged server-side. A broken audit store never
 *  upgrades a denial. Success-path audits stay tx-atomic per QA-M2-6. */
export async function auditDenied(
  repo: GraphRepository,
  actor: { orgId: ID; actorUserId: ID; role: Role; deviceClass?: string },
  denial: DenialMeta,
): Promise<void> {
  try {
    seq += 1;
    const record: AuditLogEntry = {
      id: `aud_${Date.now().toString(36)}_${seq}`,
      orgId: actor.orgId,
      eventId: denial.eventId,
      actorUserId: actor.actorUserId,
      role: actor.role,
      action: denial.action,
      entityType: denial.entityType,
      entityId: denial.entityId,
      beforeJson: null,
      afterJson: null,
      outcome: 'denied',
      denialReason: denial.reason,
      ...(actor.deviceClass ? { deviceClass: actor.deviceClass } : {}),
      createdAt: new Date().toISOString(),
    };
    await repo.appendAudit(record);
  } catch (err) {
    console.error('[audit] denied-attempt append failed - the denial stands', err);
  }
}

export const deviceClassOf = (userAgent: string | undefined): string =>
  userAgent !== undefined && /mobile|android|iphone/i.test(userAgent) ? 'mobile' : 'desktop';
