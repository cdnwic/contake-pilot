/** SA2+SA3 ruling (2026-09-19) - digest-preimage manifest + CONSTRUCTIVE
 *  source-member tamper matrix.
 *  The effective preimage is the EXPLICIT canonical manifest (BLUEPRINT_MANIFEST,
 *  hashes-only, confinement preserved): every artifact with executable
 *  semantics - templates, named expressions, named predicates, named
 *  normalizations, frozen baselines, runner-owned bookkeeping DDL - has
 *  exactly one entry. This suite proves per-member sensitivity BY MUTATING
 *  EACH ACTUAL SOURCE MEMBER IN ITS REAL LOCATION (SA3 section 6: mutating
 *  detached contentHash copies proves nothing and is not evidence),
 *  recomputing REGISTRY_DIGEST through the REAL code path (a child process
 *  loading the real mutated module), and requiring the digest to flip.
 *  Mine (implementation-side). Named structures are module-private by R4
 *  confinement; live-source binding goes through the exported pure review
 *  seams (digestManifestForReview / manifestMemberHashForReview) and the
 *  runner-rendered guard SQL. */
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  BLUEPRINT_MANIFEST, REGISTRY_DIGEST, buildAssertionQuery,
  digestManifestForReview, manifestMemberHashForReview,
} from '../src/migrations/runner.js';

const execFileP = promisify(execFile);
const API_ROOT = path.resolve(__dirname, '..');
const RUNNER_SRC = path.join(API_ROOT, 'src', 'migrations', 'runner.ts');
const REPO_SRC = path.join(API_ROOT, 'src', 'repo', 'postgres.ts');
const CHILD = path.join(API_ROOT, 'tests', 'fixtures', 'sa3-digest-child.mts');

/** The pinned member inventory: ANY member added/removed/renamed in source
 *  without updating this test fails loudly here (drift alarm). */
const EXPECTED_INVENTORY = [
  'frozen-baseline:0001-baseline',
  'runner-ddl:runner-ddl.schema-migrations+identity',
  'runner-ddl:runner-ddl.schema-migration-evidence',
  'runner-ddl:runner-ddl.schema-migration-acks',
  'runner-ddl:runner-ddl.schema-migration-target-state',
  'template:init.schema-baseline.0001',
  'template:ddl.create-index',
  'template:data.normalize-users-phone',
  'named-expression:expressions.EXPR_NONE',
  'named-expression:expressions.EXPR_NORM_PHONE',
  'named-predicate:predicates.PRED_NONE',
  'named-predicate:predicates.PRED_PHONE_NOT_NULL',
  'named-normalization:normalizations.NORM_COL_BTRIM',
  'named-normalization:normalizations.NORM_COL_BTRIM_NULLIF_EMPTY',
  'named-normalization:normalizations.NORM_JSON_BTRIM',
  'named-normalization:normalizations.NORM_JSON_BTRIM_NULLIF_EMPTY',
];

/** Recover the RAW guard-normalization member text from runner-rendered SQL
 *  (live-source binding through the exported renderer): the rendered guard
 *  key embeds the member with {column} substituted. */
const liveGuardNormalization = (): string => {
  const sql = buildAssertionQuery({ kind: 'no-duplicates', table: 'users', column: 'phone', normalize: 'btrim-nullif-empty', skipNulls: true });
  const m = sql.match(/NULLIF\(pg_catalog\.btrim\("phone"\), ''\)/);
  if (!m) throw new Error(`guard normalization fragment not found in rendered SQL: ${sql}`);
  return m[0].replace('"phone"', '{column}');
};

describe('SA2 digest-preimage manifest', () => {
  it('REGISTRY_DIGEST IS the manifest digest (preimage = the manifest, nothing else)', () => {
    expect(REGISTRY_DIGEST).toBe(digestManifestForReview(BLUEPRINT_MANIFEST));
    expect(REGISTRY_DIGEST).toMatch(/^[0-9a-f]{64}$/);
  });

  it('manifest enumerates every executable-semantics member exactly once (pinned inventory)', () => {
    expect(BLUEPRINT_MANIFEST.map(e => `${e.role}:${e.id}`)).toEqual(EXPECTED_INVENTORY);
    expect(new Set(BLUEPRINT_MANIFEST.map(e => `${e.role}:${e.id}`)).size).toBe(BLUEPRINT_MANIFEST.length);
  });

  it('manifest entries bind to LIVE source content: the guard normalization member hash recomputes from runner-rendered SQL', () => {
    const raw = liveGuardNormalization();
    expect(raw).toBe(`NULLIF(pg_catalog.btrim({column}), '')`);
    const entry = BLUEPRINT_MANIFEST.find(e => e.id === 'normalizations.NORM_COL_BTRIM_NULLIF_EMPTY')!;
    expect(manifestMemberHashForReview(entry.role, entry.id, raw)).toBe(entry.contentHash);
  });

  it('manifest is frozen and detached (hashes only; no render content leaves the module)', () => {
    expect(Object.isFrozen(BLUEPRINT_MANIFEST)).toBe(true);
    for (const e of BLUEPRINT_MANIFEST) {
      expect(Object.isFrozen(e)).toBe(true);
      expect(Object.keys(e).sort()).toEqual(['contentHash', 'id', 'role']);
    }
  });
});

/** SA3 section 6: the CONSTRUCTIVE tamper matrix. For EVERY manifest member:
 *  mutate the ACTUAL SOURCE MEMBER in its REAL LOCATION (the exact literal in
 *  the real source file - located by a snippet that must occur EXACTLY once,
 *  proving the binding), recompute REGISTRY_DIGEST through the REAL code path
 *  (a child process loading the real mutated module at its real path), and
 *  require BOTH the member hash AND the digest to flip. Detection is
 *  fail-closed by construction: the flipped digest mismatches every pinned
 *  anchor (operator pin, DB anchor) and the runner refuses before any write.
 *  Source-level, lane-independent: runs once (skipped on the PG lanes). */
interface MemberMutation {
  readonly member: string;
  readonly file: 'runner' | 'repo';
  readonly find: string;
  readonly replace: string;
  /** Extra assertion on the mutated child's rendered guard SQL. */
  readonly guardMustContain?: string;
}
const TAMPER = '/* sa3tamper */';
const MUTATIONS: readonly MemberMutation[] = [
  { member: 'frozen-baseline:0001-baseline', file: 'repo',
    find: 'CREATE TABLE IF NOT EXISTS events(id text PRIMARY KEY, org_id text NOT NULL, version integer NOT NULL, data jsonb NOT NULL);',
    replace: 'CREATE TABLE IF NOT EXISTS events(id text PRIMARY KEY, org_id text NOT NULL, version bigint NOT NULL, data jsonb NOT NULL);' },
  { member: 'runner-ddl:runner-ddl.schema-migrations+identity', file: 'runner',
    find: '  ext_baseline jsonb,\n  migration_role text,',
    replace: '  ext_baseline jsonb, -- sa3tamper\n  migration_role text,' },
  { member: 'runner-ddl:runner-ddl.schema-migration-evidence', file: 'runner',
    find: '  target text NOT NULL,\n  recorded_at timestamptz NOT NULL DEFAULT now(),\n  UNIQUE(event_id)',
    replace: '  target text NOT NULL,\n  recorded_at timestamptz /* sa3tamper */ NOT NULL DEFAULT now(),\n  UNIQUE(event_id)' },
  { member: 'runner-ddl:runner-ddl.schema-migration-acks', file: 'runner',
    find: '  issued_at timestamptz NOT NULL DEFAULT now(),',
    replace: '  issued_at timestamptz NOT NULL DEFAULT now(), -- sa3tamper' },
  { member: 'runner-ddl:runner-ddl.schema-migration-target-state', file: 'runner',
    find: '  dirty_reason jsonb,\n  updated_at timestamptz',
    replace: '  dirty_reason jsonb, -- sa3tamper\n  updated_at timestamptz' },
  { member: 'template:init.schema-baseline.0001', file: 'runner',
    find: "    writesCatalogs: ['owner_rel', 'acl_rel'],\n    shapes: BASELINE_0001_STATEMENTS,",
    replace: "    writesCatalogs: ['acl_rel', 'owner_rel'],\n    shapes: BASELINE_0001_STATEMENTS," },
  { member: 'template:ddl.create-index', file: 'runner',
    find: "CREATE {unique}INDEX {ifNotExists}{index} ON {table} ({expression}){predicate}",
    replace: `CREATE {unique}INDEX {ifNotExists}{index} ON {table} ({expression}){predicate} ${TAMPER}` },
  { member: 'template:data.normalize-users-phone', file: 'runner',
    find: "'WHERE ({column} IS DISTINCT FROM {columnNorm}) ' +",
    replace: `'${TAMPER} WHERE ({column} IS DISTINCT FROM {columnNorm}) ' +` },
  { member: 'named-expression:expressions.EXPR_NONE', file: 'runner',
    find: "  EXPR_NONE: '',",
    replace: `  EXPR_NONE: '${TAMPER}',` },
  { member: 'named-expression:expressions.EXPR_NORM_PHONE', file: 'runner',
    find: "  EXPR_NORM_PHONE: 'btrim(phone)',",
    replace: `  EXPR_NORM_PHONE: 'btrim(phone) ${TAMPER}',` },
  { member: 'named-predicate:predicates.PRED_NONE', file: 'runner',
    find: "  PRED_NONE: '',",
    replace: `  PRED_NONE: '${TAMPER}',` },
  { member: 'named-predicate:predicates.PRED_PHONE_NOT_NULL', file: 'runner',
    find: "  PRED_PHONE_NOT_NULL: 'phone IS NOT NULL',",
    replace: `  PRED_PHONE_NOT_NULL: 'phone IS NOT NULL ${TAMPER}',` },
  { member: 'named-normalization:normalizations.NORM_COL_BTRIM', file: 'runner',
    find: '  NORM_COL_BTRIM: `pg_catalog.btrim({column})`,',
    replace: `  NORM_COL_BTRIM: \`pg_catalog.btrim({column}) ${TAMPER}\`,` },
  { member: 'named-normalization:normalizations.NORM_COL_BTRIM_NULLIF_EMPTY', file: 'runner',
    find: "  NORM_COL_BTRIM_NULLIF_EMPTY: `NULLIF(pg_catalog.btrim({column}), '')`,",
    replace: "  NORM_COL_BTRIM_NULLIF_EMPTY: `NULLIF(pg_catalog.ltrim({column}), '')`,",
    guardMustContain: 'pg_catalog.ltrim' },
  { member: 'named-normalization:normalizations.NORM_JSON_BTRIM', file: 'runner',
    find: '  NORM_JSON_BTRIM: `pg_catalog.btrim({jsonColumn}->>{jsonKey})`,',
    replace: `  NORM_JSON_BTRIM: \`pg_catalog.btrim({jsonColumn}->>{jsonKey}) ${TAMPER}\`,` },
  { member: 'named-normalization:normalizations.NORM_JSON_BTRIM_NULLIF_EMPTY', file: 'runner',
    find: "  NORM_JSON_BTRIM_NULLIF_EMPTY: `NULLIF(pg_catalog.btrim({jsonColumn}->>{jsonKey}), '')`,",
    replace: `  NORM_JSON_BTRIM_NULLIF_EMPTY: \`NULLIF(pg_catalog.btrim({jsonColumn}->>{jsonKey}), '') ${TAMPER}\`,` },
];

const srcOnly = process.env['REPO_IMPL'] === 'pglite' || process.env['REPO_IMPL'] === 'realpg' ? describe.skip : describe;
/** SA4: with SA4_MATRIX_VIA_DIST=1 each in-place source mutation is followed
 *  by a full package build and the child loads the BUILT artifact
 *  (dist/migrations/runner.js) - proving digest recomputation flows through
 *  the shipped dist entrypoint, not only the source module. Heavy (a build
 *  per member); run once in full qualification, not in lane sweeps. */
const VIA_DIST = process.env['SA4_MATRIX_VIA_DIST'] === '1';
srcOnly(`SA3 constructive source-member tamper matrix${VIA_DIST ? ' (SA4: through the BUILT artifact)' : ''}`, () => {
  it('EVERY manifest member: real-location source mutation flips its member hash AND REGISTRY_DIGEST through the real code path', async () => {
    // the pinned inventory is the matrix coverage: one mutation per member.
    expect(MUTATIONS.map(m => m.member).sort()).toEqual([...EXPECTED_INVENTORY].sort());
    const realMembers = Object.fromEntries(BLUEPRINT_MANIFEST.map(e => [e.id, e.contentHash]));
    for (const mut of MUTATIONS) {
      const file = mut.file === 'runner' ? RUNNER_SRC : REPO_SRC;
      const original = readFileSync(file, 'utf8');
      // locatability proof: the snippet occurs EXACTLY once in the real source.
      expect(original.split(mut.find).length - 1, `locator not unique for ${mut.member}`).toBe(1);
      const mutated = original.replace(mut.find, mut.replace);
      writeFileSync(file, mutated);
      try {
        if (VIA_DIST) {
          // SA4: recompute through the built artifact - rebuild dist from the
          // mutated source, then the child loads dist/migrations/runner.js.
          await execFileP('npx', ['tsc'], { cwd: API_ROOT, maxBuffer: 8 * 1024 * 1024, timeout: 300_000 });
        }
        const { stdout } = await execFileP('npx', ['tsx', CHILD], {
          cwd: API_ROOT, maxBuffer: 8 * 1024 * 1024, timeout: 120_000,
          env: { ...process.env, ...(VIA_DIST ? { SA3_MATRIX_MODULE: '../../dist/migrations/runner.js' } : {}) },
        });
        const child = JSON.parse(stdout.trim().split('\n').pop()!) as { digest: string; members: Record<string, string>; guardSql: string };
        const memberId = mut.member.slice(mut.member.indexOf(':') + 1);
        expect(child.digest, `digest did not flip for ${mut.member}`).not.toBe(REGISTRY_DIGEST);
        expect(child.members[memberId], `member hash did not flip for ${mut.member}`).not.toBe(realMembers[memberId]);
        if (mut.guardMustContain !== undefined) {
          // live-source binding: the mutation flowed into the runner-RENDERED SQL.
          expect(child.guardSql).toContain(mut.guardMustContain);
        }
      } finally {
        writeFileSync(file, original); // restore the real source unconditionally
        if (VIA_DIST) {
          // restore the shipped artifact to the pristine source as well.
          await execFileP('npx', ['tsc'], { cwd: API_ROOT, maxBuffer: 8 * 1024 * 1024, timeout: 300_000 });
        }
      }
    }
  }, VIA_DIST ? 1_800_000 : 600_000);
});
