/** Standalone camp-demo loader (plan 3ח). Usage:
 *    pnpm --filter @contake/api exec tsx src/demo/load-camp-demo.ts [--impl memory|postgres]
 *  --impl postgres uses DATABASE_URL when set, otherwise a local PGlite instance
 *  (PGDATA env or a temp dir). Idempotent: skips when the demo org already has
 *  events. The normal server path (CONTAKE_SEED=camp-demo) seeds an empty PG
 *  database the same way on boot. */
import { MemoryGraphRepository } from '../repo/memory.js';
import { PostgresGraphRepository, pgliteConnectable } from '../repo/postgres.js';
import type { GraphRepository } from '../repo/graph-repository.js';
import { applySeed } from '../seed.js';
import { CAMP_DEMO_EVENT_ID, CAMP_DEMO_LATE_BUS_TASK_ID, CAMP_DEMO_ORG_ID, campDemoSeed } from './camp-demo.js';

const impl = process.argv.includes('--impl')
  ? process.argv[process.argv.indexOf('--impl') + 1]
  : 'memory';

let repo: GraphRepository;
let close: () => Promise<void> = async () => {};
if (impl === 'postgres') {
  if (process.env['DATABASE_URL']) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
    repo = await PostgresGraphRepository.create(pool);
    close = () => pool.end();
    console.log('camp-demo: Postgres via DATABASE_URL');
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dataDir = process.env['PGDATA'];
    const db = dataDir ? new PGlite(dataDir) : new PGlite();
    repo = await PostgresGraphRepository.create(pgliteConnectable(db));
    close = () => db.close();
    console.log(`camp-demo: Postgres via PGlite (${dataDir ?? 'in-memory'})`);
  }
} else if (impl === 'memory') {
  repo = new MemoryGraphRepository();
  console.log('camp-demo: in-memory repository');
} else {
  console.error(`unknown --impl '${impl}' (expected memory|postgres)`);
  process.exit(2);
}

const seed = campDemoSeed();
const existing = await repo.listEvents(CAMP_DEMO_ORG_ID);
if (existing.some(e => e.id === CAMP_DEMO_EVENT_ID)) {
  console.log(`camp-demo: event ${CAMP_DEMO_EVENT_ID} already present — nothing to do`);
} else {
  await applySeed(repo, seed);
  console.log(`camp-demo: applied — ${seed.users.length} users, ${seed.channels.length} channels, ${seed.events.length} events, ${seed.resources.length} resources, ${seed.tasks.length} tasks, ${seed.dependencies.length} dependencies`);
}
const snap = await repo.snapshot(CAMP_DEMO_EVENT_ID);
console.log(`camp-demo: event '${snap?.event.name}' status=${snap?.event.status} date=${snap?.event.date}; late-bus task ${CAMP_DEMO_LATE_BUS_TASK_ID} = '${snap?.tasks.find(t => t.id === CAMP_DEMO_LATE_BUS_TASK_ID)?.name}'`);
console.log('camp-demo: logins — admin dana@oranim-camp.local / camp-admin-1; OTP devCode returned while CONTAKE_DEV_OTP is not false');
await close();
