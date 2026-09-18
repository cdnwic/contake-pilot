/** Durable race-safe backup publication + canonical MAC key canon
 *  (QA/security 2026-09-18 v6). ALL LANES (filesystem + pure functions,
 *  no DB). */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { publishBackupFile, type PublishOps } from '../src/services/backup-publisher.js';
import { generateBackupMacKey, parseBackupEnv, parseBackupKeyId, parseBackupMacKey } from '../src/services/phone-migration.js';
import type { ArtifactAuth } from '../src/services/phone-migration.js';

/** Build a real, valid artifact through the live machinery (no DB needed:
 *  digests+manifest+MAC are pure). */
const makeLines = async (auth: ArtifactAuth, row = { user_id: 'u-1', org_id: 'o-1', email: null as string | null, phone: '+15550100001', data: { name: 'u-1' } }) => {
  const { rowDigest, manifestDigest, artifactMac } = await import('../src/services/phone-migration.js');
  const digests = [rowDigest(row)];
  const base = { type: 'users-phone-backup-header' as const, version: 2 as const, createdAt: new Date().toISOString(), rowCount: 1, usersPhoneUniqueIndex: { existed: false, definition: null } };
  const sans = { ...base, manifestSha256: manifestDigest(base, digests), backupId: `bkp-${base.createdAt}-abcd1234`, keyId: auth.keyId, env: auth.env };
  const rows = [{ ...row, rowSha256: digests[0]! }];
  return [JSON.stringify({ ...sans, macSha256: artifactMac(auth.key, sans, rows) }), JSON.stringify(rows[0])];
};
const auth = (): ArtifactAuth => ({ key: generateBackupMacKey(), keyId: 'test-key-v1', env: 'test-deploy-01' });

describe('canonical MAC key + bounded ids (v6)', () => {
  it('accepts 64 lowercase hex / 32 strong bytes; generator output always valid', () => {
    for (let i = 0; i < 8; i++) parseBackupMacKey(generateBackupMacKey());
    expect(parseBackupMacKey('a'.repeat(63) + 'b').length).toBe(32);
  });
  it('rejects non-canonical forms: uppercase, wrong length, non-hex, empty', () => {
    expect(() => parseBackupMacKey('A'.repeat(64))).toThrow(/64 lowercase hex/);
    expect(() => parseBackupMacKey('ab12')).toThrow(/64 lowercase hex/);
    expect(() => parseBackupMacKey('g'.repeat(64))).toThrow(/64 lowercase hex/);
    expect(() => parseBackupMacKey('')).toThrow(/64 lowercase hex/);
  });
  it('rejects weak/predictable/repeated/known values by CLASS, never echoing the value', () => {
    expect(() => parseBackupMacKey('00'.repeat(32))).toThrow(/repeated single byte/);
    expect(() => parseBackupMacKey('ff'.repeat(32))).toThrow(/repeated single byte/);
    expect(() => parseBackupMacKey('abcd'.repeat(16))).toThrow(/repeated \d+-byte block/);
    expect(() => parseBackupMacKey('deadbeef'.repeat(8))).toThrow(/repeated \d+-byte block/);
    expect(() => parseBackupMacKey('a1b2'.repeat(16))).toThrow(/repeated \d+-byte block/);
    expect(() => parseBackupMacKey('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')).toThrow(/repeated \d+-byte block|sequential|known-weak/);
    // strictly ascending run with non-repeating 16-byte halves
    expect(() => parseBackupMacKey('00020406080a0c0e10121416181a1c1e20222426282a2c2e30323436383a3c3e')).toThrow(/sequential byte run/);
    expect(() => parseBackupMacKey('5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8')).toThrow(/known-weak/); // sha256('password')
    for (const bad of ['00'.repeat(32), 'abcd'.repeat(16)]) {
      try { parseBackupMacKey(bad); expect.unreachable(); }
      catch (e) { expect((e as Error).message).not.toContain(bad.slice(0, 8)); } // never logs the key
    }
  });
  it('bounded canonical keyId; unique deployment env IDs (generic labels refused)', () => {
    expect(parseBackupKeyId('bkp-2026-09-v1')).toBe('bkp-2026-09-v1');
    expect(() => parseBackupKeyId('UPPER')).toThrow(/keyId/);
    expect(() => parseBackupKeyId('x'.repeat(33))).toThrow(/keyId/);
    expect(() => parseBackupKeyId('-lead')).toThrow(/keyId/);
    expect(parseBackupEnv('contake-prod-pg-01')).toBe('contake-prod-pg-01');
    for (const generic of ['production', 'staging', 'development', 'test']) {
      expect(() => parseBackupEnv(generic), generic).toThrow(/UNIQUE deployment\/database ID/);
    }
    expect(() => parseBackupEnv('Has Spaces')).toThrow(/deployment\/database ID/);
  });
});

describe('durable race-safe publication (v6)', () => {
  it('publishes: temp 0600 + fsync + temp readback validation + atomic no-clobber link + dir fsync; valid final file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pub-'));
    const file = join(dir, 'b.jsonl');
    const a = auth();
    const lines = await makeLines(a);
    let dirFsynced = '';
    const n = await publishBackupFile(file, lines, { overwrite: false, auth: a }, { fsyncDir: async d => { dirFsynced = d; } });
    expect(n).toBe(1);
    expect(dirFsynced).toBe(dir);
    const { statSync } = await import('node:fs');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe(lines.join('\n') + '\n');
    expect(readdirSync(dir).filter(f => f.includes('.tmp-')).length).toBe(0);
  });

  it('RACE: two concurrent no-clobber publishes -> exactly one wins, no temp left, loser errors EEXIST', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pub-race-'));
    const file = join(dir, 'b.jsonl');
    const a = auth();
    const [r1, r2] = await Promise.allSettled([
      publishBackupFile(file, await makeLines(a), { overwrite: false, auth: a }),
      publishBackupFile(file, await makeLines(a), { overwrite: false, auth: a }),
    ]);
    const outcomes = [r1, r2].map(r => r.status);
    expect(outcomes.sort()).toEqual(['fulfilled', 'rejected']);
    const rej = [r1, r2].find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect((rej.reason as NodeJS.ErrnoException).code).toBe('EEXIST');
    expect(readdirSync(dir).filter(f => f.includes('.tmp-')).length).toBe(0);
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean).length).toBe(2);
  });

  it('injected validation failure: temp validated BEFORE publish -> NO final, temp cleaned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pub-val-'));
    const file = join(dir, 'b.jsonl');
    const a = auth();
    const bad = ['{"type":"users-phone-backup-header","version":2}', '{"user_id":"u-1"}'];
    await expect(publishBackupFile(file, bad, { overwrite: false, auth: a })).rejects.toThrow();
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir).filter(f => f.includes('.tmp-')).length).toBe(0);
  });

  it('injected link (rename) failure: temp cleaned, final absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pub-link-'));
    const file = join(dir, 'b.jsonl');
    const a = auth();
    const lines = await makeLines(a);
    await expect(publishBackupFile(file, lines, { overwrite: false, auth: a }, { link: async () => { throw new Error('injected link failure'); } })).rejects.toThrow(/injected link failure/);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir).filter(f => f.includes('.tmp-')).length).toBe(0);
  });

  it('crash boundary: failure between temp-validate and publish leaves NEITHER temp nor final', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pub-crash-'));
    const file = join(dir, 'b.jsonl');
    const a = auth();
    const lines = await makeLines(a);
    // crash right at the publish primitive
    await expect(publishBackupFile(file, lines, { overwrite: false, auth: a }, {
      link: async () => { const e = new Error('simulated crash') as NodeJS.ErrnoException; e.code = 'EIO'; throw e; },
    })).rejects.toThrow(/simulated crash/);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir).length).toBe(0);
  });

  it('no-clobber refuses an existing destination even with valid content; overwrite atomically replaces and keeps old on failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pub-ow-'));
    const file = join(dir, 'b.jsonl');
    writeFileSync(file, 'OLD-CONTENT');
    const a = auth();
    const lines = await makeLines(a);
    await expect(publishBackupFile(file, lines, { overwrite: false, auth: a })).rejects.toThrow(/EEXIST/);
    expect(readFileSync(file, 'utf8')).toBe('OLD-CONTENT');
    // overwrite path: injected rename failure keeps the OLD content, temp cleaned
    await expect(publishBackupFile(file, lines, { overwrite: true, auth: a }, { rename: async () => { throw new Error('injected rename failure'); } })).rejects.toThrow(/injected rename failure/);
    expect(readFileSync(file, 'utf8')).toBe('OLD-CONTENT');
    expect(readdirSync(dir).filter(f => f.includes('.tmp-')).length).toBe(0);
    // real overwrite succeeds
    await publishBackupFile(file, lines, { overwrite: true, auth: a });
    expect(readFileSync(file, 'utf8')).toBe(lines.join('\n') + '\n');
  });

  it('dir fsync unsupported-platform codes are tolerated; other dir fsync errors surface (no-clobber final cleaned)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pub-fsync-'));
    const file = join(dir, 'b.jsonl');
    const a = auth();
    const lines = await makeLines(a);
    await publishBackupFile(file, lines, { overwrite: false, auth: a }, { fsyncDir: async () => { const e = new Error('x') as NodeJS.ErrnoException; e.code = 'EINVAL'; throw e; } });
    expect(existsSync(file)).toBe(true);
    const file2 = join(dir, 'c.jsonl');
    await expect(publishBackupFile(file2, lines, { overwrite: false, auth: a }, { fsyncDir: async () => { const e = new Error('disk gone') as NodeJS.ErrnoException; e.code = 'EIO'; throw e; } })).rejects.toThrow(/disk gone/);
    expect(existsSync(file2)).toBe(false);
    expect(readdirSync(dir).filter(f => f.includes('.tmp-')).length).toBe(0);
  });

  it('random sanity: generated keys differ across calls', () => {
    expect(generateBackupMacKey()).not.toBe(generateBackupMacKey());
    expect(randomBytes(4).length).toBe(4);
  });
});
