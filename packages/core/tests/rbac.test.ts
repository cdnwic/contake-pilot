import { describe, expect, it } from 'vitest';
import {
  ALL_ACTIONS, ALL_ROLES, effectiveDecision, inScope, rawDecision, reportAutoApplies,
} from '../src/rbac/rbac.js';
import matrixJson from '../src/rbac/matrix.v1.json' with { type: 'json' };

const matrix = matrixJson as unknown as { matrix: Record<string, Record<string, string>> };

describe('RBAC matrix v1.6 (machine-readable, QA AC-RBAC-1/2)', () => {
  it('covers all 48 actions x 3 roles with explicit cells (v1.6: 45 + channel.optout + task.advance + report.correct)', () => {
    expect(ALL_ACTIONS.length).toBe(48);
    expect(ALL_ROLES).toEqual(['admin', 'field_manager', 'focus_worker']);
    for (const action of ALL_ACTIONS) {
      for (const role of ALL_ROLES) {
        expect(['allow', 'scope', 'propose', 'deny'], `${action} x ${role}`).toContain(rawDecision(action, role));
      }
    }
  });
  it('deny-by-default: unknown actions are denied for every role', () => {
    for (const role of ALL_ROLES) {
      expect(rawDecision('task.fly_to_moon', role)).toBe('deny');
      expect(rawDecision('', role)).toBe('deny');
    }
  });
  it('matrix matches the drop-in JSON cell-for-cell (spec edit without test edit fails)', () => {
    for (const [action, cells] of Object.entries(matrix.matrix)) {
      for (const [role, decision] of Object.entries(cells)) {
        expect(rawDecision(action, role as never)).toBe(decision);
      }
    }
  });
  it('autoEscalation: field_manager allow/scope at >=S1 becomes propose', () => {
    expect(effectiveDecision('task.move', 'field_manager', 'S0')).toBe('scope');
    expect(effectiveDecision('task.move', 'field_manager', 'S1')).toBe('propose');
    expect(effectiveDecision('task.move', 'field_manager', 'S2')).toBe('propose');
    expect(effectiveDecision('task.update', 'field_manager', 'S3')).toBe('propose');
  });
  it('v1.2 exemption: domino.compute dry-run never escalates to a ChangeRequest', () => {
    expect(effectiveDecision('domino.compute', 'field_manager', 'S3')).toBe('allow');
    expect(effectiveDecision('domino.compute', 'admin', 'S3')).toBe('allow');
    expect(effectiveDecision('domino.compute', 'focus_worker', 'S0')).toBe('deny');
  });
  it('R1: admin always allow, including S3 (no deadlock)', () => {
    expect(effectiveDecision('task.move', 'admin', 'S3')).toBe('allow');
    expect(effectiveDecision('domino.apply', 'admin', 'S3')).toBe('allow');
  });
  it('scope checks site membership', () => {
    const scopes = [{ eventId: 'e1', siteId: 'site-1' }];
    expect(inScope(scopes, 'e1', 'site-1')).toBe(true);
    expect(inScope(scopes, 'e1', 'site-2')).toBe(false);
    expect(inScope([{ eventId: 'e1' }], 'e1', 'site-2')).toBe(true); // event-wide scope
    expect(inScope(scopes, 'e2', 'site-1')).toBe(false);
  });
  it('reportApplyRule: own-task S0 unlocked auto-applies; nothing else does', () => {
    expect(reportAutoApplies({ isOwnTask: true, impactClass: 'S0', taskLocked: false })).toBe(true);
    expect(reportAutoApplies({ isOwnTask: true, impactClass: 'S1', taskLocked: false })).toBe(false);
    expect(reportAutoApplies({ isOwnTask: true, impactClass: 'S0', taskLocked: true })).toBe(false);
    expect(reportAutoApplies({ isOwnTask: false, impactClass: 'S0', taskLocked: false })).toBe(false);
  });
});
