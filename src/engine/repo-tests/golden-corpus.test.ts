import { describe, expect, it } from 'vitest';
import { computeDomino } from '../computeDomino';
import { getProfile } from '../../profiles/profiles';
import { assertScenario, scenarios } from './fixtures/golden-corpus.v1.1';
import type { GraphSnapshot, TaskNode } from '../../contracts/contake-core-contracts.v1.1';

/** QA golden corpus v1.1 — the executable acceptance standard for computeDomino.
 *  Fixtures are QA-owned; a failure here is a Sev-1 class bug, never a fixture edit. */
describe('QA golden domino corpus v1.1', () => {
  for (const s of scenarios) {
    it(`${s.id}: ${s.title}`, () => {
      const result = computeDomino(s.graph, s.change, getProfile(s.profileId));
      const errs = assertScenario(result, s);
      expect(errs, errs.join('\n')).toEqual([]);
    });
  }

  it('G6 determinism: 50 shuffled runs -> byte-identical canonical output', () => {
    const s = scenarios.find(x => x.id === 'G6-determinism')!;
    const profile = getProfile(s.profileId);
    const canonical = (g: GraphSnapshot): string =>
      JSON.stringify(computeDomino(g, s.change, profile));
    const base = canonical(s.graph);
    let seed = 42;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let run = 0; run < 50; run++) {
      const shuffle = <T,>(arr: T[]): T[] => {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [a[i], a[j]] = [a[j]!, a[i]!];
        }
        return a;
      };
      const g: GraphSnapshot = {
        ...s.graph,
        tasks: shuffle(s.graph.tasks),
        resources: shuffle(s.graph.resources),
        dependencies: shuffle(s.graph.dependencies),
      };
      expect(canonical(g)).toBe(base);
    }
  });

  it('perf: 20-task chain computes in < 50ms (domino spec scenario 6)', () => {
    const base = scenarios[0]!.graph;
    const tasks: TaskNode[] = Array.from({ length: 20 }, (_, i) => ({
      id: `c${i}`, kind: 'task', eventId: 'e1', siteId: 'site-1',
      name: `task-${i}`, start: `2026-09-14T08:${String(i).padStart(2, '0')}:00+03:00`,
      durationMin: 1, status: 'planned', locked: false, assigneeResourceIds: [], version: 1,
    }));
    const deps = tasks.slice(1).map((t, i) => ({
      id: `cd${i}`, kind: 'depends_on' as const, fromTaskId: t.id, toTaskId: tasks[i]!.id, lagMin: 0, hard: true,
    }));
    const g: GraphSnapshot = { ...base, tasks, dependencies: deps };
    const t0 = performance.now();
    const r = computeDomino(g, { type: 'task.move', taskId: 'c0', newStart: '2026-09-14T09:00:00+03:00' }, getProfile('camp'));
    const ms = performance.now() - t0;
    expect(r.movedTasks.length).toBe(20);
    expect(ms).toBeLessThan(50);
  });
});
