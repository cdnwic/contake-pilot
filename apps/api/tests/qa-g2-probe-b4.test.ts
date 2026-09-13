import { expect, it } from 'vitest';
import { MemoryGraphRepository } from '../src/repo/memory.js';
import { seedDemo } from '../src/seed.js';
import { buildJobsForAppliedChange } from '../src/services/notify.js';
import { getProfile } from '@contake/core';

it('PROBE-B4: same change at 23:55 — staff immediate, parents held to 07:00', async () => {
  const repo = MemoryGraphRepository.seeded(seedDemo());
  const snapshot = (await repo.snapshot('e1'))!;
  const domino = {
    ok: true, movedTasks: [{ taskId: 't1', beforeStart: '2026-09-14T08:00:00+03:00', afterStart: '2026-09-14T08:15:00+03:00' }],
    blockedTaskIds: [],
    impacts: [{ taskId: 't1', beforeStart: '2026-09-14T08:00:00+03:00', afterStart: '2026-09-14T08:15:00+03:00', affectedResourceIds: ['r-g1'], affectedGroupIds: ['r-grp'], impactClass: 'S2' as const }],
    conflicts: [], maxImpactClass: 'S2' as const, summaryHe: 'x',
  };
  const jobs = await buildJobsForAppliedChange({ repo, snapshot, domino, profile: getProfile('camp'), changeRequestId: 'cr-b4', changeSummaryHe: 'x', now: () => Date.parse('2026-09-13T23:55:00+03:00') });
  const staffJob = jobs.find(j => j.targets.some(t => t.address.startsWith('+9725000000')));
  const parentJob = jobs.find(j => j.targets.some(t => t.address.startsWith('+972521')));
  console.log('B4 jobs:', jobs.length, 'staffJob hold:', staffJob?.holdUntil, 'parentJob hold:', parentJob?.holdUntil, 'parents:', parentJob?.targets.length);
  expect(staffJob?.holdUntil).toBeUndefined();
  expect(parentJob?.holdUntil).toBeDefined();
  expect(parentJob!.holdUntil!).toContain('07:00');
});
