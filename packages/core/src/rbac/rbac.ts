import type { Action, ImpactClass, Role, Scope } from '../contracts.v1.js';
import matrixJson from './matrix.v1.json' with { type: 'json' };

/**
 * RBAC decisions driven by the machine-readable matrix (drop-in, tech-lead owned).
 * Deny by default: any action x role combination not listed is denied, including
 * unknown actions (matrix denyByDefault, QA AC-RBAC-2).
 */

export type Decision = 'allow' | 'scope' | 'propose' | 'deny';

interface MatrixFile {
  version: string;
  roles: Role[];
  matrix: Record<string, Record<string, Decision>>;
}

const MATRIX = matrixJson as unknown as MatrixFile;

export const RBAC_MATRIX_VERSION: string = MATRIX.version;

export function rawDecision(action: Action | string, role: Role): Decision {
  const cell = MATRIX.matrix[action]?.[role];
  return cell ?? 'deny';
}

const CLASS_GE: Record<ImpactClass, number> = { S0: 0, S1: 1, S2: 2, S3: 3 };

/**
 * Apply authority = base cell x autoEscalation (matrix v1.1, R1 resolved):
 * - field_manager: computed impact >= S1 routes through ChangeRequest.
 * - admin: always allow, including S3 (מנהל-על שליטה מלאה).
 * - focus_worker: no escalation path (reportApplyRule governs reports instead).
 */
export function effectiveDecision(action: Action | string, role: Role, impactClass: ImpactClass): Decision {
  const base = rawDecision(action, role);
  if (base !== 'allow' && base !== 'scope') return base;
  // Matrix v1.2 exemption: domino.compute is a read-only dry-run preview. It never
  // mutates and NEVER creates a ChangeRequest, whatever class it computes.
  if (action === 'domino.compute') return base;
  if (role === 'field_manager' && CLASS_GE[impactClass] >= CLASS_GE.S1) return 'propose';
  return base;
}

/**
 * reportApplyRule (matrix v1.1, QA C2): a focus worker's delay report auto-applies
 * only when it is their own task, computed impact is S0 and the task is unlocked.
 * Anything above S0 or a locked task becomes a pending_review ChangeRequest.
 * A report is never a back-door task.move.
 */
export function reportAutoApplies(input: {
  isOwnTask: boolean;
  impactClass: ImpactClass;
  taskLocked: boolean;
}): boolean {
  return input.isOwnTask && !input.taskLocked && input.impactClass === 'S0';
}

/** Site-scope check for 'scope' decisions: the target site must be in the principal's scopes. */
export function inScope(scopes: Scope[], eventId: string, siteId: string | undefined): boolean {
  return scopes.some(s => s.eventId === eventId && (s.siteId === undefined || s.siteId === siteId));
}

/** All 22 actions, for matrix-coverage tests. */
export const ALL_ACTIONS: string[] = Object.keys(MATRIX.matrix);
export const ALL_ROLES: Role[] = MATRIX.roles;
