/** Durable, race-safe backup publication (QA 2026-09-18 v6):
 *  1. temp-write with 0600 + fsync
 *  2. INDEPENDENT readback validation of the TEMP bytes (structure +
 *     digests + manifest + MAC) BEFORE anything publishes
 *  3. publish:
 *     - no-clobber (default): hard-link(2) - ATOMIC and FAILS if the
 *       destination appeared (race-safe), then unlink temp
 *     - explicit overwrite: rename(2) atomic-replace (validation already
 *       done, so the post-rename failure surface is only the dir fsync)
 *  4. fsync the CONTAINING DIRECTORY (tolerating platforms without it)
 *  On ANY failure: temp removed; in the no-clobber path a final file we
 *  created is removed too. NOTHING partial is ever left at the final
 *  path. I/O ops are injectable for failure-injection tests. */
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { open, link, rename, unlink, readFile } from 'node:fs/promises';
import type { ArtifactAuth } from './phone-migration.js';
import { validateBackupArtifact } from './phone-migration.js';

export interface PublishOps {
  openTmp(path: string): Promise<import('node:fs/promises').FileHandle>;
  link(src: string, dst: string): Promise<void>;
  rename(src: string, dst: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
  fsyncDir(dir: string): Promise<void>;
}

const defaultOps: PublishOps = {
  openTmp: (p) => open(p, 'wx', 0o600),
  link,
  rename,
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
  opts: { overwrite: boolean; auth: ArtifactAuth },
  opsOverride?: Partial<PublishOps>,
): Promise<number> {
  const ops: PublishOps = { ...defaultOps, ...opsOverride };
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const dir = dirname(file);
  let finalCreated = false;
  const cleanup = async () => {
    await ops.unlink(tmp).catch(() => undefined);
    if (finalCreated && !opts.overwrite) await ops.unlink(file).catch(() => undefined);
  };
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
    if (opts.overwrite) {
      await ops.rename(tmp, file); // atomic replace; temp is consumed by rename
    } else {
      await ops.link(tmp, file); // ATOMIC no-clobber: EEXIST if destination appeared
      finalCreated = true;
      await ops.unlink(tmp);
    }
    await fsyncDirTolerant(ops, dir);
    return validated.header.rowCount;
  } catch (e) {
    await cleanup();
    throw e;
  }
}
