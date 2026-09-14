/** TL 2026-09-14 staging approval: sacrificial QA event + two FM accounts.
 *  Pins the staging contract QA's probes rely on:
 *  (a) cd-rakez-all is scope='all' on cd-ev-qa (expansion listener);
 *  (b) cd-rakez-out (site-2 only) is OUT of scope for site-1 / event-level
 *      creates -> CR path (changeRequest, graph untouched);
 *  (c) the >=S1 dependency.create shape (violated edge forces a cascade);
 *  (d) ensureCampDemoStaging is additive-if-absent and idempotent. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { MemoryGraphRepository } from '../src/repo/memory.js';
import { PostgresGraphRepository, pgliteConnectable } from '../src/repo/postgres.js';
import { applySeed } from '../src/seed.js';
import {
  CAMP_DEMO_ORG_ID, CAMP_DEMO_QA_EVENT_ID, CAMP_DEMO_QA_FM_ALL_ID, CAMP_DEMO_QA_FM_OUT_ID,
  CAMP_DEMO_QA_SITE_1, CAMP_DEMO_QA_SITE_2, campDemoSeed, campDemoStagingSlice, ensureCampDemoStaging,
} from '../src/demo/camp-demo.js';
import { REPO_IMPL } from './helpers/repo.js';
import { PGlite } from '@electric-sql/pglite';

// PGlite boots are expensive: cache one repo per variant (per worker). Tests on
// the 'true' variant SHARE one graph: (c1) must run BEFORE (c2), because (c2)'s
// admin dependency.create adds the violated edge and would break (c1)'s cascade.
const repoCache = new Map<boolean, Promise<GraphRepository>>();
function makeRepo(withStaging = true): Promise<GraphRepository> {
  let p = repoCache.get(withStaging);
  if (!p) { p = makeRepoFresh(withStaging); repoCache.set(withStaging, p); }
  return p;
}
async function makeRepoFresh(withStaging = true): Promise<GraphRepository> {
  const seed = campDemoSeed();
  const data = withStaging ? seed : {
    ...seed,
    users: seed.users.filter(u => ![CAMP_DEMO_QA_FM_ALL_ID, CAMP_DEMO_QA_FM_OUT_ID].includes(u.userId)),
    events: seed.events.filter(e => e.id !== CAMP_DEMO_QA_EVENT_ID),
    resources: seed.resources.filter(r => r.eventId !== CAMP_DEMO_QA_EVENT_ID),
    tasks: seed.tasks.filter(t => t.eventId !== CAMP_DEMO_QA_EVENT_ID),
    dependencies: seed.dependencies.filter(d => !d.id.startsWith('cd-qd-')),
  };
  if (REPO_IMPL === 'postgres') {
    const repo = await PostgresGraphRepository.create(pgliteConnectable(new PGlite()));
    await applySeed(repo, data);
    return repo;
  }
  const repo = new MemoryGraphRepository();
  await applySeed(repo, data);
  return repo;
}

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });
const login = async (a: FastifyInstance, e: string, p: string) =>
  (await a.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: e, password: p } })).json().token as string;
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const IMPACT_ORDER = ['S0', 'S1', 'S2', 'S3'];

describe('QA staging slice (TL 2026-09-14)', () => {
  it('seeds the sacrificial event + both accounts with the exact approved scopes', async () => {
    const repo = await makeRepo();
    const ev = await repo.getEvent(CAMP_DEMO_QA_EVENT_ID);
    expect(ev?.siteIds).toEqual([CAMP_DEMO_QA_SITE_1, CAMP_DEMO_QA_SITE_2]);
    const all = await repo.getUser(CAMP_DEMO_QA_FM_ALL_ID);
    expect(all?.role).toBe('field_manager');
    expect(all?.scopes).toEqual([{ eventId: CAMP_DEMO_QA_EVENT_ID }]); // scope='all'
    const out = await repo.getUser(CAMP_DEMO_QA_FM_OUT_ID);
    expect(out?.scopes).toEqual([{ eventId: CAMP_DEMO_QA_EVENT_ID, siteId: CAMP_DEMO_QA_SITE_2 }]); // other site only
  });

  it('both accounts can log in', async () => {
    const repo = await makeRepo();
    app = buildApp(repo, new AuthService(repo));
    expect(await login(app, 'qa-all@oranim-camp.local', 'camp-qa-all-1')).toBeTruthy();
    expect(await login(app, 'qa-site2@oranim-camp.local', 'camp-qa-out-1')).toBeTruthy();
  });

  it("(c1) the stageable >=S1 dependency shape: move 'מפגש פתיחה QA' +30min -> cascade through the chain edges computes S1", async () => {
    const repo = await makeRepo();
    app = buildApp(repo, new AuthService(repo));
    const out = await login(app, 'qa-site2@oranim-camp.local', 'camp-qa-out-1');
    const t1 = await repo.getTask('cd-qt-1');
    const res = await app.inject({
      method: 'PATCH', url: '/v1/tasks/cd-qt-1', headers: H(out),
      payload: { version: t1!.version, move: { newStart: '2026-09-15T09:30:00+03:00' } },
    });
    expect(res.statusCode).toBe(200);
    const cr = res.json().changeRequest;
    expect(cr, `expected CR path, got: ${res.body}`).toBeTruthy();
    expect(IMPACT_ORDER.indexOf(cr.dominoResult.maxImpactClass as string)).toBeGreaterThanOrEqual(1);
    // the cascade moves both downstream tasks through cd-qd-1/cd-qd-2
    const moved = (cr.dominoResult.movedTasks as { taskId: string }[]).map(m => m.taskId);
    expect(moved).toContain('cd-qt-2');
    expect(moved).toContain('cd-qt-3');
  });

  it("(c2) the dependency.create CR row (S0 by design): from 'פעילות QA ב' to 'מפגש פתיחה QA', lagMin 180, hard", async () => {
    const repo = await makeRepo();
    app = buildApp(repo, new AuthService(repo));
    const admin = await login(app, 'dana@oranim-camp.local', 'camp-admin-1');

    // out-of-scope FM -> CR path, impact >= S1
    const out = await login(app, 'qa-site2@oranim-camp.local', 'camp-qa-out-1');
    const res = await app.inject({
      method: 'POST', url: `/v1/events/${CAMP_DEMO_QA_EVENT_ID}/dependencies`, headers: H(out),
      payload: { fromTaskId: 'cd-qt-3', toTaskId: 'cd-qt-1', lagMin: 180, hard: true },
    });
    expect(res.statusCode).toBe(200);
    const cr = res.json().changeRequest;
    expect(cr, `expected CR path, got: ${res.body}`).toBeTruthy();
    // dependency.create is zeroResult BY DESIGN (computeDomino): adding a
    // constraint never moves tasks, so it always classifies S0 - the >=S1
    // dependency stage is the two-step shape proven in the next test.
    expect(cr.dominoResult.maxImpactClass).toBe('S0');
    // graph untouched while pending
    expect((await repo.listDependencies(CAMP_DEMO_QA_EVENT_ID)).length).toBe(2);

    // admin direct -> the shape is non-blocking (domino resolves it with moves)
    const res2 = await app.inject({
      method: 'POST', url: `/v1/events/${CAMP_DEMO_QA_EVENT_ID}/dependencies`, headers: H(admin),
      payload: { fromTaskId: 'cd-qt-3', toTaskId: 'cd-qt-1', lagMin: 180, hard: true },
    });
    expect(res2.statusCode, `admin create should apply, got: ${res2.body}`).toBe(200);
    expect((await repo.listDependencies(CAMP_DEMO_QA_EVENT_ID)).length).toBe(3);
  });

  it('(d) ensureCampDemoStaging is additive-if-absent and idempotent', async () => {
    const repo = await makeRepo(false); // base dataset only, no staging
    expect(await repo.getEvent(CAMP_DEMO_QA_EVENT_ID)).toBeUndefined();
    await ensureCampDemoStaging(repo);
    expect(await repo.getEvent(CAMP_DEMO_QA_EVENT_ID)).toBeTruthy();
    expect(await repo.getUser(CAMP_DEMO_QA_FM_ALL_ID)).toBeTruthy();
    expect((await repo.listTasks(CAMP_DEMO_QA_EVENT_ID)).length).toBe(4);
    const usersAfterFirst = (await repo.listUsers(CAMP_DEMO_ORG_ID)).length;
    await ensureCampDemoStaging(repo); // second run: no-op
    expect((await repo.listUsers(CAMP_DEMO_ORG_ID)).length).toBe(usersAfterFirst);
    // cd-ev1 untouched
    expect((await repo.listTasks('cd-ev1')).length).toBe(18);
  });
});
