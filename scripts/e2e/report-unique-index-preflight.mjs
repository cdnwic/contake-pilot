/** Unique-index migration safety for reports.client_report_id (QA QM4 2026-09-17).
 *  Run against any EXISTING PostgreSQL database BEFORE deploy of the QM3 head:
 *    DATABASE_URL=postgres://user:pass@host:5432/db node scripts/e2e/report-unique-index-preflight.mjs
 *  1. DUPLICATE PREFLIGHT: lists any duplicate client_report_id values (with
 *     report ids) and exits 1 WITHOUT changing anything - reports are never
 *     deleted; remediation is a human adjudication per duplicate group.
 *  2. CLEAN PROOF: zero duplicates -> creates reports_client_report_id_unique
 *     if missing, then VERIFIES the unique index exists (bootstrap check).
 *  Exit 0 = clean + unique index verified. Exit 1 = duplicates (remediation
 *  required) or index creation/verification failed. */
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
const pool = new pg.Pool({ connectionString: url, max: 2 });

const dup = await pool.query(
  `SELECT client_report_id, count(*) AS n, array_agg(id ORDER BY id) AS report_ids
   FROM reports WHERE client_report_id IS NOT NULL
   GROUP BY client_report_id HAVING count(*) > 1`);
if (dup.rows.length > 0) {
  console.error(`PREFLIGHT FAIL: ${dup.rows.length} duplicate client_report_id group(s) - reports PRESERVED, adjudicate manually:`);
  for (const r of dup.rows) console.error(`  ${r.client_report_id} x${r.n}: ${r.report_ids.join(', ')}`);
  await pool.end();
  process.exit(1);
}
console.log('PREFLIGHT CLEAN: zero duplicate client_report_id values');
await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS reports_client_report_id_unique ON reports(client_report_id)');
const verify = await pool.query(
  `SELECT indexname, indexdef FROM pg_indexes
   WHERE tablename='reports' AND indexname='reports_client_report_id_unique'`);
const ok = verify.rows.length === 1 && /UNIQUE/i.test(verify.rows[0].indexdef);
console.log(ok ? 'BOOTSTRAP VERIFIED: reports_client_report_id_unique present and UNIQUE'
              : `VERIFY FAIL: ${JSON.stringify(verify.rows)}`);
await pool.end();
process.exit(ok ? 0 : 1);
