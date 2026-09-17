import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { listProfiles, getProfile, hasProfile } from './profiles';

// Pins recorded in R3-DIVERGENCE-LEDGER.md (TL profiles divergence ruling v1.0, parent 11:43 2026-09-17).
const RECOVERED_SNAPSHOT_SHA256 = '4e9b1d48c9e1fdef3d38f560f6d51b6f1d62ae289c072e34c070a1f9f1a5ca52';
const CANONICAL_PARITY_SHA256 = '6716b5aa621f52b163dae9c75bd1c0d3c55d7d956903ebb1803cf91592ad5fd8';
const RECOVERED_IDS = ['camp', 'event-production', 'film-shoot', 'conference', 'logistics', 'after-school'];
const CANONICAL_IDS = [...RECOVERED_IDS, 'education'];

const here = dirname(fileURLToPath(import.meta.url));
const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

describe('profiles divergence ruling v1.0 (additive parity alignment)', () => {
  it('recovered 6-profile snapshot is preserved byte-identical (no silent patch)', () => {
    const p = join(here, '../contracts/domain-profiles.v1.json');
    expect(sha256(p)).toBe(RECOVERED_SNAPSHOT_SHA256);
    const ids = (JSON.parse(readFileSync(p, 'utf8')).profiles ?? []).map((x: { id: string }) => x.id);
    expect(ids).toEqual(RECOVERED_IDS);
    expect(ids).not.toContain('education');
  });

  it('canonical parity layer carries all 7 profiles including education', () => {
    expect(listProfiles().map((p) => p.id)).toEqual(CANONICAL_IDS);
    expect(hasProfile('education')).toBe(true);
    expect(getProfile('education').id).toBe('education');
  });

  it('parity layer file is byte-identical to canonical profiles.v1.json @ origin/main 23364c1d', () => {
    expect(sha256(join(here, 'profiles.v1.json'))).toBe(CANONICAL_PARITY_SHA256);
  });
});
