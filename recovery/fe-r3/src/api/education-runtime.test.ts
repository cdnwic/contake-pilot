import { describe, it, expect } from 'vitest';
import { PROFILES, SEEDERS } from './seed';
import * as mockApi from './mockApi';
import { assertAcyclic } from '../engine/graph/dag';
import { getProfile } from '../profiles/profiles';

// QA correction 2 (2026-09-17): the canonical 7-profile parity layer must be wired into
// actual runtime selection, with education exercised end-to-end through the mock API,
// while the recovered 6-profile snapshot stays preserved untouched (profiles-parity.test).
describe('education vertical — canonical parity layer wired into runtime selection', () => {
  it('runtime profile list is the canonical 7 including education', async () => {
    expect(PROFILES).toHaveLength(7);
    expect(PROFILES.map((p) => p.id)).toContain('education');
    const fromApi = await mockApi.getProfiles();
    expect(fromApi.map((p) => p.id)).toEqual(PROFILES.map((p) => p.id));
  });

  it('education seed builds a valid acyclic day graph in canonical school vocabulary', () => {
    const g = SEEDERS.education!();
    expect(g.event.domainProfileId).toBe('education');
    expect(() => assertAcyclic(g.dependencies, (id) => g.tasks.find((t) => t.id === id)?.name ?? id)).not.toThrow();
    const resIds = new Set(g.resources.map((r) => r.id));
    for (const t of g.tasks) for (const rid of t.assigneeResourceIds) expect(resIds.has(rid)).toBe(true);
    const profile = getProfile('education');
    expect(profile.displayNameHe).toBe('בית ספר');
    expect(profile.labels.task).toBe('שיעור');
    expect(profile.labels.resource.person).toBe('מורה');
    expect(profile.labels.resource.group).toBe('כיתה');
  });

  it('education runs end-to-end through the mock runtime: state, roles, report, domino', async () => {
    mockApi.resetState('education');
    const fm = mockApi.principalFor('education', 'field_manager');
    const state = await mockApi.getClientState('education', 'field_manager');
    expect(state.profile.id).toBe('education');
    expect(state.profile.displayNameHe).toBe('בית ספר');
    expect(state.graph.tasks).toHaveLength(5);

    const res = await mockApi.submitReport('education', {
      taskId: 's1', status: 'delayed', delayMin: 30, noteHe: 'מורה מאחרת', clientReportId: 'test-edu-rep-1',
    }, fm);
    expect(res.duplicate).toBe(false);
    expect(res.domino).not.toBeNull();
    const moved = res.domino!.impacts.filter((i) => i.beforeStart !== i.afterStart).map((i) => i.taskId);
    expect(moved).toContain('s2'); // downstream math lesson on same teacher+room must move
    expect(moved).not.toContain('s5'); // locked lesson never moves

    const again = await mockApi.submitReport('education', {
      taskId: 's1', status: 'delayed', delayMin: 30, clientReportId: 'test-edu-rep-1',
    }, fm);
    expect(again.duplicate).toBe(true); // AC-FR-2 exactly-once on clientReportId
  });
});
