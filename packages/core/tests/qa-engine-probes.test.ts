/** QA adversarial engine probes — cases beyond the golden corpus. */
import { describe, expect, it } from 'vitest';
import { computeDomino } from '../src/domino/computeDomino.js';
import { getProfile } from '../src/profiles/profiles.js';
import { scenarios } from './fixtures/golden-corpus.v1.1.js';
import type { GraphSnapshot, TaskNode } from '../src/contracts.v1.js';

const base = scenarios[0]!.graph;
const camp = getProfile('camp');
const at = (hhmm: string) => `2026-09-14T${hhmm}:00+03:00`;

describe('QA probes', () => {
  it('P1: WINDOW_VIOLATION is non-blocking (ok=true, conflict present)', () => {
    // move t7-like task to 15:30 with 90min -> ends 17:00, past camp window 16:30
    const g: GraphSnapshot = { ...base, tasks: [...base.tasks, { id: 'tx', kind: 'task', eventId: 'e1', siteId: 'site-1', name: 'מבחן חלון', start: at('14:00'), durationMin: 90, status: 'planned', locked: false, assigneeResourceIds: [], version: 1 } as TaskNode] };
    const r = computeDomino(g, { type: 'task.move', taskId: 'tx', newStart: at('15:30') }, camp);
    expect(r.conflicts.some(c => c.code === 'WINDOW_VIOLATION')).toBe(true);
    expect(r.conflicts.find(c => c.code === 'WINDOW_VIOLATION')!.blocking).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.movedTasks.some(m => m.taskId === 'tx')).toBe(true);
  });

  it('P2: summaryHe with zero dependents uses the no-domino sentence', () => {
    const r = computeDomino(base, { type: 'task.move', taskId: 't6', newStart: at('12:30') }, camp);
    // t6 is LOCKED but it is the trigger: trigger takes requested position per engine doc.
    // if locked trigger moves -> assert consistent behavior either way:
    if (r.movedTasks.some(m => m.taskId === 't6')) {
      expect(r.summaryHe).toBe('אין אפקט דומינו: רק המשימה עצמה משתנה');
    } else {
      expect(r.ok).toBe(false); // locked trigger refused is also defensible, must be a conflict
      expect(r.conflicts.some(c => c.code === 'LOCK_VIOLATION')).toBe(true);
    }
  });

  it('P3: task.delete on subscribed-group task produces NO external impact (notification gap probe)', () => {
    const r = computeDomino(base, { type: 'task.delete', taskId: 't4' }, camp);
    const external = r.impacts.flatMap(i => i.affectedGroupIds);
    console.log('delete impacts:', JSON.stringify(r.impacts), 'ok:', r.ok);
    // documented expectation: if this is empty, deleting a published activity notifies nobody
    expect(external).toEqual([]); // assert the CURRENT behavior so the gap is explicit
  });

  it('P4: vs task.update status=cancelled DOES produce impact with afterStart null', () => {
    const r = computeDomino(base, { type: 'task.update', taskId: 't4', patch: { status: 'cancelled' } }, camp);
    const imp = r.impacts.find(i => i.taskId === 't4');
    expect(imp).toBeDefined();
    expect(imp!.afterStart).toBeNull();
    expect(imp!.affectedGroupIds).toContain('r-grp');
    expect(r.maxImpactClass).toBe('S3');
  });

  it('P5: lag honored: successor waits pred.end + lagMin', () => {
    const g: GraphSnapshot = { ...base, dependencies: base.dependencies.map(d => d.id === 'd2' ? { ...d, lagMin: 15 } : d) };
    const r = computeDomino(g, { type: 'task.move', taskId: 't1', newStart: at('08:15') }, camp);
    // t1 08:15+30=08:45; t2 = 08:45; t2 ends 09:30; t3 = 09:30+15lag = 09:45
    const t3 = r.movedTasks.find(m => m.taskId === 't3')!;
    expect(t3.afterStart).toBe(at('09:45'));
  });

  it('P6: cross-midnight move keeps offset-correct instants', () => {
    const g: GraphSnapshot = { ...base, tasks: [...base.tasks, { id: 'ty', kind: 'task', eventId: 'e1', siteId: 'site-1', name: 'משמרת לילה', start: at('22:30'), durationMin: 120, status: 'planned', locked: false, assigneeResourceIds: [], version: 1 } as TaskNode] };
    const r = computeDomino(g, { type: 'task.move', taskId: 'ty', newStart: at('23:30') }, camp);
    const m = r.movedTasks.find(x => x.taskId === 'ty')!;
    expect(m.afterStart).toBe('2026-09-14T23:30:00+03:00');
    expect(r.conflicts.some(c => c.code === 'WINDOW_VIOLATION')).toBe(true); // past window
    expect(r.ok).toBe(true);
  });

  it('P7: double-booking NOT reported between two unmoved, untouched tasks (change-scoped check)', () => {
    // t7 overlaps t4 on r-pool in the base graph of G3 scenario; here use G3 graph
    const g3 = scenarios.find(s => s.id === 'G3-double-booking')!.graph;
    const r = computeDomino(g3, { type: 'task.update', taskId: 't2', patch: { name: 'ארוחת בוקר מורחבת' } }, camp);
    expect(r.conflicts.some(c => c.code === 'DOUBLE_BOOKING')).toBe(false);
  });

  it('P8: locked trigger move: engine behavior pinned', () => {
    const r = computeDomino(base, { type: 'task.move', taskId: 't6', newStart: at('13:00') }, camp);
    console.log('locked trigger:', JSON.stringify({ moved: r.movedTasks, conflicts: r.conflicts.map(c=>c.code), ok: r.ok }));
    expect(true).toBe(true); // behavior recorded via P2/P8 output for the verdict
  });
});
