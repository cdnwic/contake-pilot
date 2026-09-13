import { describe, expect, it } from 'vitest';
import { computeDomino } from '../src/domino/computeDomino.js';
import { getProfile, listProfiles, PROFILES_VERSION } from '../src/profiles/profiles.js';
import { scenarios } from './fixtures/golden-corpus.v1.1.js';

const EXPECTED_IDS = ['camp', 'event-production', 'film-shoot', 'conference', 'logistics', 'after-school'];

describe('domain profiles v1.2 (QA AC-GRAPH-3: profile neutrality)', () => {
  it('all 6 profiles load and validate', () => {
    expect(PROFILES_VERSION).toBe('1.2');
    expect(listProfiles().map(p => p.id).sort()).toEqual([...EXPECTED_IDS].sort());
  });
  it('label bijectivity: every kind and role labeled, no extras', () => {
    for (const p of listProfiles()) {
      expect(Object.keys(p.labels.resource).sort()).toEqual(['equipment', 'group', 'location', 'person']);
      expect(Object.keys(p.labels.role).sort()).toEqual(['admin', 'field_manager', 'focus_worker']);
      expect(p.notificationTemplates['digest_multi_change']).toBeTruthy();
      for (const kind of ['task_delayed', 'task_moved', 'task_cancelled', 'change_needs_approval']) {
        expect(p.notificationTemplates[kind], `${p.id} missing ${kind}`).toBeTruthy();
      }
    }
  });
  it('same engine, every profile: the flagship change yields the flagship structure', () => {
    const s = scenarios.find(x => x.id === 'G1-bus-delay-flagship')!;
    for (const id of EXPECTED_IDS) {
      const r = computeDomino(s.graph, s.change, getProfile(id));
      // 45' shift fits every profile's maxShiftMin (min is 45; limit is exclusive)
      expect(r.movedTasks.map(m => m.taskId).sort(), id).toEqual(['t1', 't2', 't3', 't4', 't5']);
      expect(r.maxImpactClass, id).toBe('S3');
    }
  });
});
