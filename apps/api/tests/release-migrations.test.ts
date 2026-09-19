/** Release-migration runner gates (unified declarative redesign 2026-09-18,
 *  after QA FAILs of f9854cd6/9182487e/22267edb + security verdicts + TL
 *  reconciliation): hermetic PGlite proofs. Cross-session locking, real-PG
 *  DDL rollback and restart durability are proven by
 *  apps/api/evidence-realpg-release-migrations.mts (PGlite is
 *  single-connection). */
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgliteConnectable } from '../src/repo/postgres.js';
import {
  MIGRATIONS, EXPECTED_SCHEMA_VERSIONS, assertDirectDatabaseUrl,
  assertSchemaCurrent, assertZeroCatalogDelta, buildAssertionQuery,
  catalogSnapshot, requiredBootIdentity,
  runMigrations, sequenceValues, restoreSequenceValues, stepDigest, validateAssertion,
  verifyTargetPreconditions, assertSingleStatementForms, REGISTRY_DIGEST, type MigrationStep,
} from '../src/migrations/runner.js';
import * as runnerModule from '../src/migrations/runner.js';
import { attendedResolveDirty, issueOperatorPreflight, operatorAckFor, type Connectable } from '../src/migrations/runner.js';
/** SA2+SA3: staging-shaped lanes mint the attended-TOFU ack through the
 *  runner's REAL issuance path (persisted issued-nonce record; the runner
 *  re-verifies + consumes it in-transaction). No label exemption exists. */
const stagingRunMigrations = async (conn: Connectable, opts: Parameters<typeof runnerModule.runMigrations>[1]): Promise<runnerModule.MigrationRunResult> => {
  const pf = await issueOperatorPreflight(conn, { deployment: opts.deployment });
  return runnerModule.runMigrations(conn, { operatorAck: operatorAckFor(pf), ...opts });
};

async function freshDb() {
  const pg = new PGlite();
  const conn = pgliteConnectable(pg);
  return { pg, conn };
}

const step = (version: string, name: string, template: string, params: Readonly<Record<string, unknown>>, extra?: Partial<MigrationStep>): MigrationStep => ({
  version, name, description: `test step ${name}`, template, params, ...extra,
});
/** The SA-shaped step as inert data (R3 section 4 coverage): runner-managed
 *  lock + named guards + canonical expression index via the NAMED form. */
const SA_PARAMS = { index: 'users_phone_unique', table: 'users', unique: 'unique', expression: 'EXPR_NORM_PHONE', predicate: 'PRED_PHONE_NOT_NULL', ifNotExists: 'if-not-exists' } as const;

describe('R4 confined-registry contract (module-private frozen registry; anchored digests; inert artifacts)', () => {
  it('SA-shaped index applies via runMigrations; exact indexdef is catalog-observed (render is not exported)', async () => {
    const { pg, conn } = await freshDb();
    const sa = step('0004', 'sa', 'ddl.create-index', SA_PARAMS);
    await stagingRunMigrations(conn, { deployment: 'staging', migrations: [...MIGRATIONS, sa] });
    const idx = await conn.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'users_phone_unique'`);
    const indexdef = String(idx.rows[0]?.['indexdef'] ?? '');
    console.log(`OBSERVED[sa indexdef]: ${indexdef}`);
    expect(indexdef).toMatch(/^CREATE UNIQUE INDEX users_phone_unique ON public\.users USING btree \(btrim\(phone\)\) WHERE \(phone IS NOT NULL\)?$/);
    expect(indexdef).not.toContain(';'); // one statement, no separator
    // extra/missing params refuse at registration, driven through the runner
    // (as a NOT-yet-applied version so rendering is actually reached):
    await expect(stagingRunMigrations(conn, { deployment: 'staging', migrations: [...MIGRATIONS, sa, step('0005', 'sa2', 'ddl.create-index', { ...SA_PARAMS, extra: 1 })] }))
      .rejects.toThrow(/do not exactly match/);
    await pg.close();
  });
  it('identifier-injection refused at registration (runner-driven, OBSERVED per class)', async () => {
    const { pg, conn } = await freshDb();
    for (const bad of [`us"; DROP TABLE users;--`, `users' OR '1'='1`, 'public.users', 'attacker.users', 'Users', 'pg_catalog', 'pg_shadow', 'us ers', '']) {
      let observed = '';
      try { await stagingRunMigrations(conn, { deployment: 'staging', migrations: [step('0001', 'x', 'ddl.create-index', { ...SA_PARAMS, table: bad })] }); } catch (e) { observed = String(e); }
      console.log(`OBSERVED[identifier-injection ${JSON.stringify(bad)}]: ${observed.slice(0, 130)}`);
      expect(observed, bad).toMatch(/TEMPLATE refusal/);
    }
    await pg.close();
    // the binders themselves are module-private (R5) - proven in the
    // confined-surface test below.
  });
  it('enum escape refused at registration: closed sets only (runner-driven)', async () => {
    const { pg, conn } = await freshDb();
    for (const [k, bad] of [['unique', 'UNIQUE'], ['unique', 'yes'], ['ifNotExists', 'sometimes'], ['ifNotExists', 'if-not-exists; DROP TABLE users']] as const) {
      let observed = '';
      try { await stagingRunMigrations(conn, { deployment: 'staging', migrations: [step('0001', 'x', 'ddl.create-index', { ...SA_PARAMS, [k]: bad })] }); } catch (e) { observed = String(e); }
      console.log(`OBSERVED[enum escape ${k}=${JSON.stringify(bad)}]: ${observed.slice(0, 130)}`);
      expect(observed, `${k}=${bad}`).toMatch(/TEMPLATE refusal - enum/);
    }
    await pg.close();
  });
  it('type confusion refused at registration: params bind by declared kind, never interpolated (runner-driven)', async () => {
    const { pg, conn } = await freshDb();
    for (const bad of [1, NaN, Infinity, { a: 1 }, ['x'], null, undefined]) {
      let observed = '';
      try { await stagingRunMigrations(conn, { deployment: 'staging', migrations: [step('0001', 'x', 'ddl.create-index', { ...SA_PARAMS, index: bad })] }); } catch (e) { observed = String(e); }
      console.log(`OBSERVED[type confusion ${JSON.stringify(bad) ?? String(bad)}]: ${observed.slice(0, 130)}`);
      expect(observed, String(bad)).toMatch(/TEMPLATE refusal/);
    }
    await pg.close();
  });
  it('named-form substitution refused at registration; registry unreachable from outside the module', async () => {
    const { pg, conn } = await freshDb();
    for (const bad of ['btrim(phone)', 'attacker.lower(phone)', 'EXPR_NORM_PHONE; DROP TABLE users', 'expr_norm_phone', '']) {
      let observed = '';
      try { await stagingRunMigrations(conn, { deployment: 'staging', migrations: [step('0001', 'x', 'ddl.create-index', { ...SA_PARAMS, expression: bad })] }); } catch (e) { observed = String(e); }
      console.log(`OBSERVED[expression substitution ${JSON.stringify(bad)}]: ${observed.slice(0, 130)}`);
      expect(observed, bad).toMatch(/TEMPLATE refusal/);
    }
    await pg.close();
    // R4 section 1: the registry, named forms and render capability no longer
    // exist on the module surface - external tamper is impossible by type and
    // at runtime (OBSERVED: each name resolves to undefined).
    for (const name of ['TEMPLATES', 'NAMED_EXPRESSIONS', 'NAMED_PREDICATES', 'NAMED_NORMALIZATIONS', 'getTemplate', 'renderStepStatements', 'templateHash', 'STATEMENT_CATALOG_MATRIX', 'bindIdentifier', 'bindLiteral']) {
      const surfaced = (runnerModule as Record<string, unknown>)[name];
      console.log(`OBSERVED[confined surface ${name}]: ${typeof surfaced}`);
      expect(surfaced, name).toBeUndefined();
    }
    // the module namespace itself cannot be rewritten from outside:
    let mutation = 'silently ignored';
    try { (runnerModule as Record<string, unknown>)['REGISTRY_DIGEST'] = 'tampered'; } catch (e) { mutation = String(e); }
    console.log(`OBSERVED[module namespace mutation attempt]: ${mutation.slice(0, 130)}`);
    expect(runnerModule.REGISTRY_DIGEST).toMatch(/^[0-9a-f]{64}$/); // unchanged
    // the canonical named forms themselves are proven by the catalog-observed
    // indexdef in the SA test above: btrim(phone) / phone IS NOT NULL reach
    // the catalog only through the frozen registry.
  });
  it('unknown template name refused at registration', async () => {
    const { pg, conn } = await freshDb();
    let observed = '';
    try { await stagingRunMigrations(conn, { deployment: 'staging', migrations: [step('0001', 'x', 'ddl.drop-database', {})] }); } catch (e) { observed = String(e); }
    console.log(`OBSERVED[unknown template]: ${observed.slice(0, 140)}`);
    expect(observed).toMatch(/unknown template name/);
    await pg.close();
  });
  it('ONE canonical REGISTRY_DIGEST anchors every digest; tampered params shift the step digest', () => {
    expect(REGISTRY_DIGEST).toMatch(/^[0-9a-f]{64}$/);
    console.log(`OBSERVED[anchor A surface]: REGISTRY_DIGEST=${REGISTRY_DIGEST}`);
    const a = step('0002', 'sa', 'ddl.create-index', SA_PARAMS);
    expect(stepDigest(a)).not.toBe(stepDigest(step('0002', 'sa', 'ddl.create-index', { ...SA_PARAMS, index: 'users_phone_unique2' })));
    expect(stepDigest(a)).not.toBe(stepDigest({ ...a, xactLockKey: 7 }));
    expect(stepDigest(a)).toBe(stepDigest({ ...a, description: 'edited metadata only' }));
    // registry tamper from outside is impossible (nothing is exported); any
    // in-source registry edit moves REGISTRY_DIGEST, which moves EVERY v8
    // step digest - and the DB anchor (proven below) refuses the drift.
  });
  it('code-object creation is impossible by construction and absent from the catalog after a full run', async () => {
    const { pg, conn } = await freshDb();
    const sa = step('0004', 'sa', 'ddl.create-index', SA_PARAMS);
    await stagingRunMigrations(conn, { deployment: 'staging', migrations: [...MIGRATIONS, sa] });
    const counts = await conn.query(`SELECT
      (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') AS funcs,
      (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal) AS triggers,
      (SELECT count(*)::int FROM pg_policy) AS policies,
      (SELECT count(*)::int FROM pg_operator o JOIN pg_namespace n ON n.oid = o.oprnamespace WHERE n.nspname = 'public') AS operators,
      (SELECT count(*)::int FROM pg_cast c JOIN pg_proc p ON p.oid = c.castfunc JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') AS casts`);
    console.log(`OBSERVED[code-object absence]: ${JSON.stringify(counts.rows[0])}`);
    expect(counts.rows[0]).toEqual({ funcs: 0, triggers: 0, policies: 0, operators: 0, casts: 0 });
    // R4: with the render surface confined and frozen, no caller-reachable
    // path can emit FUNCTION/TRIGGER/RULE/OPERATOR/CAST/POLICY/EXTENSION/
    // DO/CALL/SECURITY DEFINER; the runner's own catalog diff (proven below)
    // refuses any that appear mid-step.
    await pg.close();
  });
  it('named runner-generated guards: strict objects, qualified SQL generated by the runner only', () => {
    expect(buildAssertionQuery({ kind: 'table-empty', table: 'users' }))
      .toBe('SELECT 1 AS violation FROM "public"."users" LIMIT 1');
    expect(buildAssertionQuery({ kind: 'no-duplicates', table: 'users', column: 'phone', normalize: 'btrim' }))
      .toBe('SELECT 1 AS violation FROM "public"."users" WHERE "phone" IS NOT NULL GROUP BY pg_catalog.btrim("phone") HAVING pg_catalog.count(*) > 1 LIMIT 1');
    expect(buildAssertionQuery({ kind: 'no-nulls', table: 'users', column: 'phone' }))
      .toBe('SELECT 1 AS violation FROM "public"."users" WHERE "phone" IS NULL LIMIT 1');
    expect(() => validateAssertion({ kind: 'table-empty', table: 'users; DROP TABLE users' } as never)).toThrow(/invalid assertion/);
    expect(() => validateAssertion({ kind: 'no-duplicates', table: 'users', column: 'phone",1);--' } as never)).toThrow(/invalid assertion/);
    expect(() => validateAssertion({ kind: 'nope', table: 'users' } as never)).toThrow(/unknown assertion kind/);
    // STRICT runtime validation (security closure): exact own-key sets,
    // exact enums/booleans, canonical identifiers
    expect(() => validateAssertion({ kind: 'table-empty', table: 'users', extra: 1 } as never)).toThrow(/unexpected key/);
    expect(() => validateAssertion({ kind: 'no-nulls', table: 'users', column: 'phone', normalize: 'none' } as never)).toThrow(/unexpected key/);
    expect(() => validateAssertion({ kind: 'no-duplicates', table: 'users', column: 'phone', normalize: 'BTRIM' } as never)).toThrow(/exactly 'btrim', 'btrim-nullif-empty' or 'none'/);
    expect(() => validateAssertion({ kind: 'no-duplicates', table: 'users', column: 'phone', skipNulls: 'yes' } as never)).toThrow(/exact boolean/);
    expect(() => validateAssertion({ kind: 'no-duplicates', table: 'Users', column: 'phone' } as never)).toThrow(/invalid assertion/);
    expect(() => validateAssertion({ kind: 'no-duplicates', table: 'public.users', column: 'phone' } as never)).toThrow(/invalid assertion/);
    expect(() => validateAssertion(null as never)).toThrow(/must be an object/);
  });

  it('single-statement construction: load-time assertion refuses every separator form (OBSERVED); module load itself proves the gate passed', () => {
    // this suite running at all proves the module-load assertion over the
    // frozen registry passed - a separator would have refused the import.
    console.log(`OBSERVED[load gate passed]: module loaded with REGISTRY_DIGEST=${REGISTRY_DIGEST.slice(0, 16)}...`);
    assertSingleStatementForms(['CREATE UNIQUE INDEX "a" ON "public"."b" ("c")'], 'probe');
    for (const bad of ['SELECT 1; DROP TABLE users', 'a;b', ';', 'CREATE INDEX a ON b(c); SELECT 1']) {
      let observed = '';
      try { assertSingleStatementForms([bad], 'probe'); } catch (e) { observed = String(e); }
      console.log(`OBSERVED[separator refusal ${JSON.stringify(bad)}]: ${observed.slice(0, 130)}`);
      expect(observed, bad).toMatch(/LOAD INTEGRITY refusal/);
    }
    // non-transactional classes (CONCURRENTLY/VACUUM/ALTER SYSTEM/
    // CREATE+DROP DATABASE/REINDEX/CALL/DO) cannot exist: the registry that
    // could emit them is module-private, frozen, and load-asserted.
  });

  it('CTL-DDL-CONFINEMENT: catalog diff catches every persisting code/privilege/ownership class; post-rollback catalog exactly equal', async () => {
    const { pg, conn } = await freshDb();
    await stagingRunMigrations(conn, { deployment: 'staging' });
    await conn.query(`CREATE SEQUENCE public.demo_seq`);
    const baseline = await catalogSnapshot(conn);
    const rogueBatches: [string, string[]][] = [
      ['SECURITY DEFINER function', [`CREATE FUNCTION public.sd() RETURNS int SECURITY DEFINER LANGUAGE sql AS 'SELECT 1'`]],
      ['plain function', [`CREATE FUNCTION public.pl() RETURNS int LANGUAGE sql AS 'SELECT 1'`]],
      ['trigger', [`CREATE FUNCTION public.tf() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`, `CREATE TRIGGER tr BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.tf()`]],
      ['rule', [`CREATE RULE rr AS ON INSERT TO public.users DO ALSO NOTHING`]],
      ['operator', [`CREATE FUNCTION public.oef(text, text) RETURNS boolean LANGUAGE sql AS 'SELECT true'`, `CREATE OPERATOR public.=== (LEFTARG = text, RIGHTARG = text, FUNCTION = public.oef)`]],
      ['cast', [`CREATE FUNCTION public.cf(text) RETURNS int LANGUAGE sql AS 'SELECT 1'`, `CREATE CAST (text AS int) WITH FUNCTION public.cf(text) AS ASSIGNMENT`]],
      ['ACL grant', [`GRANT SELECT ON public.users TO PUBLIC`]],
      ['default ACL', [`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC`]],
      ['role setting (config drift)', [`ALTER ROLE CURRENT_USER SET work_mem = '64MB'`]],
      ['policy', [`CREATE POLICY pol ON public.users USING (true)`]],
      ['sequence value (non-transactional)', [`SELECT nextval('public.demo_seq')`]],
    ];
    for (const [label, batch] of rogueBatches) {
      await conn.query('BEGIN');
      const before = await catalogSnapshot(conn);
      for (const q of batch) await conn.query(q);
      const after = await catalogSnapshot(conn);
      expect(() => assertZeroCatalogDelta(before, after, 'rogue'), label).toThrow(/CATALOG DELTA refusal/);
      await conn.query('ROLLBACK');
      if (label === 'sequence value (non-transactional)') {
        // nextval NEVER rolls back (condition 6): detection holds here; the
        // runner-level restore is proven separately below. Re-baseline.
        const drift = JSON.stringify(await catalogSnapshot(conn));
        expect(drift).not.toBe(JSON.stringify(baseline));
        await conn.query(`SELECT setval('public.demo_seq', 1, false)`);
      }
      // condition 5: post-rollback catalog equality is EXACT (canonical serialization)
      expect(JSON.stringify(await catalogSnapshot(conn)), label).toBe(JSON.stringify(baseline));
    }
    // benign step keeps zero diff (no false positive on legal DDL)
    await conn.query('BEGIN');
    const b0 = await catalogSnapshot(conn);
    await conn.query(`CREATE TABLE public.benign(id int)`);
    const a0 = await catalogSnapshot(conn);
    expect(() => assertZeroCatalogDelta(b0, a0, 'benign')).not.toThrow();
    await conn.query('ROLLBACK');
    await pg.close();
  });

  it('R2 attack matrix: pre-existing-object alteration, in-tx trigger firing, >2^53 sequence - each with OBSERVED ARTIFACT', async () => {
    const { pg, conn } = await freshDb();
    await stagingRunMigrations(conn, { deployment: 'staging' });
    // Pre-existing objects planted OUTSIDE any step (legitimate baseline state):
    await conn.query(`CREATE FUNCTION public.legit() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
    await conn.query(`CREATE FUNCTION public.trg_fire() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''TRIGGER FIRED''; END'`);
    await conn.query(`CREATE SEQUENCE public.big_seq`);
    const baseline = await catalogSnapshot(conn);
    const attacks: [string, string[], RegExp][] = [
      ['OR REPLACE body swap on pre-existing function',
        [`CREATE OR REPLACE FUNCTION public.legit() RETURNS int LANGUAGE sql AS 'SELECT 999'`], /pg_proc.*legit/],
      ['ALTER FUNCTION SET search_path (config drift on pre-existing)',
        [`ALTER FUNCTION public.legit() SET search_path = attacker`], /pg_proc.*legit/],
      ['GRANT EXECUTE ON FUNCTION to PUBLIC',
        [`GRANT EXECUTE ON FUNCTION public.legit() TO PUBLIC`], /pg_proc.*legit/],
      ['COMMENT ON pre-existing function (description drift)',
        [`COMMENT ON FUNCTION public.legit() IS 'backdoored'`], /pg_description.*legit/],
      ['ALTER DATABASE SET (instance-level config drift)',
        [`ALTER DATABASE postgres SET work_mem = '1GB'`], /pg_db_role_setting/],
      ['ALTER ROLE SET (role-level config drift)',
        [`ALTER ROLE CURRENT_USER SET statement_timeout = 0`], /pg_db_role_setting/],
      ['policy role/command mutation on pre-existing policy',
        [`CREATE POLICY pre_pol ON public.users USING (true)`, `ALTER POLICY pre_pol ON public.users TO PUBLIC USING (false)`], /pg_policy.*pre_pol/],
      ['default-ACL plant',
        [`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC`], /pg_default_acl/],
      ['ownership change on pre-existing table',
        [`CREATE ROLE r2_own_test`, `ALTER TABLE public.users OWNER TO r2_own_test`], /owner_rel.*users/],
    ];
    for (const [label, batch, artifact] of attacks) {
      await conn.query('BEGIN');
      const before = await catalogSnapshot(conn);
      for (const q of batch) await conn.query(q);
      const after = await catalogSnapshot(conn);
      // OBSERVED ARTIFACT: the actual violation text naming the attacked object.
      let observed = '';
      try { assertZeroCatalogDelta(before, after, 'atk'); } catch (e) { observed = String(e); }
      expect(observed, label).toMatch(/CATALOG DELTA refusal/);
      expect(observed, `${label} - artifact must name the attacked object`).toMatch(artifact);
      console.log(`OBSERVED[${label}]: ${observed.slice(0, 240)}`);
      await conn.query('ROLLBACK');
      expect(JSON.stringify(await catalogSnapshot(conn)), `${label} - post-rollback catalog EXACT`).toBe(JSON.stringify(baseline));
    }

    // In-transaction trigger ACTUALLY FIRES: create, INSERT, observe the
    // effect (raised error text), then rollback and prove post-rollback
    // non-existence. The observed artifact is the actual raised error.
    await conn.query('BEGIN');
    const bT = await catalogSnapshot(conn);
    await conn.query(`CREATE TRIGGER fire_me BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.trg_fire()`);
    const aT = await catalogSnapshot(conn);
    let trigObserved = '';
    try { assertZeroCatalogDelta(bT, aT, 'atk'); } catch (e) { trigObserved = String(e); }
    expect(trigObserved).toMatch(/pg_trigger.*fire_me/);
    let firedEffect = '';
    try { await conn.query(`INSERT INTO public.users(user_id, org_id, phone, data) VALUES ('atk','o','p','{}')`); } catch (e) { firedEffect = String(e); }
    console.log(`OBSERVED[trigger fires in-tx]: ${firedEffect.slice(0, 160)}`);
    expect(firedEffect).toMatch(/TRIGGER FIRED/); // the trigger REALLY fired
    await conn.query('ROLLBACK');
    const postTrig = await conn.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'fire_me' AND NOT tgisinternal`);
    expect(Number(postTrig.rows[0]?.['n'])).toBe(0); // post-rollback non-existence
    expect(JSON.stringify(await catalogSnapshot(conn))).toBe(JSON.stringify(baseline));

    // >2^53 sequence: exact text end to end (JS Number would corrupt).
    const BIG = '9007199254740993'; // 2^53 + 1
    await conn.query(`SELECT setval('public.big_seq', $1::text::bigint, true)`, [BIG]);
    const sv = await conn.query(`SELECT last_value::text AS lv, is_called AS ic FROM public.big_seq`);
    expect(String(sv.rows[0]?.['lv']), 'sequence value crosses 2^53 exactly').toBe(BIG);
    expect(sv.rows[0]?.['ic']).toBe(true);
    const snap = await catalogSnapshot(conn);
    const seqRow = snap.find(x => x.startsWith('seqval ') && x.includes('big_seq'));
    console.log(`OBSERVED[>2^53 sequence row]: ${seqRow}`);
    expect(seqRow, 'snapshot carries the exact bigint text').toContain(BIG);
    await pg.close();
  });

  it('sequence restore: exact text past 2^53, active restore, ERR-PROPAGATE on injected restore failure', async () => {
    const { pg, conn } = await freshDb();
    await stagingRunMigrations(conn, { deployment: 'staging' });
    await conn.query(`CREATE SEQUENCE public.restore_seq`);
    const before = await sequenceValues(conn);
    const BIG = '9007199254740993'; // 2^53 + 1 - JS Number would corrupt this
    await conn.query(`SELECT setval('public.restore_seq', $1::text::bigint, true)`, [BIG]);
    const drifted = await sequenceValues(conn);
    expect(drifted.get('public.restore_seq')?.lastValue).toBe(BIG); // exact text capture
    const restored = await restoreSequenceValues(conn, before);
    console.log(`OBSERVED[restore]: restored=${JSON.stringify(restored)}`);
    expect(restored).toContain('public.restore_seq');
    const after = await sequenceValues(conn);
    expect(after.get('public.restore_seq')).toEqual(before.get('public.restore_seq')); // both fields exactly restored
    // restore-failure INJECTION: the sequence vanished since capture -
    // restoration errors PROPAGATE (no swallow anywhere in the path).
    await conn.query(`DROP SEQUENCE public.restore_seq`);
    let observed = '';
    try { await restoreSequenceValues(conn, drifted); } catch (e) { observed = String(e); }
    console.log(`OBSERVED[restore-failure injection]: ${observed.slice(0, 180)}`);
    expect(observed).not.toBe('');
    // DIRTY/INDETERMINATE labeling lives in the runner catch path: with
    // general DML removed, no template can drift a sequence mid-step, so the
    // runner-level path is dormant defense-in-depth proven here at helper
    // level (capture/restore/failure-injection) with both errors retained
    // by construction of the catch wrapper.
    await pg.close();
  });

  it('R2 defense-in-depth: migration-role functions carry NO default PUBLIC EXECUTE; boot gate asserts the hardening', async () => {
    const { pg, conn } = await freshDb();
    await stagingRunMigrations(conn, { deployment: 'staging' });
    await conn.query(`CREATE FUNCTION public.check_acl() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
    const f = await conn.query(`SELECT proacl::text AS acl FROM pg_proc WHERE proname = 'check_acl'`);
    const acl = String(f.rows[0]?.['acl'] ?? '');
    console.log(`OBSERVED[default function ACL]: ${acl === '' ? 'NULL (PUBLIC execute default!)' : acl}`);
    expect(acl, 'default privileges revoke PUBLIC EXECUTE - no empty-grantee entries').not.toMatch(/(^\{|,)=/);
    expect(acl).not.toBe(''); // NULL proacl would mean the PUBLIC-execute default
    await assertSchemaCurrent(conn); // boot gate green with hardening in place
    // Tamper: re-grant PUBLIC default execute -> boot gate must refuse.
    await conn.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC`);
    // The schema-scoped grant leaves the global revoke intact; remove the
    // global revoke to simulate full tamper:
    await conn.query(`ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC`);
    let refused = '';
    try { await assertSchemaCurrent(conn); } catch (e) { refused = String(e); }
    console.log(`OBSERVED[boot refuses tampered default ACLs]: ${refused.slice(0, 200)}`);
    expect(refused).toMatch(/DEFAULT PRIVILEGE refusal/);
    await pg.close();
  });

  it('R4 anchor B: first run pins the DB-anchored REGISTRY_DIGEST; tamper refuses run AND boot (OBSERVED); NULL adopts once', async () => {
    const { pg, conn } = await freshDb();
    await stagingRunMigrations(conn, { deployment: 'staging' });
    const anchored = await conn.query(`SELECT registry_digest AS d FROM public.contake_db_identity WHERE id = 1`);
    console.log(`OBSERVED[anchor pinned at first run]: ${String(anchored.rows[0]?.['d'])}`);
    expect(anchored.rows[0]?.['d']).toBe(REGISTRY_DIGEST);
    // tamper the anchor: the run AND the boot gate refuse with the observed mismatch
    await conn.query(`UPDATE public.contake_db_identity SET registry_digest = 'tampered' WHERE id = 1`);
    let runRefusal = '';
    try { await stagingRunMigrations(conn, { deployment: 'staging' }); } catch (e) { runRefusal = String(e); }
    console.log(`OBSERVED[anchor tamper - run]: ${runRefusal.slice(0, 180)}`);
    expect(runRefusal).toMatch(/ANCHOR refusal/);
    expect(runRefusal).toMatch(/tampered/);
    let bootRefusal = '';
    try { await assertSchemaCurrent(conn); } catch (e) { bootRefusal = String(e); }
    console.log(`OBSERVED[anchor tamper - boot]: ${bootRefusal.slice(0, 180)}`);
    expect(bootRefusal).toMatch(/ANCHOR refusal/);
    // restore heals both paths:
    await conn.query(`UPDATE public.contake_db_identity SET registry_digest = $1 WHERE id = 1`, [REGISTRY_DIGEST]);
    await expect(stagingRunMigrations(conn, { deployment: 'staging' })).resolves.toBeDefined();
    await expect(assertSchemaCurrent(conn)).resolves.toBeUndefined();
    // pre-R4 database (NULL anchor): boot refuses; unpinned adoption writes
    // NOTHING (R5 section 3); only a run carrying BOTH operator pins adopts.
    await conn.query(`UPDATE public.contake_db_identity SET registry_digest = NULL WHERE id = 1`);
    let adoptionRefusal = '';
    try { await assertSchemaCurrent(conn); } catch (e) { adoptionRefusal = String(e); }
    console.log(`OBSERVED[anchor NULL - boot]: ${adoptionRefusal.slice(0, 180)}`);
    expect(adoptionRefusal).toMatch(/no DB-anchored REGISTRY_DIGEST/);
    let unpinned = '';
    try { await stagingRunMigrations(conn, { deployment: 'staging' }); } catch (e) { unpinned = String(e); }
    console.log(`OBSERVED[unpinned adoption refused]: ${unpinned.slice(0, 200)}`);
    expect(unpinned).toMatch(/LEGACY ADOPTION refusal/);
    const stillNull = await conn.query(`SELECT registry_digest AS d FROM public.contake_db_identity WHERE id = 1`);
    expect(stillNull.rows[0]?.['d']).toBeNull(); // nothing was written
    const iid = String((await conn.query(`SELECT instance_id AS i FROM public.contake_db_identity WHERE id = 1`)).rows[0]?.['i']);
    // wrong pins refuse too:
    await expect(stagingRunMigrations(conn, { deployment: 'staging', expectInstanceId: 'wrong-instance', expectRegistryDigest: REGISTRY_DIGEST }))
      .rejects.toThrow(/INSTANCE BINDING refusal/);
    await expect(stagingRunMigrations(conn, { deployment: 'staging', expectInstanceId: iid, expectRegistryDigest: 'deadbeef' }))
      .rejects.toThrow(/REGISTRY PIN refusal/);
    // both correct pins adopt:
    await expect(stagingRunMigrations(conn, { deployment: 'staging', expectInstanceId: iid, expectRegistryDigest: REGISTRY_DIGEST })).resolves.toBeDefined();
    const adopted = await conn.query(`SELECT registry_digest AS d FROM public.contake_db_identity WHERE id = 1`);
    console.log(`OBSERVED[anchor adopted with both pins]: ${String(adopted.rows[0]?.['d'])}`);
    expect(adopted.rows[0]?.['d']).toBe(REGISTRY_DIGEST);
    await expect(assertSchemaCurrent(conn)).resolves.toBeUndefined();
    await pg.close();
  });

  it('digest binds the inert template identity AND params; digests are deterministic', () => {
    const a = step('0001', 'x', 'ddl.create-index', SA_PARAMS);
    expect(stepDigest(a)).toBe(stepDigest(step('0001', 'x', 'ddl.create-index', { ...SA_PARAMS })));
    expect(stepDigest(MIGRATIONS[0]!)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('release-migration runner', () => {
  it('boot gate fails closed before any initialization', async () => {
    const { pg, conn } = await freshDb();
    await expect(assertSchemaCurrent(conn)).rejects.toThrow(/never initialized|fail-closed/);
    await pg.close();
  });

  it('initializes explicitly; boot gate passes; re-run is a no-op', async () => {
    const { pg, conn } = await freshDb();
    const r1 = await stagingRunMigrations(conn, { deployment: 'staging' });
    expect(r1.appliedNow).toEqual([...EXPECTED_SCHEMA_VERSIONS]);
    expect(r1.stampedNow).toBe(true);
    for (const t of ['users', 'otp_codes', 'auth_audit', 'schema_migrations', 'contake_db_identity']) {
      const q = await conn.query(`SELECT to_regclass('${t}') AS r`);
      expect(q.rows[0]?.['r'], `table ${t}`).toBe(t);
    }
    await expect(assertSchemaCurrent(conn)).resolves.toBeUndefined();
    const r2 = await stagingRunMigrations(conn, { deployment: 'staging' });
    expect([r2.appliedNow, r2.stampedNow]).toEqual([[], false]);
    await pg.close();
  });

  it('adopts a pre-migration database as a no-op baseline (IF NOT EXISTS)', async () => {
    const { pg, conn } = await freshDb();
    const { GRAPH_DDL } = await import('../src/repo/postgres.js');
    for (const stmt of GRAPH_DDL.split(';').map(s => s.trim()).filter(Boolean)) await conn.query(stmt);
    const r = await stagingRunMigrations(conn, { deployment: 'production-pilot' });
    expect(r.appliedNow).toEqual(['0001', '0002', '0003']);
    await expect(assertSchemaCurrent(conn)).resolves.toBeUndefined();
    await pg.close();
  });

  it('pre-mutation target binding: pin and deployment verified BEFORE any write', async () => {
    const { pg, conn } = await freshDb();
    // Wrong deployment label on an UNSTAMPED db: fine (first run). Wrong PIN
    // on a STAMPED db must refuse with zero writes.
    await stagingRunMigrations(conn, { deployment: 'staging' });
    const stamped = await conn.query(`SELECT instance_id FROM contake_db_identity`);
    const iid = String(stamped.rows[0]!['instance_id']);
    await expect(verifyTargetPreconditions(conn, { deployment: 'staging', expectInstanceId: 'wrong-pin' })).rejects.toThrow(/INSTANCE BINDING refusal/);
    await expect(verifyTargetPreconditions(conn, { deployment: 'production-pilot' })).rejects.toThrow(/CROSS-DEPLOYMENT refusal/);
    await expect(verifyTargetPreconditions(conn, { deployment: 'staging', expectInstanceId: iid })).resolves.toEqual(
      { firstRun: false, identity: { deploymentLabel: 'staging', instanceId: iid } },
    );
    // runMigrations with a wrong pin refuses too (defense in depth, pre-step).
    await expect(stagingRunMigrations(conn, { deployment: 'staging', expectInstanceId: 'wrong-pin' })).rejects.toThrow(/INSTANCE BINDING refusal/);
    // Fresh DB + supplied pin: refused BEFORE any write (TOFU requires an
    // omitted pin + attended verification).
    const { pg: pg2, conn: conn2 } = await freshDb();
    await expect(verifyTargetPreconditions(conn2, { deployment: 'staging' })).resolves.toEqual({ firstRun: true });
    await expect(verifyTargetPreconditions(conn2, { deployment: 'staging', expectInstanceId: '0123456789abcdef' })).rejects.toThrow(/INSTANCE BINDING refusal/);
    await expect(runMigrations(conn2, { deployment: 'staging', expectInstanceId: '0123456789abcdef' })).rejects.toThrow(/INSTANCE BINDING refusal/);
    const sm = await conn2.query(`SELECT to_regclass('schema_migrations') AS r`);
    expect(sm.rows[0]?.['r']).toBeNull(); // zero writes
    await pg2.close();
    await pg.close();
  });

  it('runtime boot: EVERY PG boot requires validated deployment + instance identity', async () => {
    const { pg, conn } = await freshDb();
    const r = await stagingRunMigrations(conn, { deployment: 'staging' });
    const iid = r.identity.instanceId;
    // missing/malformed instance id fails closed for ANY deployment shape
    expect(() => requiredBootIdentity('staging', undefined)).toThrow(/CONTAKE_DB_INSTANCE_ID/);
    expect(() => requiredBootIdentity('production-pilot', undefined)).toThrow(/CONTAKE_DB_INSTANCE_ID/);
    expect(() => requiredBootIdentity('dev', 'not-hex')).toThrow(/CONTAKE_DB_INSTANCE_ID/);
    expect(requiredBootIdentity('staging', iid)).toEqual({ deployment: 'staging', instanceId: iid });
    await expect(assertSchemaCurrent(conn, undefined, { deployment: 'staging', instanceId: iid })).resolves.toBeUndefined();
    await expect(assertSchemaCurrent(conn, undefined, { deployment: 'production-pilot', instanceId: iid })).rejects.toThrow(/DEPLOYMENT refusal/);
    await expect(assertSchemaCurrent(conn, undefined, { deployment: 'staging', instanceId: '0123456789abcdef' })).rejects.toThrow(/INSTANCE refusal/);
    await pg.close();
  });

  it('forward-only: unknown/gapped history refuses; boot gate flags it', async () => {
    const { pg, conn } = await freshDb();
    await stagingRunMigrations(conn, { deployment: 'staging' });
    await conn.query(`INSERT INTO schema_migrations(version, name, sha256, applied_by) VALUES('0099', 'foreign', 'x', 'test')`);
    await expect(stagingRunMigrations(conn, { deployment: 'staging' })).rejects.toThrow(/FORWARD-ONLY/);
    await expect(assertSchemaCurrent(conn)).rejects.toThrow(/unknown=\[0099\]/);
    await pg.close();
  });

  it('edited applied history (name or digest) fails runner AND boot gate', async () => {
    const { pg, conn } = await freshDb();
    await stagingRunMigrations(conn, { deployment: 'staging' });
    await conn.query(`UPDATE schema_migrations SET name = 'renamed' WHERE version = '0001'`);
    await expect(stagingRunMigrations(conn, { deployment: 'staging' })).rejects.toThrow(/INTEGRITY refusal/);
    await conn.query(`UPDATE schema_migrations SET name = 'init-schema', sha256 = 'deadbeef' WHERE version = '0001'`);
    await expect(assertSchemaCurrent(conn)).rejects.toThrow(/INTEGRITY refusal/);
    await pg.close();
  });

  it('digest binds the exact inert artifact (template identity + params) AND declared primitives', () => {
    const a = step('0002', 'sa', 'ddl.create-index', SA_PARAMS);
    expect(stepDigest(a)).not.toBe(stepDigest(step('0002', 'sa', 'ddl.create-index', { ...SA_PARAMS, index: 'other_idx' })));
    expect(stepDigest(a)).not.toBe(stepDigest(step('0002', 'sa', 'init.schema-baseline.0001', {})));
    expect(stepDigest(a)).not.toBe(stepDigest({ ...a, xactLockKey: 7 }));
    expect(stepDigest(a)).not.toBe(stepDigest({ ...a, assertions: [{ kind: 'table-empty', table: 'users' }] }));
    expect(stepDigest(a)).toBe(stepDigest({ ...a, description: 'edited metadata only' }));
  });

  it('param-level edit of an applied step (tampered artifact bytes) fails rerun AND boot', async () => {
    const { pg, conn } = await freshDb();
    const implA = step('0004', 'sa', 'ddl.create-index', SA_PARAMS);
    const r = await stagingRunMigrations(conn, { deployment: 'staging', migrations: [...MIGRATIONS, implA] });
    expect(r.appliedNow).toEqual(['0001', '0002', '0003', '0004']);
    const implB = step('0004', 'sa', 'ddl.create-index', { ...SA_PARAMS, index: 'users_phone_unique_v2' });
    let observed = '';
    try { await stagingRunMigrations(conn, { deployment: 'staging', migrations: [...MIGRATIONS, implB] }); } catch (e) { observed = String(e); }
    console.log(`OBSERVED[tampered artifact refused]: ${observed.slice(0, 160)}`);
    expect(observed).toMatch(/INTEGRITY refusal/);
    await expect(assertSchemaCurrent(conn, [...MIGRATIONS, implA])).resolves.toBeUndefined();
    await pg.close();
  });

  it('a failing template execution rolls back the whole step (no partial DDL, no version)', async () => {
    const { pg, conn } = await freshDb();
    await conn.query(`CREATE TABLE public.partial_leak(id int)`);
    await conn.query(`CREATE INDEX partial_idx ON public.partial_leak(id)`);
    // strict duplicate: the rendered statement fails mid-step
    const failing = step('0001', 'partial', 'ddl.create-index', { index: 'partial_idx', table: 'partial_leak', unique: 'plain', expression: 'EXPR_NONE', predicate: 'PRED_NONE', ifNotExists: 'strict' });
    await expect(stagingRunMigrations(conn, { deployment: 'staging', migrations: [failing] })).rejects.toThrow();
    // the step rolled back atomically: no version row, pre-existing objects
    // untouched (the table/index were planted OUTSIDE the runner).
    const v = await conn.query(`SELECT count(*)::int AS n FROM schema_migrations`);
    expect(Number(v.rows[0]?.['n'])).toBe(0);
    const t = await conn.query(`SELECT to_regclass('partial_leak') AS r, to_regclass('partial_idx') AS i`);
    expect(t.rows[0]?.['r']).toBe('partial_leak');
    expect(t.rows[0]?.['i']).toBe('partial_idx');
    // SA4-C3: the intentional abort left the target durably IN-FLIGHT (the
    // admission consume is never silently restored); attended recovery is
    // the only way back, then a fresh issuance + run succeeds.
    const st = await conn.query(`SELECT eligible, in_flight FROM schema_migration_target_state`);
    expect(st.rows[0]?.['eligible']).toBe(false);
    expect(st.rows[0]?.['in_flight']).toBeTruthy();
    await attendedResolveDirty(conn, { note: 'test: reviewed intentional template failure', resolvedBy: 'test' });
    await stagingRunMigrations(conn, { deployment: 'staging' });
    await expect(assertSchemaCurrent(conn)).resolves.toBeUndefined();
    await pg.close();
  });

  it('version-record integrity: foreign history refuses before any step (squatter class)', async () => {
    const { pg, conn } = await freshDb();
    await stagingRunMigrations(conn, { deployment: 'staging' });
    await conn.query(`UPDATE schema_migrations SET sha256 = 'deadbeef' WHERE version = '0001'`);
    await expect(stagingRunMigrations(conn, { deployment: 'staging' })).rejects.toThrow(/INTEGRITY refusal/);
    await expect(assertSchemaCurrent(conn)).rejects.toThrow(/fail-closed/);
    await pg.close();
  });

  it('guard primitives: assertion hard-fails inside the tx and rolls the step back', async () => {
    const { pg, conn } = await freshDb();
    await stagingRunMigrations(conn, { deployment: 'staging' });
    await conn.query(`INSERT INTO users(user_id, org_id, phone, data) VALUES('u1', 'o1', '+972555111111', '{}')`);
    const guarded = step('0004', 'guarded-index', 'ddl.create-index', { ...SA_PARAMS, index: 'users_phone_unique_guarded' }, {
      xactLockKey: 4242,
      lockTables: ['users'],
      assertions: [{ kind: 'table-empty', table: 'users' }],
    });
    await expect(stagingRunMigrations(conn, { deployment: 'staging', migrations: [...MIGRATIONS, guarded] })).rejects.toThrow(/ASSERTION refusal - guard 'table-empty'/);
    const idx = await conn.query(`SELECT to_regclass('users_phone_unique_guarded') AS r`);
    expect(idx.rows[0]?.['r']).toBeNull(); // artifact never applied
    const v = await conn.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version = '0004'`);
    expect(Number(v.rows[0]?.['n'])).toBe(0);
    await pg.close();
  });

  it('SA-shaped declarative step (locks + guards + canonical index) applies and is recorded', async () => {
    const { pg, conn } = await freshDb();
    const sa = step('0004', 'users-phone-index-v2', 'ddl.create-index', { ...SA_PARAMS, index: 'users_phone_unique_v2' }, {
      xactLockKey: 123456,
      lockTables: ['users'],
      assertions: [{ kind: 'no-duplicates', table: 'users', column: 'phone', normalize: 'btrim' }],
    });
    const r = await stagingRunMigrations(conn, { deployment: 'staging', migrations: [...MIGRATIONS, sa] });
    expect(r.appliedNow).toEqual(['0001', '0002', '0003', '0004']);
    const idx = await conn.query(`SELECT to_regclass('users_phone_unique_v2') AS r`);
    expect(idx.rows[0]?.['r']).toBe('users_phone_unique_v2');
    await expect(assertSchemaCurrent(conn, [...MIGRATIONS, sa])).resolves.toBeUndefined();
    // duplicate normalized phones block the shipped 0002 guard on another db
    // (planted BEFORE the index exists - post-index such an insert is
    // rejected by the index itself):
    const { pg: pg2, conn: conn2 } = await freshDb();
    await runMigrations(conn2, { deployment: 'staging', migrations: MIGRATIONS.slice(0, 1) });
    await conn2.query(`INSERT INTO users(user_id, org_id, phone, data) VALUES('a', 'o', '+972555111111', '{}'), ('b', 'o', ' +972555111111 ', '{}')`);
    await expect(stagingRunMigrations(conn2, { deployment: 'staging', migrations: [...MIGRATIONS, sa] })).rejects.toThrow(/ASSERTION refusal - guard 'no-duplicates'/);
    await pg2.close();
    await pg.close();
  });

  it('rejects a non-sequential registry and invalid primitive declarations', async () => {
    const { pg, conn } = await freshDb();
    await expect(stagingRunMigrations(conn, { deployment: 'staging', migrations: [step('0007', 'x', 'ddl.create-index', SA_PARAMS)] })).rejects.toThrow(/strictly sequential/);
    await expect(stagingRunMigrations(conn, { deployment: 'staging', migrations: [step('0001', 'x', 'ddl.create-index', SA_PARAMS, { lockTables: ['evil; DROP TABLE users'] })] })).rejects.toThrow(/invalid lockTables/);
    await expect(stagingRunMigrations(conn, { deployment: 'staging', migrations: [step('0001', 'x', 'ddl.create-index', { ...SA_PARAMS, table: 'users; DROP' })] })).rejects.toThrow(/TEMPLATE refusal/);
    await pg.close();
  });

  it('role separation: pooled endpoints are refused; descriptors carry no credentials', () => {
    expect(() => assertDirectDatabaseUrl('postgresql://u:SECRET@ep-cool-pooler.eu-central-1.aws.neon.tech/contake')).toThrow(/POOLED/);
    const d = assertDirectDatabaseUrl('postgresql://u:SECRET@ep-cool.eu-central-1.aws.neon.tech/contake');
    expect([d.host, d.database]).toEqual(['ep-cool.eu-central-1.aws.neon.tech', 'contake']);
    expect(JSON.stringify(d)).not.toContain('SECRET');
  });
});
