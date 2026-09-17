/** Plan 3ח: camp demo seed — structure, loadability in BOTH adapters, and the
 *  אוטובוס 3 מתאחר late-bus domino scenario on the seeded graph. */
import { describe, expect, it } from 'vitest';
import { computeDomino, getProfile, parseInstant, renderInstant } from '@contake/core';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import {
  CAMP_DEMO_EVENT_ID, CAMP_DEMO_LATE_BUS_DELAY_MIN, CAMP_DEMO_LATE_BUS_TASK_ID, CAMP_DEMO_ORG_ID, campDemoSeed,
} from '../src/demo/camp-demo.js';
import { makeTestRepoFrom } from './helpers/repo.js';

// Whitelist-PG gate: route through the helper's file-scoped PGlite lifecycle
// (reset + production bootstrap + loud afterAll close) instead of an unclosed
// fresh instance per test.
async function makeCampDemoRepo(): Promise<GraphRepository> {
  return makeTestRepoFrom(campDemoSeed());
}

describe('camp demo seed (plan 3ח)', () => {
  it('applies cleanly in the active adapter with a published event and full dataset', async () => {
    const repo = await makeCampDemoRepo();
    const ev = await repo.getEvent(CAMP_DEMO_EVENT_ID);
    expect(ev?.status).toBe('published');
    expect(ev?.name).toContain('קייטנת אורנים');
    expect((await repo.listUsers(CAMP_DEMO_ORG_ID)).length).toBe(9 + 2); // + QA staging accounts (TL 2026-09-14)
    expect((await repo.listTasks(CAMP_DEMO_EVENT_ID)).length).toBe(18);
    expect((await repo.listResources(CAMP_DEMO_EVENT_ID)).length).toBe(17);
    expect((await repo.listDependencies(CAMP_DEMO_EVENT_ID)).length).toBe(19);
    const groups = (await repo.listResources(CAMP_DEMO_EVENT_ID)).filter(r => r.resourceKind === 'group');
    expect(groups.map(g => g.name).sort()).toEqual(['כיתה דבורה', 'כיתה נמלה', 'כיתה צב'].sort());
    for (const g of groups) expect(g.subscriberChannelIds).toHaveLength(12);
  });

  it('late-bus scenario: +20min on אוטובוס 3 cascades through the morning program; lunch stays anchored', async () => {
    const repo = await makeCampDemoRepo();
    const snap = await repo.snapshot(CAMP_DEMO_EVENT_ID);
    expect(snap).toBeDefined();
    const bus3 = snap!.tasks.find(t => t.id === CAMP_DEMO_LATE_BUS_TASK_ID)!;
    expect(bus3.name).toContain('אוטובוס 3');
    const newStart = renderInstant(parseInstant(bus3.start!) + CAMP_DEMO_LATE_BUS_DELAY_MIN * 60000, snap!.event.timezone);
    const domino = computeDomino(snap!, { type: 'task.move', taskId: bus3.id, newStart }, getProfile('camp'));
    expect(domino.ok).toBe(true);
    // movedTasks includes the trigger; the 5 dependents are the flag ceremony,
    // breakfast and all three rotation-1 tasks. Slack absorbs the delay before
    // rotation 2 (09:05 end vs 10:15 start), so the cascade stops there.
    const movedIds = domino.movedTasks.map(m => m.taskId).sort();
    expect(movedIds).toEqual([
      CAMP_DEMO_LATE_BUS_TASK_ID, 'cd-t-art-c', 'cd-t-breakfast', 'cd-t-flag', 'cd-t-pool-a', 'cd-t-sport-b',
    ].sort());
    expect(domino.summaryHe).toContain('5'); // pinned: dependents only, trigger excluded
    // the flag ceremony absorbs the full +20
    const flag = domino.movedTasks.find(m => m.taskId === 'cd-t-flag')!;
    expect(flag.afterStart).toBe('2026-09-14T08:20:00+03:00');
    // locked lunch never moves and nothing is blocked behind it
    expect(movedIds).not.toContain('cd-t-lunch');
    expect(domino.blockedTaskIds).toEqual([]);
    expect(domino.conflicts.filter(c => c.blocking)).toEqual([]);
    // rotation 2 and the afternoon program are untouched: slack absorbs the delay
    for (const id of ['cd-t-sport-a', 'cd-t-art-b', 'cd-t-pool-c', 'cd-t-rest', 'cd-t-field', 'cd-t-snack', 'cd-t-back1', 'cd-t-back2', 'cd-t-back3']) {
      expect(movedIds).not.toContain(id);
    }
    // every parent group is impacted by the cascade (all three ride through the flag ceremony)
    const impactedGroups = new Set(domino.impacts.flatMap(i => i.affectedGroupIds));
    expect([...impactedGroups].sort()).toEqual(['cd-grp-a', 'cd-grp-b', 'cd-grp-c']);
  });

  it('idempotent load: applying the seed twice does not duplicate the event', async () => {
    const repo = await makeCampDemoRepo();
    const before = (await repo.listEvents(CAMP_DEMO_ORG_ID)).length;
    // loader semantics: skip when the demo event already exists
    const exists = (await repo.listEvents(CAMP_DEMO_ORG_ID)).some(e => e.id === CAMP_DEMO_EVENT_ID);
    expect(exists).toBe(true);
    if (!exists) await applySeed(repo, campDemoSeed());
    expect((await repo.listEvents(CAMP_DEMO_ORG_ID)).length).toBe(before);
  });
});
