/** Durable, race-safe backup publication (QA/security 2026-09-18 v8):
 *  NO-CLOBBER ONLY - overwrite support was REMOVED entirely (security
 *  preference: no indeterminate post-fsync/rollback semantics, no
 *  ambiguous failed-new state). Replacing an artifact is a deliberate
 *  operator act: remove the old file manually after approval, then
 *  publish fresh.
 *  1. temp-write with 0600 + fsync
 *  2. INDEPENDENT readback validation of the TEMP bytes (structure +
 *     digests + manifest + MAC + createdAt canon) BEFORE anything
 *     publishes
 *  3. publish via atomic hard-link(2): FAILS EEXIST if the destination
 *     exists or appears (race-safe; this IS the TOCTOU guard - the
 *     existence check and the publication are one atomic syscall)
 *  4. fsync the CONTAINING DIRECTORY (tolerating platforms without it)
 *  On ANY failure the cleanup is RECONCILED (security v8): everything we
 *  created is unlinked, the cleanup directory is fsynced, and the
 *  post-cleanup state is probed. When durable absence of a created file
 *  CANNOT be proved, a PublishIndeterminateError with an explicit
 *  reconciliation status is thrown instead of a plain failure - the
 *  operator must inspect and reconcile the named path.
 *  I/O ops are injectable for failure-injection tests. */
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { open, link, unlink, readFile } from 'node:fs/promises';
import type { ArtifactAuth } from './phone-migration.js';
import { validateBackupArtifact } from './phone-migration.js';

export interface PublishOps {
  openTmp(path: string): Promise<import('node:fs/promises').FileHandle>;
  link(src: string, dst: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
  fsyncDir(dir: string): Promise<void>;
}

const defaultOps: PublishOps = {
  openTmp: (p) => open(p, 'wx', 0o600),
  link,
  unlink,
  readFile: (p) => readFile(p, 'utf8'),
  fsyncDir: async (dir) => {
    const dh = await open(dir, 'r');
    try { await dh.sync(); } finally { await dh.close(); }
  },
};

const fsyncDirTolerant = async (ops: PublishOps, dir: string): Promise<void> => {
  try { await ops.fsyncDir(dir); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EPERM') throw e; // unsupported platforms only
  }
};

/** Explicit INDETERMINATE status (security v8): raised when a failure
 *  left the publication outcome unprovable - e.g. the final link landed
 *  but the directory fsync failed, or cleanup could not prove durable
 *  absence. Carries the reconciled post-cleanup state so an operator can
 *  resolve it by hand. */
export interface PublishReconciliation {
  finalCreated: boolean;
  /** pre-cleanup: does a file exist at the final path (and do its bytes match the intended artifact)? */
  finalExisted: boolean | 'unknown';
  finalContentVerified: boolean | 'unknown';
  /** post-cleanup probes */
  finalAbsent: boolean;
  tmpAbsent: boolean;
  cleanupDirFsynced: boolean;
}

export class PublishIndeterminateError extends Error {
  readonly code = 'PUBLISH_INDETERMINATE' as const;
  constructor(
    message: string,
    readonly reconciliation: PublishReconciliation,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PublishIndeterminateError';
  }
}

const probeAbsent = async (ops: PublishOps, path: string): Promise<boolean> => {
  try { await ops.readFile(path); return false; }
  catch { return true; }
};

export async function publishBackupFile(
  file: string,
  lines: string[],
  opts: { auth: ArtifactAuth },
  opsOverride?: Partial<PublishOps>,
): Promise<number> {
  const ops: PublishOps = { ...defaultOps, ...opsOverride };
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const dir = dirname(file);
  const expectedBytes = lines.join('\n') + '\n';
  let finalCreated = false;
  try {
    const fh = await ops.openTmp(tmp);
    try {
      await fh.writeFile(expectedBytes, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    // validate the TEMP bytes independently BEFORE publish
    const back = (await ops.readFile(tmp)).split('\n').filter(Boolean);
    const validated = validateBackupArtifact(back, opts.auth);
    await ops.link(tmp, file); // ATOMIC no-clobber: EEXIST if destination appeared
    finalCreated = true;
    await ops.unlink(tmp);
    await fsyncDirTolerant(ops, dir);
    return validated.header.rowCount;
  } catch (e) {
    // ---- reconcile (security v8) ----
    const rec: PublishReconciliation = {
      finalCreated, finalExisted: 'unknown', finalContentVerified: 'unknown',
      finalAbsent: true, tmpAbsent: true, cleanupDirFsynced: false,
    };
    if (finalCreated) {
      try {
        rec.finalExisted = true;
        rec.finalContentVerified = (await ops.readFile(file)) === expectedBytes;
      } catch { rec.finalExisted = false; }
    }
    await ops.unlink(tmp).catch(() => undefined);
    if (finalCreated) await ops.unlink(file).catch(() => undefined);
    rec.tmpAbsent = await probeAbsent(ops, tmp);
    if (finalCreated) rec.finalAbsent = await probeAbsent(ops, file);
    try { await fsyncDirTolerant(ops, dir); rec.cleanupDirFsynced = true; } catch { /* durability of absence unproven */ }
    if (rec.tmpAbsent && rec.finalAbsent && rec.cleanupDirFsynced) throw e; // clean: nothing left, absence durable
    throw new PublishIndeterminateError(
      `backup publication outcome INDETERMINATE at ${file}: operator reconciliation required ` +
      `(finalCreated=${rec.finalCreated}, finalExisted=${rec.finalExisted}, finalContentVerified=${rec.finalContentVerified}, ` +
      `finalAbsentAfterCleanup=${rec.finalAbsent}, tmpAbsentAfterCleanup=${rec.tmpAbsent}, cleanupDirFsynced=${rec.cleanupDirFsynced})`,
      rec,
      { cause: e },
    );
  }
}
