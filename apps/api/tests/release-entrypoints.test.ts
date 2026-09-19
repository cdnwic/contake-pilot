/** SA3+SA4 canonical entrypoint enumeration (rulings 2026-09-19).
 *  SA4: the canonical gated entrypoint is the BUILT artifact
 *  (dist/migrations/migrate-cli.js), invoked via the package script
 *  (`migrate:release` -> `node dist/migrations/migrate-cli.js`). Verification
 *  is ENUMERATIVE and POSITIVE: the built entrypoint must EXIST, EXECUTE and
 *  GATE - absence-of-old-cli assertions prove nothing (SA4 section 2).
 *  CONTROL-CARRYOVER (SA4 section 3): an explicit control-list diff -
 *  every control of the deleted predecessor cli.ts is named and proven
 *  present in the replacement (source AND built artifact). */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const API_ROOT = path.resolve(__dirname, '..');
const DIST_CLI = path.join(API_ROOT, 'dist', 'migrations', 'migrate-cli.js');
const SRC_CLI = path.join(API_ROOT, 'src', 'migrations', 'migrate-cli.ts');
const RUNNER = path.join(API_ROOT, 'src', 'migrations', 'runner.ts');

const runDistCli = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [DIST_CLI, ...args], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...env } });

const walk = (dir: string, ext: string): string[] => {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, ext));
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
};

/** SA4 section 3: the predecessor control inventory (deleted
 *  src/migrations/cli.ts + the SA2/SA3 scripts/migrate.mts). Each control is
 *  proven present in the replacement by its implementation marker. */
const CONTROL_CARRYOVER: ReadonlyArray<readonly [string, RegExp]> = [
  ['closed parser (unknown/duplicate/bare/missing refused)', /parseCliArgs\(process\.argv\.slice\(2\)/],
  ['ONE deliberate URL source (flag XOR env)', /resolveDatabaseUrl\(args\['--database-url'\], process\.env\['DATABASE_URL'\]\)/],
  ['bounded actor label', /validateActor\(/],
  ['direct-endpoint assertion (pooled refused)', /assertDirectDatabaseUrl\(databaseUrl\)/],
  ['operator expected tuple REQUIRED flags', /required: \['--deployment', '--expect-host', '--expect-db'\]/],
  ['pre-connection URL tuple match (exit 2)', /TARGET TUPLE mismatch[\s\S]*?process\.exit\(2\)/],
  ['post-connection current_database() verification before issuance', /current_database\(\) AS db[\s\S]*?is not the expected/],
  ['pre-mutation target binding read-only', /verifyTargetPreconditions\(pool/],
  ['deployment allowlist staging|production', /\['staging', 'production'\]\.includes\(deployment\)/],
  ['issued-nonce preflight issuance first', /issueOperatorPreflight\(pool/],
  ['exit 75 without --ack (nothing executed)', /process\.exit\(75\)/],
  ['runner re-verifies/consumes the ack under lock', /runMigrations\(pool, \{\s*deployment, appliedBy, operatorAck: ack,/],
  ['attended --resolve-dirty mode', /attendedResolveDirty\(pool, \{ note: resolveNote/],
  ['TOFU stamp printed for out-of-band verification (not authentication)', /trust-on-first-use/],
  ['pins threaded into BOTH issuance and run', /expectInstanceId: args\['--expect-instance-id'\], expectRegistryDigest: args\['--expect-registry-digest'\],?\s*\}\)/],
];

describe('SA4 canonical BUILT entrypoint', () => {
  it('package scripts: migrate:release invokes the BUILT artifact (node dist); no source/tsx on the release path', () => {
    const pkg = JSON.parse(readFileSync(path.join(API_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['migrate:release']).toBe('node dist/migrations/migrate-cli.js');
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      expect(cmd, `script '${name}' must not invoke tsx/ts-node or a source migration entrypoint`).not.toMatch(/tsx\s+scripts|ts-node|migrations\/cli|migrate\.mts|users-phone-preflight/);
    }
  });

  it('POSITIVE: the built gated entrypoint EXISTS (run the package build first)', () => {
    expect(existsSync(SRC_CLI), 'src/migrations/migrate-cli.ts must exist (the build compiles it)').toBe(true);
    expect(existsSync(DIST_CLI), 'dist/migrations/migrate-cli.js missing - run `npm run build` (the release path executes the BUILT artifact)').toBe(true);
    expect(statSync(DIST_CLI).size).toBeGreaterThan(0);
  });

  it('POSITIVE: the built entrypoint EXECUTES and its closed parser refuses unknown/bare/duplicate/missing flags', () => {
    const base = ['--deployment', 'staging', '--expect-host', 'localhost', '--expect-db', 'x'];
    const unknownF = runDistCli([...base, '--bogus', 'v'], { DATABASE_URL: '' });
    expect(unknownF.status).not.toBe(0);
    expect(unknownF.stderr).toMatch(/unknown flag/);
    const bare = runDistCli([...base, 'positional'], { DATABASE_URL: '' });
    expect(bare.status).not.toBe(0);
    expect(bare.stderr).toMatch(/bare positional/);
    const dup = runDistCli([...base, '--expect-db', 'y'], { DATABASE_URL: '' });
    expect(dup.status).not.toBe(0);
    expect(dup.stderr).toMatch(/duplicate flag/);
    const missing = runDistCli(['--deployment', 'staging'], { DATABASE_URL: '' });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/required flag/);
  });

  it('POSITIVE: the built entrypoint GATES - direct-endpoint + expected tuple are enforced BEFORE any connection', () => {
    const pooled = runDistCli(['--deployment', 'staging', '--expect-host', 'h-pooler.x', '--expect-db', 'db', '--database-url', 'postgres://u:p@h-pooler.x/db']);
    expect(pooled.status).not.toBe(0);
    expect(pooled.stderr).toMatch(/POOLED endpoint refused/);
    const wrongHost = runDistCli(['--deployment', 'staging', '--expect-host', 'other-host', '--expect-db', 'db', '--database-url', 'postgres://u:p@localhost/db']);
    expect(wrongHost.status).toBe(2);
    expect(wrongHost.stderr).toMatch(/TARGET TUPLE mismatch/);
    const wrongDb = runDistCli(['--deployment', 'staging', '--expect-host', 'localhost', '--expect-db', 'other-db', '--database-url', 'postgres://u:p@localhost/db']);
    expect(wrongDb.status).toBe(2);
    expect(wrongDb.stderr).toMatch(/TARGET TUPLE mismatch/);
    const badLabel = runDistCli(['--deployment', 'test', '--expect-host', 'h', '--expect-db', 'd', '--database-url', 'postgres://u:p@h/d']);
    expect(badLabel.status).toBe(64);
  });

  it('CONTROL-CARRYOVER DIFF (SA4 s3): every predecessor control is present in the replacement - source AND built artifact', () => {
    const src = readFileSync(SRC_CLI, 'utf8');
    const dist = readFileSync(DIST_CLI, 'utf8');
    for (const [control, marker] of CONTROL_CARRYOVER) {
      expect(marker.test(src), `control '${control}' missing from src/migrations/migrate-cli.ts`).toBe(true);
      expect(marker.test(dist), `control '${control}' missing from dist/migrations/migrate-cli.js (built artifact)`).toBe(true);
    }
  });

  it('the ungated predecessor + source-invoked wrappers are DELETED from reach (source, scripts, built artifact)', () => {
    expect(existsSync(path.join(API_ROOT, 'src', 'migrations', 'cli.ts'))).toBe(false);
    expect(existsSync(path.join(API_ROOT, 'dist', 'migrations', 'cli.js'))).toBe(false);
    expect(existsSync(path.join(API_ROOT, 'scripts', 'migrate.mts'))).toBe(false);
    expect(existsSync(path.join(API_ROOT, 'scripts', 'users-phone-preflight.mts'))).toBe(false);
  });

  it('enumerative: EVERY shipped source that references runMigrations is on the gated allowlist', () => {
    const ALLOWLIST = new Set([
      path.join(API_ROOT, 'src', 'migrations', 'runner.ts'), // the definition itself
      path.join(API_ROOT, 'src', 'migrations', 'migrate-cli.ts'), // the ONE canonical gated entrypoint
    ]);
    const offenders: string[] = [];
    for (const f of [...walk(path.join(API_ROOT, 'src'), '.ts'), ...walk(path.join(API_ROOT, 'scripts'), '.mts')]) {
      const text = readFileSync(f, 'utf8');
      if (/\brunMigrations\b/.test(text) && !ALLOWLIST.has(f)) offenders.push(f);
    }
    expect(offenders.sort()).toEqual([]);
  });

  it('SA3 section 3: no caller-label gate exemption exists anywhere in shipped sources', () => {
    for (const f of [...walk(path.join(API_ROOT, 'src'), '.ts'), ...walk(path.join(API_ROOT, 'scripts'), '.mts')]) {
      const text = readFileSync(f, 'utf8');
      expect(text, `${f} must not carry a test-lane gate exemption`).not.toMatch(/!== 'test-harness'|=== 'test-harness'|deployment !== 'test'|deployment === 'test'/);
    }
  });

  it('dist-discipline: the BUILT runner carries the ack lifecycle and no exemption; dist CLI carries the gate', () => {
    const distRunner = path.join(API_ROOT, 'dist', 'migrations', 'runner.js');
    expect(existsSync(distRunner), 'dist/migrations/runner.js missing - run `npm run build`').toBe(true);
    const text = readFileSync(distRunner, 'utf8');
    expect(text).toContain('schema_migration_acks'); // the issued-nonce lifecycle IS in the artifact
    expect(text).not.toContain('test-harness');
    const distCliText = readFileSync(DIST_CLI, 'utf8');
    expect(distCliText).toContain('issueOperatorPreflight');
    expect(distCliText).toContain('OPERATOR GATE');
    expect(distCliText).toContain('GATE: no ack supplied');
  });

  it('documented commands resolve to the BUILT gated entrypoint', () => {
    const doc = readFileSync(path.join(API_ROOT, '..', '..', 'docs', 'release-migrations-v1.0.md'), 'utf8');
    expect(doc).toContain('node dist/migrations/migrate-cli.js');
    expect(doc).not.toContain('scripts/migrate.mts');
    expect(doc).not.toContain('users-phone-preflight.mts');
    expect(doc).not.toContain('tsx scripts');
  });
});

/** SA4-C1 section 2 + SA4-C3 (e): EXIT-PATH ENUMERATION. Mirrors the
 *  entrypoint enumeration: every post-admission exit must land in the ONE
 *  unified safety path, and ELIGIBLE may be written by exactly TWO sites
 *  (the clean-completion restore inside the final group transaction, and
 *  attendedResolveDirty). Behavioral proof per exit lives in
 *  users-phone-migration.test.ts (guard abort, evidence-writer failure,
 *  marker failure, restore failure, consume kill, restore kill, replay,
 *  expiry, recovery) and the realpg evidence. */
describe('SA4-C3 exit-path enumeration (static)', () => {
  it('exactly ONE unified post-abort safety path with exactly ONE call site', () => {
    const src = readFileSync(RUNNER, 'utf8');
    expect(src.split('async function unifiedPostAbortSafety').length - 1).toBe(1);
    expect(src.split('await unifiedPostAbortSafety(').length - 1).toBe(1);
    // the old split paths are gone: no direct markTargetDirtyVerified call
    // outside the unified path.
    expect(src.split('await markTargetDirtyVerified(').length - 1).toBe(1);
  });
  it('ELIGIBLE is written by exactly TWO sites (clean completion + attended recovery) - no exit restores early', () => {
    const src = readFileSync(RUNNER, 'utf8');
    expect(src.split('SET eligible = true').length - 1).toBe(2);
    expect(src.split('eligible = false').length - 1).toBe(1); // the admission consume only
  });
  it('no expiry path grants eligibility: runner source contains no TTL-based restore', () => {
    const src = readFileSync(RUNNER, 'utf8');
    expect(src).not.toMatch(/eligible = true[^;]*interval/i);
    expect(src).toContain('expiry NEVER grants');
  });
});
