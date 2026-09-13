// Wiring between the QA-generated RBAC suite and the enforcement stack
// (@contake/core rbac module — the same functions the API hooks call).
import type { ImpactClass, Role } from '@contake/core';
import { ALL_ACTIONS, effectiveDecision, reportAutoApplies } from '@contake/core';

type AdapterDecision = 'allow' | 'propose' | 'deny';

export async function authorize(
  principal: { role: Role },
  action: string,
  context: { impactClass: ImpactClass },
): Promise<AdapterDecision> {
  if (!ALL_ACTIONS.includes(action)) {
    const err = new Error('unknown action') as Error & { statusCode: number };
    err.statusCode = 403;
    throw err;
  }
  const d = effectiveDecision(action, principal.role, context.impactClass);
  // 'scope' resolves to allow at this layer; the ScopeHook site-membership check
  // is exercised separately in the API e2e suite (docs/qa-isolation-sweep.md ISO-2).
  return d === 'scope' ? 'allow' : d;
}

type ReportOutcome = 'auto-apply' | 'pending_review' | 'deny';

export async function reportDecision(
  _principal: { role: Role },
  c: { impactClass: ImpactClass; locked: boolean; own: boolean },
): Promise<ReportOutcome> {
  if (!c.own) return 'deny'; // never a back-door task.move on another's task
  return reportAutoApplies({ isOwnTask: c.own, impactClass: c.impactClass, taskLocked: c.locked })
    ? 'auto-apply'
    : 'pending_review';
}
