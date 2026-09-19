/** SA3 constructive-tamper child process: loads the (possibly in-place
 *  mutated) REAL runner module at its REAL source location and reports its
 *  SELF-COMPUTED registry digest, per-member content hashes, and the
 *  runner-rendered guard SQL (live-source binding through the real renderer). */
import {
  BLUEPRINT_MANIFEST, REGISTRY_DIGEST, buildAssertionQuery,
} from '../../src/migrations/runner.js';

const guardSql = buildAssertionQuery({ kind: 'no-duplicates', table: 'users', column: 'phone', normalize: 'btrim-nullif-empty', skipNulls: true });
console.log(JSON.stringify({
  digest: REGISTRY_DIGEST,
  members: Object.fromEntries(BLUEPRINT_MANIFEST.map(e => [e.id, e.contentHash])),
  guardSql,
}));
