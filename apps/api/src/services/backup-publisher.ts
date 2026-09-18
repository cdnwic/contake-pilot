/** Durable, race-safe backup publication (QA/security 2026-09-18 v7):
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
 *  On ANY failure: temp removed; a final file we created is removed too.
 *  NOTHING partial is ever left at the final path.
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

export async function publishBackupFile(
  file: string,
  lines: string[],
  opts: { auth: ArtifactAuth },
  opsOverride?: Partial<PublishOps>,
): Promise<number> {
  const ops: PublishOps = { ...defaultOps, ...opsOverride };
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const dir = dirname(file);
  let finalCreated = false;
  try {
    const fh = await ops.openTmp(tmp);
    try {
      await fh.writeFile(lines.join('\n') + '\n', 'utf8');
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
    await ops.unlink(tmp).catch(() => undefined);
    if (finalCreated) await ops.unlink(file).catch(() => undefined);
    throw e;
  }
}
