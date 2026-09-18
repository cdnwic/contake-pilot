/** SA2 ruling (2026-09-19) - constructive digest-preimage tamper matrix.
 *  The effective preimage is the EXPLICIT canonical manifest (BLUEPRINT_MANIFEST,
 *  hashes-only, confinement preserved): every artifact with executable
 *  semantics - templates, named expressions, named predicates, named
 *  normalizations, frozen baselines - has exactly one entry. This suite proves
 *  per-member sensitivity (tampering ANY single member moves REGISTRY_DIGEST),
 *  pins the member inventory, and proves the btrim->ltrim normalization
 *  substitution (QA finding a) is digest-visible by construction.
 *  Mine (implementation-side). Named structures are module-private by R4
 *  confinement; live-source binding goes through the exported pure review
 *  seams (digestManifestForReview / manifestMemberHashForReview) and the
 *  runner-rendered guard SQL. */
import { describe, expect, it } from 'vitest';
import {
  BLUEPRINT_MANIFEST, REGISTRY_DIGEST, buildAssertionQuery,
  digestManifestForReview, manifestMemberHashForReview,
  type BlueprintManifestEntry,
} from '../src/migrations/runner.js';

/** The pinned member inventory: ANY member added/removed/renamed in source
 *  without updating this test fails loudly here (drift alarm). */
const EXPECTED_INVENTORY = [
  'frozen-baseline:0001-baseline',
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

const mutate = (fn: (e: BlueprintManifestEntry, i: number) => BlueprintManifestEntry): BlueprintManifestEntry[] =>
  BLUEPRINT_MANIFEST.map((e, i) => fn(e, i));

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

  it('constructive per-member tamper matrix: flipping ANY single member content hash moves the digest', () => {
    const base = digestManifestForReview(BLUEPRINT_MANIFEST);
    for (let i = 0; i < BLUEPRINT_MANIFEST.length; i += 1) {
      const tampered = mutate((e, j) => j === i ? { ...e, contentHash: 'f'.repeat(64) } : e);
      expect(digestManifestForReview(tampered), `member ${BLUEPRINT_MANIFEST[i]!.role}:${BLUEPRINT_MANIFEST[i]!.id}`).not.toBe(base);
    }
  });

  it('PINNED REGRESSION (QA finding a): btrim -> ltrim substitution in the guard normalization MUST move the digest', () => {
    const raw = liveGuardNormalization();
    const ltrimVariant = raw.replaceAll('btrim', 'ltrim');
    const id = 'normalizations.NORM_COL_BTRIM_NULLIF_EMPTY';
    const entry = BLUEPRINT_MANIFEST.find(e => e.id === id)!;
    const tamperedHash = manifestMemberHashForReview(entry.role, entry.id, ltrimVariant);
    expect(tamperedHash).not.toBe(entry.contentHash); // the substitution changes the member hash
    const tampered = mutate(e => e.id === id ? { ...e, contentHash: tamperedHash } : e);
    expect(digestManifestForReview(tampered)).not.toBe(REGISTRY_DIGEST); // and therefore the digest
  });

  it('structural tamper moves the digest: member removed, added, or reordered', () => {
    const base = digestManifestForReview(BLUEPRINT_MANIFEST);
    expect(digestManifestForReview(BLUEPRINT_MANIFEST.slice(1))).not.toBe(base);
    expect(digestManifestForReview([...BLUEPRINT_MANIFEST, { role: 'named-predicate', id: 'predicates.EVIL', contentHash: '0'.repeat(64) }])).not.toBe(base);
    expect(digestManifestForReview([...BLUEPRINT_MANIFEST].reverse())).not.toBe(base);
  });

  it('manifest is frozen and detached (hashes only; no render content leaves the module)', () => {
    expect(Object.isFrozen(BLUEPRINT_MANIFEST)).toBe(true);
    for (const e of BLUEPRINT_MANIFEST) {
      expect(Object.isFrozen(e)).toBe(true);
      expect(Object.keys(e).sort()).toEqual(['contentHash', 'id', 'role']);
    }
  });
});
