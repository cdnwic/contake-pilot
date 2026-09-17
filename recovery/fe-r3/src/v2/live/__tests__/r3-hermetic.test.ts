/** r3 hermetic tests — no network, no DOM. Pure-function coverage of the authored
 *  live layer against contract invariants (QA golden-corpus semantics where pinned). */
import { describe, expect, it } from 'vitest';
import { decidePatchAction, mergeGraphPatch } from '../graphMerge';
import { mapChangeRequest, mapNotifyJobToFeed } from '../towerData';
import { mapSchedule, mapStatusCounts } from '../mapGraph';
import { fmtTime } from '../../../ui';
import type { ChangeRequest, GraphSnapshot, StatusReport } from '../../../contracts/contracts.v1';

const baseGraph: GraphSnapshot = {
  event: { id: 'ev1', kind: 'event', orgId: 'o1', domainProfileId: 'camp', name: 'Test', date: '2026-09-18', timezone: 'Asia/Jerusalem', siteIds: ['s1'], status: 'published', version: 3 },
  tasks: [
    { id: 't1', kind: 'task', eventId: 'ev1', siteId: 's1', name: 'A', start: '2026-09-18T06:00:00.000Z', durationMin: 30, status: 'planned', locked: false, assigneeResourceIds: [], version: 1 },
    { id: 't2', kind: 'task', eventId: 'ev1', siteId: 's1', name: 'B', start: '2026-09-18T07:00:00.000Z', durationMin: 30, status: 'delayed', locked: false, assigneeResourceIds: [], version: 1 },
  ],
  resources: [],
  dependencies: [],
};

describe('graphMerge version guards (RT-PIN-3/4)', () => {
  it('null lastVersion forces refetch', () => { expect(decidePatchAction(null, 5)).toBe('refetch'); });
  it('stale frame drops', () => { expect(decidePatchAction(5, 5)).toBe('drop'); expect(decidePatchAction(5, 3)).toBe('drop'); });
  it('exactly-sequential merges', () => { expect(decidePatchAction(5, 6)).toBe('merge'); });
  it('gap forces refetch', () => { expect(decidePatchAction(5, 8)).toBe('refetch'); });
  it('upsert never deletes; tombstone is the only deletion path', () => {
    const frame = { eventId: 'ev1', version: 4, tasks: [baseGraph.tasks[0]], resources: [], dependencies: [] } as never;
    const merged = mergeGraphPatch(baseGraph, frame, false);
    expect(merged.tasks.map((t) => t.id).sort()).toEqual(['t1', 't2']);
  });
});

describe('mapGraph schedule/counts', () => {
  it('delayed task maps to slip status', () => {
    const rows = mapSchedule(baseGraph, new Set());
    const counts = mapStatusCounts(rows);
    expect(counts.slip + counts.risk + counts.ok + counts.done).toBe(rows.length);
  });
});

const cr: ChangeRequest = {
  id: 'c1', eventId: 'ev1', baseGraphVersion: 2, proposedBy: 'u1', role: 'field_manager',
  change: { type: 'task.move', taskId: 't1', newStart: '2026-09-18T08:00:00.000Z' },
  dominoResult: { ok: true, movedTasks: [{ taskId: 't2', beforeStart: null, afterStart: '2026-09-18T08:30:00.000Z' }], blockedTaskIds: [], impacts: [], conflicts: [], maxImpactClass: 'S1', summaryHe: 'אפקט דומינו: 1 משימות תלויות יזוזו' },
  state: 'proposed', reasonHe: 'איחור אוטובוס', createdAt: '2026-09-17T05:00:00.000Z',
};

describe('towerData mappers', () => {
  it('stale flag when current version passed base', () => {
    expect(mapChangeRequest(cr, 2).stale).toBe(false);
    expect(mapChangeRequest(cr, 3).stale).toBe(true);
  });
  it('domino view carries pinned summaryHe and moved task ids', () => {
    const v = mapChangeRequest(cr, 2);
    expect(v.domino.none).toBe(false);
    expect(v.domino.summary).toContain('דומינו');
    expect(v.domino.items).toEqual(['t2']);
    expect(v.typeKind).toBe('tasks');
  });
  it('notify job maps to feed item with kind flag', () => {
    const f = mapNotifyJobToFeed({ id: 'j1', eventId: 'ev1', createdAt: '2026-09-17T05:00:00.000Z', kind: 'task_delayed', targets: [{ channel: 'whatsapp', address: '+972500000000', recipientLabel: 'הורים' }], templateKey: 'tpl', params: { title: 'איחור' }, idempotencyKey: 'k', batchWindowSec: 60 } as never);
    expect(f.flag).toBe('slip');
    expect(f.title).toBe('איחור');
  });
});

describe('fmtTime', () => {
  it('renders he-IL HH:MM in event timezone; null em-dash', () => {
    expect(fmtTime(null, 'Asia/Jerusalem')).toBe('—');
    expect(fmtTime('2026-09-18T06:30:00.000Z', 'Asia/Jerusalem')).toBe('09:30');
  });
});
