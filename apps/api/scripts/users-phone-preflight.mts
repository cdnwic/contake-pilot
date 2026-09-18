#!/usr/bin/env node
/** READ-ONLY users-phone preflight (SA1 ruling 2026-09-19, attended-TOFU
 *  companion to migrations 0002/0003). Runs FIRST at attended TOFU; its
 *  inconsistency list is recorded in the run evidence and the operator must
 *  explicitly acknowledge listDigest before the migration executes.
 *  - NEVER mutates: the session is forced default_transaction_read_only=on
 *    and only SELECTs are issued; no winner is picked, nothing is deleted.
 *  - Resolved-DB-only: REQUIRES an explicit --database-url (no ambient env).
 *  Usage: npx tsx scripts/users-phone-preflight.mts --database-url postgres://...
 *  Exit 0 always; operatorDecisionRequired flags what needs human judgment. */
import { Pool } from 'pg';
import { createHash } from 'node:crypto';

const url = process.argv.find((a, i) => i > 0 && process.argv[i - 1] === '--database-url');
if (!url) {
  console.error('FATAL: explicit --database-url is required (resolved-DB-only; no default, no ambient env).');
  process.exit(64);
}
const pool = new Pool({ connectionString: url, options: '-c default_transaction_read_only=on' });
const NORM = `NULLIF(pg_catalog.btrim(phone), '')`;
const JNORM = `NULLIF(pg_catalog.btrim(data->>'phone'), '')`;
try {
  const collisions = await pool.query(
    `SELECT ${NORM} AS norm_phone, jsonb_agg(jsonb_build_object('userId', user_id, 'orgId', org_id) ORDER BY user_id) AS users
     FROM users WHERE ${NORM} IS NOT NULL GROUP BY ${NORM} HAVING count(*) > 1 ORDER BY 1`);
  const inconsistencies = await pool.query(
    `SELECT user_id AS "userId", org_id AS "orgId", ${NORM} AS "columnPhone", ${JNORM} AS "jsonPhone"
     FROM users WHERE ${NORM} IS NOT NULL AND ${JNORM} IS NOT NULL AND ${NORM} <> ${JNORM} ORDER BY user_id`);
  const blanks = await pool.query(
    `SELECT user_id AS "userId", org_id AS "orgId" FROM users
     WHERE phone IS NOT NULL AND ${NORM} IS NULL ORDER BY user_id`);
  const report = {
    tool: 'users-phone-preflight', readOnly: true, generatedAt: new Date().toISOString(),
    collisionGroups: collisions.rows,
    crossRepresentationInconsistencies: inconsistencies.rows,
    blankPhoneUsers: blanks.rows,
    operatorDecisionRequired: collisions.rows.length > 0 || inconsistencies.rows.length > 0,
    notes: 'blank phones normalize to NULL at 0002 (absence, not identity); real-phone collisions BLOCK 0002 loudly; cross-representation inconsistencies are operator judgment - non-blocking in code, never unexamined in operation.',
  };
  const canonical = JSON.stringify({ c: report.collisionGroups, i: report.crossRepresentationInconsistencies, b: report.blankPhoneUsers });
  const listDigest = createHash('sha256').update(canonical).digest('hex');
  console.log(JSON.stringify({ ...report, listDigest }, null, 2));
  console.error(`PREFLIGHT: ${collisions.rows.length} collision group(s), ${inconsistencies.rows.length} cross-representation inconsistency(ies), ${blanks.rows.length} blank phone(s). listDigest=${listDigest}`);
  console.error(`PREFLIGHT: acknowledge with OPERATOR_ACK=ack:${listDigest} before executing the migration.`);
} finally { await pool.end(); }
