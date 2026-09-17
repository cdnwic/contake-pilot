/** Real-PostgreSQL concurrent-duplicate probe for the reports
 *  client_report_id durable unique constraint (QA QM3 2026-09-17).
 *  PGlite is single-connection and CANNOT prove this; run against real PG:
 *    DATABASE_URL=postgres://user:pass@host:5432/db node scripts/e2e/report-create-concurrency.mjs
 *  Expects: N parallel createReport calls with the same clientReportId on TWO
 *  independent connections -> exactly 1 success, N-1 ReportClientIdConflictError,
 *  exactly 1 stored row. Prints PROBE PASS/FAIL + counts; exit code 0/1. */
import { PostgresGraphRepository } from '../../apps/api/dist/repo/postgres.js';
import pg from 'pg';

const N = 8;
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

const mk = async () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const conn = { query: (text, params) => pool.query(text, params) };
  const repo = await PostgresGraphRepository.create(conn);
  return { pool, repo };
};

const probeId = `conc-${Date.now()}`;
const a = await mk();
const b = await mk();
const mkReport = (i) => ({
  id: `${probeId}-r${i}`, clientReportId: probeId, taskId: 'probe-task',
  reportedBy: 'probe-user', status: 'blocked', clientTimestamp: new Date().toISOString(),
  createdAt: new Date().toISOString(),
});
const results = await Promise.allSettled(
  Array.from({ length: N }, (_, i) => (i % 2 === 0 ? a.repo : b.repo).createReport(mkReport(i))),
);
const ok = results.filter(r => r.status === 'fulfilled').length;
const conflicts = results.filter(r => r.status === 'rejected' && r.reason?.name === 'ReportClientIdConflictError').length;
const other = results.filter(r => r.status === 'rejected' && r.reason?.name !== 'ReportClientIdConflictError');
const stored = await a.repo.getReportByClientId(probeId);
const pass = ok === 1 && conflicts === N - 1 && other.length === 0 && stored !== undefined;
console.log(`PROBE ${pass ? 'PASS' : 'FAIL'} ok=${ok} conflicts=${conflicts} other=${other.length} stored=${stored ? 1 : 0}`);
for (const o of other) console.error('unexpected error:', o.reason);
await a.pool.end(); await b.pool.end();
process.exit(pass ? 0 : 1);
