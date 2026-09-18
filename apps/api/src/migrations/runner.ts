/** Release-migration runner (architecture convergence 2026-09-18; unified
 *  declarative redesign after QA FAILs of f9854cd6/9182487e/22267edb and the
 *  security verdicts + TL reconciliation of 2026-09-18).
 *
 *  ONE shared runner owns ALL schema evolution:
 *  - DECLARATIVE SQL ARTIFACTS ONLY. A migration is frozen TEXT: { version,
 *    name, description, sql } plus runner-owned declarative guard primitives.
 *    There are NO function steps, NO DO/CALL/PLpgSQL, NO arbitrary raw-query
 *    capability anywhere in the framework - code execution inside migrations
 *    is not a feature that exists.
 *  - EXACT EXECUTED+HASHED BINDING. The digest hashes the artifact text; the
 *    ONLY statements executed are the parse of that exact text (nothing else
 *    can be in it - trailing garbage fails the parse). Execution runs the
 *    parsed statements of the hashed text, one per driver call.
 *  - REAL-PARSER AST ALLOWLIST (not regex). Every artifact parses with a real
 *    PostgreSQL parser (pgsql-ast-parser); only declarative DDL+DML statement
 *    types are permitted (create/alter/drop table+index, insert,
 *    update, delete). Transaction control, SELECT/CALL/DO, session advisory
 *    functions and anything unparseable (SAVEPOINT/SET/LOCK syntax) are
 *    rejected at registration - quoting, schema-qualification and comment
 *    tricks resolve to the same AST and cannot bypass it.
 *  - RUNNER-OWNED GUARD PRIMITIVES (TL reconciliation): assertions (named
 *    zero-row SELECT guards that HARD-FAIL inside the runner transaction),
 *    table locks, and the xact advisory lock are declared as structured step
 *    fields and executed BY THE RUNNER - they never live in migration text.
 *  - PER-STEP TRANSACTION on ONE leased client: BEGIN, primitives, artifact
 *    statements, version INSERT (rowCount must be exactly 1), COMMIT; any
 *    failure rolls the whole step back. Partial DDL can never persist.
 *  - WHOLE-RUN SERIALIZATION: one session-level pg_advisory_lock held on the
 *    leased client across bootstrap + every step; concurrent runners
 *    serialize and the loser no-ops.
 *  - APPLIED-STEP INTEGRITY: schema_migrations stores version+name+sha256
 *    (digest over the exact artifact + declared primitives). Runner and boot
 *    gate require exact equality for every applied step. NEVER edit a shipped
 *    migration - a change is a new version.
 *  - PRE-MUTATION TARGET BINDING: verifyTargetPreconditions (deployment label
 *    + optional instance pin) runs read-only BEFORE any write; the first-run
 *    stamp is an operator-attended TOFU gate, never authentication.
 *  - BOOT GATE: assertSchemaCurrent fails closed unless version sequence,
 *    digests and (when provided) deployment + instance identity match.
 *  - ROLE SEPARATION (Neon dual-URL): direct schema-owner endpoint only;
 *    '-pooler' hosts are refused. */
import { createHash, randomBytes } from 'node:crypto';
import { parse as parseSql, toSql } from 'pgsql-ast-parser';
import { GRAPH_DDL, OTP_DDL, type Connectable, type Queryable } from '../repo/postgres.js';

/** A runner-owned NAMED guard primitive (independent security, 2026-09-18):
 *  NO caller SQL anywhere - the guard's SQL is generated entirely by the
 *  runner from validated identifiers and closed operator sets. Callers pick a
 *  kind and name tables/columns; expressions, functions and subqueries are
 *  not representable, so no side-effecting call can ride in. Each guard must
 *  return NO rows; any returned row hard-fails the step (full rollback). */
export type MigrationAssertion =
  | { readonly kind: 'table-empty'; readonly table: string }
  | { readonly kind: 'no-nulls'; readonly table: string; readonly column: string }
  | { readonly kind: 'no-duplicates'; readonly table: string; readonly column: string; readonly normalize?: 'btrim' | 'none'; readonly skipNulls?: boolean };

/** Declarative migration step: frozen SQL text + declared primitives. */
export interface MigrationStep {
  /** Zero-padded, strictly increasing ('0001', '0002', ...). */
  readonly version: string;
  readonly name: string;
  readonly description: string;
  /** The EXACT SQL text: parsed, allowlisted, executed and hashed. Frozen
   *  once shipped - editing it is a new migration version. */
  readonly sql: string;
  /** Runner-executed zero-row guards (hard-fail), evaluated BEFORE sql. */
  readonly assertions?: readonly MigrationAssertion[];
  /** Runner-executed `LOCK TABLE <t> IN SHARE ROW EXCLUSIVE MODE` before sql. */
  readonly lockTables?: readonly string[];
  /** Runner-executed pg_advisory_xact_lock(key) first (step-scoped). */
  readonly xactLockKey?: number;
}

/** Declarative statement types permitted in migration artifacts (TL
 *  reconciliation: DDL+DML only - no DO/CALL/SELECT/functions/tx-control). */
const ARTIFACT_ALLOWLIST: ReadonlySet<string> = new Set([
  'create table', 'create index', 'alter table', 'drop table', 'drop index',
  'insert', 'update', 'delete',
]);

/** SEMANTIC LAYER (TL architecture ruling + security closures, 2026-09-18 -
 *  replaces every syntactic name allowlist):
 *  1. The migration session runs with search_path PINNED EMPTY; pg_catalog is
 *     implicitly searched first, so unqualified built-ins resolve to
 *     pg_catalog and NOTHING ELSE can be shadowed in.
 *  2. Every artifact identifier is canonically FULLY QUALIFIED by the runner:
 *     relation names to the controlled schema 'public', function calls to
 *     'pg_catalog'. A caller-supplied schema other than the controlled one
 *     (attacker.lower, public.btrim for a function) is REFUSED - resolution
 *     is provably impossible outside {public, pg_catalog}.
 *  3. RECURSIVELY CLOSED shapes: no WITH/CTEs anywhere, no nested SELECT
 *     (subqueries) anywhere, no code/object-bearing statements (function/
 *     procedure/operator/cast/trigger/rule/aggregate/type/DO/CALL/COPY /
 *     owner/security-definer) - the statement allowlist plus an explicit
 *     ALTER-action allowlist close these.
 *  4. Runner-owned CATALOG SNAPSHOTS before/after every step assert ZERO
 *     delta of functions/operators/casts/triggers/rules; any delta rolls the
 *     step back. Execution is digest-bound to the canonical qualified
 *     serialization that actually runs. */
const CONTROLLED_SCHEMA = 'public';
const CATALOG_SCHEMA = 'pg_catalog';

/** Exact-shape name node: {name: string} or {name, schema} and nothing else. */
const isNameNode = (o: Record<string, unknown>): boolean => {
  const keys = Object.keys(o).sort();
  return typeof o['name'] === 'string' &&
    (keys.length === 1 || (keys.length === 2 && keys[1] === 'schema' && typeof o['schema'] === 'string'));
};

/** ALTER TABLE actions that remain declarative schema evolution. OWNER,
 *  SET SCHEMA, trigger/constraint-creation of code objects and everything
 *  else is refused. */
const ALTER_ACTION_ALLOWLIST: ReadonlySet<string> = new Set([
  'add column', 'drop column', 'alter column', 'rename column',
  'add constraint', 'drop constraint', 'rename constraint', 'rename table',
]);

function artifactRefusal(why: string): never {
  throw new Error(`release-migrations: ARTIFACT refusal - ${why}`);
}

/** Qualifies one relation name node to the controlled schema (fail-closed). */
function qualifyRelation(n: unknown, ctx: string): void {
  if (!n || typeof n !== 'object' || !isNameNode(n as Record<string, unknown>)) {
    artifactRefusal(`unexpected relation shape in ${ctx} (closed AST shapes only)`);
  }
  const o = n as { name: string; schema?: string };
  const schema = o.schema ?? CONTROLLED_SCHEMA;
  if (schema !== CONTROLLED_SCHEMA) {
    artifactRefusal(`relation "${schema}"."${o.name}" in ${ctx} is outside the controlled schema '${CONTROLLED_SCHEMA}' - every identifier must resolve to ${CONTROLLED_SCHEMA} (search_path is pinned empty)`);
  }
  o.schema = CONTROLLED_SCHEMA;
}

/** Recursively closes expression shapes and qualifies every function call to
 *  pg_catalog. Refuses CTEs, nested SELECTs/subqueries and any non-pg_catalog
 *  call target (attacker.lower can never resolve). */
function closeExpressions(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) closeExpressions(n); return; }
  const o = node as Record<string, unknown>;
  if (o['type'] === 'select') artifactRefusal('nested SELECT/subquery is not a permitted artifact shape');
  if (o['with'] !== undefined) artifactRefusal('WITH/CTE is not a permitted artifact shape');
  if (o['securityDefiner'] !== undefined || o['security'] !== undefined) artifactRefusal('SECURITY DEFINER is not a permitted artifact shape');
  if (o['type'] === 'call') {
    const fn = o['function'] as Record<string, unknown>;
    if (!fn || !isNameNode(fn)) artifactRefusal('unexpected function-call shape (closed AST shapes only)');
    const f = fn as { name: string; schema?: string };
    const schema = f.schema ?? CATALOG_SCHEMA;
    if (schema !== CATALOG_SCHEMA) {
      artifactRefusal(`function call "${schema}"."${f.name}" targets a non-pg_catalog schema - with search_path pinned empty only pg_catalog functions can resolve`);
    }
    f.schema = CATALOG_SCHEMA;
  }
  for (const [k, v] of Object.entries(o)) {
    if (k === 'name' || k === 'schema') continue; // handled at their owning nodes
    closeExpressions(v);
  }
}

/** Canonicalizes one parsed statement: closed shapes + fully qualified
 *  identifiers, in place. The re-serialized result is what executes AND what
 *  the digest binds. */
function canonicalizeStatement(st: Record<string, unknown>): void {
  const t = String(st['type']);
  if (!ARTIFACT_ALLOWLIST.has(t)) {
    artifactRefusal(`statement type '${t}' is not declarative DDL+DML (allowed: ${[...ARTIFACT_ALLOWLIST].join(', ')}; code/object-bearing statements, transaction control, SELECT/CALL/DO and locks are runner-owned or forbidden)`);
  }
  // CTL-DDL-CONFINEMENT condition 1: rollback equals prevention ONLY inside
  // one transaction - every non-transactional class is refused outright.
  if (st['concurrently']) {
    artifactRefusal(`'${t} CONCURRENTLY' is non-transactional - it cannot roll back, so it can never run inside a governed step`);
  }
  switch (t) {
    case 'create table': qualifyRelation(st['name'], 'CREATE TABLE'); break;
    case 'create index':
      qualifyRelation(st['table'], 'CREATE INDEX ... ON');
      break;
    case 'alter table': {
      qualifyRelation(st['table'], 'ALTER TABLE');
      const changes = st['changes'];
      if (!Array.isArray(changes)) artifactRefusal('unexpected ALTER TABLE shape');
      for (const a of changes as Record<string, unknown>[]) {
        if (!ALTER_ACTION_ALLOWLIST.has(String(a['type']))) {
          artifactRefusal(`ALTER TABLE action '${String(a['type'])}' is not in the closed declarative set (no OWNER/SET SCHEMA/code-object actions)`);
        }
      }
      break;
    }
    case 'drop table': for (const n of (st['names'] ?? []) as unknown[]) qualifyRelation(n, 'DROP TABLE'); break;
    case 'drop index': for (const n of (st['names'] ?? []) as unknown[]) qualifyRelation(n, 'DROP INDEX'); break;
    case 'insert': qualifyRelation(st['into'], 'INSERT INTO'); break;
    case 'update': qualifyRelation(st['table'], 'UPDATE'); break;
    case 'delete': qualifyRelation(st['from'], 'DELETE FROM'); break;
    default: break; // drop index carries no relation schema
  }
  closeExpressions(st);
}

/** Registration-time artifact gate + canonicalizer (one object): parses with
 *  the real parser (fail-closed on garbage), closes shapes recursively and
 *  fully qualifies every identifier. Returns the canonical executed
 *  serializations - one per driver call. Execution runs EXACTLY these and the
 *  digest hashes EXACTLY their join. */
export function artifactStatements(sql: string): string[] {
  let stmts: Record<string, unknown>[];
  try {
    stmts = parseSql(sql) as unknown as Record<string, unknown>[];
  } catch (e) {
    artifactRefusal(`unparsable SQL (fail-closed): ${(e as Error).message.split('\n')[0]}`);
  }
  if (stmts.length === 0) artifactRefusal('empty artifact');
  for (const st of stmts) canonicalizeStatement(st);
  return stmts.map(st => toSql.statement(st as never));
}
export const canonicalArtifactSql = (sql: string): string => artifactStatements(sql).join(';\n');
export function validateMigrationArtifact(sql: string): void {
  artifactStatements(sql); // throws on any refusal; validation IS canonicalization
}

/** Runner-owned CATALOG SNAPSHOT assertion (TL semantic layer): the identity
 *  set of user functions/operators/casts/triggers/rules visible to the
 *  migration role. A step must produce ZERO delta; any delta rolls the step
 *  back, so no artifact can leave code/objects behind even through a parser
 *  blind spot. Extension-owned and catalog objects are excluded. */
/** R2 canonical boundary: ONE JSON object per catalog row (jsonb_build_object,
 *  EXPLICIT per-catalog column lists); compared as a sorted multiset of
 *  per-row sha256 hashes in JS - delimiter concatenation cannot exist under
 *  per-row JSON. Identity keys are fully-qualified NAMES, never bare OIDs;
 *  OID resolution happens only within one snapshot for joins. */
const CATALOG_SNAPSHOT_SQL = `
SELECT kind, body FROM (
  SELECT 'pg_proc' AS kind, jsonb_build_object(
    'name', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
    'secdef', p.prosecdef, 'prokind', p.prokind, 'lang', l.lanname, 'volatile', p.provolatile,
    'args', pg_get_function_arguments(p.oid), 'owner', r.rolname,
    'acl', coalesce(p.proacl::text, ''), 'config', coalesce(p.proconfig::text, ''), 'src', p.prosrc) AS body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
   WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid)
  UNION ALL
  SELECT 'pg_operator', jsonb_build_object(
    'name', n.nspname || '.' || o.oprname, 'left', o.oprleft::regtype::text, 'right', o.oprright::regtype::text,
    'code', fn.nspname || '.' || fp.proname, 'result', o.oprresult::regtype::text, 'owner', r.rolname)
    FROM pg_operator o JOIN pg_namespace n ON n.oid = o.oprnamespace
      JOIN pg_proc fp ON fp.oid = o.oprcode JOIN pg_namespace fn ON fn.oid = fp.pronamespace
      JOIN pg_roles r ON r.oid = o.oprowner
   WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema'
  UNION ALL
  SELECT 'pg_opclass', jsonb_build_object(
    'name', n.nspname || '.' || c.opcname, 'intype', c.opcintype::regtype::text,
    'method', a.amname, 'owner', r.rolname, 'default', c.opcdefault)
    FROM pg_opclass c JOIN pg_namespace n ON n.oid = c.opcnamespace
      JOIN pg_am a ON a.oid = c.opcmethod JOIN pg_roles r ON r.oid = c.opcowner
   WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema'
  UNION ALL
  SELECT 'pg_cast', jsonb_build_object(
    'source', c.castsource::regtype::text, 'target', c.casttarget::regtype::text,
    'func', CASE WHEN c.castfunc = 0 THEN '' ELSE (SELECT fn.nspname || '.' || fp.proname FROM pg_proc fp JOIN pg_namespace fn ON fn.oid = fp.pronamespace WHERE fp.oid = c.castfunc) END,
    'context', c.castcontext, 'method', c.castmethod)
    FROM pg_cast c
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc fp JOIN pg_namespace fn ON fn.oid = fp.pronamespace
                      WHERE fp.oid = c.castfunc AND c.castfunc <> 0 AND fn.nspname LIKE 'pg\\_%' ESCAPE '\\')
  UNION ALL
  SELECT 'pg_trigger', jsonb_build_object(
    'table', t.tgrelid::regclass::text, 'name', t.tgname,
    'func', fn.nspname || '.' || fp.proname, 'type', t.tgtype, 'enabled', t.tgenabled)
    FROM pg_trigger t JOIN pg_proc fp ON fp.oid = t.tgfoid JOIN pg_namespace fn ON fn.oid = fp.pronamespace
   WHERE NOT t.tgisinternal
  UNION ALL
  SELECT 'pg_rewrite', jsonb_build_object(
    'table', r.ev_class::regclass::text, 'name', r.rulename, 'action', r.ev_action::text, 'enabled', r.ev_enabled)
    FROM pg_rewrite r WHERE r.rulename <> '_RETURN'
  UNION ALL
  SELECT 'pg_extension', jsonb_build_object(
    'name', e.extname, 'version', e.extversion, 'schema', n.nspname, 'owner', r.rolname)
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace JOIN pg_roles r ON r.oid = e.extowner
  UNION ALL
  SELECT 'pg_event_trigger', jsonb_build_object(
    'name', et.evtname, 'event', et.evtevent, 'enabled', et.evtenabled,
    'func', fn.nspname || '.' || fp.proname, 'owner', r.rolname)
    FROM pg_event_trigger et JOIN pg_proc fp ON fp.oid = et.evtfoid JOIN pg_namespace fn ON fn.oid = fp.pronamespace
      JOIN pg_roles r ON r.oid = et.evtowner
  UNION ALL
  SELECT 'pg_policy', jsonb_build_object(
    'table', pol.polrelid::regclass::text, 'name', pol.polname, 'permissive', pol.polpermissive,
    'roles', (SELECT jsonb_agg(rol.rolname ORDER BY rol.rolname) FROM pg_roles rol WHERE rol.oid = ANY(pol.polroles)),
    'cmd', pol.polcmd, 'qual', coalesce(pol.polqual::text, ''), 'check', coalesce(pol.polwithcheck::text, ''))
    FROM pg_policy pol
  UNION ALL
  SELECT 'pg_default_acl', jsonb_build_object(
    'role', dr.rolname, 'schema', coalesce(n.nspname, ''), 'objtype', d.defaclobjtype, 'acl', coalesce(d.defaclacl::text, ''))
    FROM pg_default_acl d JOIN pg_roles dr ON dr.oid = d.defaclrole LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
  UNION ALL
  SELECT 'pg_db_role_setting', jsonb_build_object(
    'database', coalesce(db.datname, 'ALL'),
    'role', coalesce(rol.rolname, 'ALL'),
    'config', coalesce((SELECT jsonb_agg(v ORDER BY v) FROM unnest(s.setconfig) AS v), '[]'::jsonb))
    FROM pg_db_role_setting s
    LEFT JOIN pg_database db ON db.oid = s.setdatabase
    LEFT JOIN pg_roles rol ON rol.oid = s.setrole
  UNION ALL
  -- pg_description for every securable class: COMMENT drift is security drift.
  SELECT 'pg_description', jsonb_build_object(
    'class', d.classoid::regclass::text,
    'obj', coalesce(
      CASE d.classoid
        WHEN 'pg_class'::regclass THEN (SELECT cn.nspname || '.' || cc.relname || coalesce('.' || a.attname, '')
          FROM pg_class cc JOIN pg_namespace cn ON cn.oid = cc.relnamespace LEFT JOIN pg_attribute a ON a.attrelid = cc.oid AND a.attnum = d.objsubid
          WHERE cc.oid = d.objoid)
        WHEN 'pg_proc'::regclass THEN (SELECT pn.nspname || '.' || pp.proname || '(' || pg_get_function_identity_arguments(pp.oid) || ')' FROM pg_proc pp JOIN pg_namespace pn ON pn.oid = pp.pronamespace WHERE pp.oid = d.objoid)
        WHEN 'pg_namespace'::regclass THEN (SELECT nspname FROM pg_namespace WHERE oid = d.objoid)
        WHEN 'pg_trigger'::regclass THEN (SELECT tgrelid::regclass::text || '.' || tgname FROM pg_trigger WHERE oid = d.objoid)
        WHEN 'pg_policy'::regclass THEN (SELECT polrelid::regclass::text || '.' || polname FROM pg_policy WHERE oid = d.objoid)
        WHEN 'pg_extension'::regclass THEN (SELECT extname FROM pg_extension WHERE oid = d.objoid)
        WHEN 'pg_type'::regclass THEN (SELECT d.objoid::regtype::text)
        WHEN 'pg_operator'::regclass THEN (SELECT onsp.nspname || '.' || oo.oprname FROM pg_operator oo JOIN pg_namespace onsp ON onsp.oid = oo.oprnamespace WHERE oo.oid = d.objoid)
        WHEN 'pg_opclass'::regclass THEN (SELECT ocn.nspname || '.' || oc.opcname FROM pg_opclass oc JOIN pg_namespace ocn ON ocn.oid = oc.opcnamespace WHERE oc.oid = d.objoid)
      END, d.classoid::regclass::text || ':' || d.objoid::text || ':' || d.objsubid::text),
    'description', d.description)
    FROM pg_description d
   WHERE d.classoid IN ('pg_class'::regclass, 'pg_proc'::regclass, 'pg_namespace'::regclass, 'pg_trigger'::regclass,
                       'pg_policy'::regclass, 'pg_extension'::regclass, 'pg_type'::regclass, 'pg_operator'::regclass, 'pg_opclass'::regclass)
     AND coalesce(
      CASE d.classoid
        WHEN 'pg_class'::regclass THEN (SELECT cn.nspname FROM pg_class cc JOIN pg_namespace cn ON cn.oid = cc.relnamespace WHERE cc.oid = d.objoid)
        WHEN 'pg_proc'::regclass THEN (SELECT pn.nspname FROM pg_proc pp JOIN pg_namespace pn ON pn.oid = pp.pronamespace WHERE pp.oid = d.objoid)
        WHEN 'pg_namespace'::regclass THEN (SELECT nspname FROM pg_namespace WHERE oid = d.objoid)
        WHEN 'pg_operator'::regclass THEN (SELECT onsp.nspname FROM pg_operator oo JOIN pg_namespace onsp ON onsp.oid = oo.oprnamespace WHERE oo.oid = d.objoid)
        WHEN 'pg_opclass'::regclass THEN (SELECT ocn.nspname FROM pg_opclass oc JOIN pg_namespace ocn ON ocn.oid = oc.opcnamespace WHERE oc.oid = d.objoid)
      END, 'public') NOT LIKE 'pg\\_%' ESCAPE '\\'
  UNION ALL
  -- Value-maps on PRE-EXISTING objects (new data objects are legal):
  -- ownership and ACL drift, keyed by fully-qualified NAME.
  SELECT 'owner_rel', jsonb_build_object('name', n.nspname || '.' || c.relname, 'owner', r.rolname)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner
   WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema'
  UNION ALL
  SELECT 'owner_nsp', jsonb_build_object('name', n.nspname, 'owner', r.rolname)
    FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
   WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema'
  UNION ALL
  SELECT 'acl_rel', jsonb_build_object('name', n.nspname || '.' || c.relname, 'acl', coalesce(c.relacl::text, ''))
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema'
  UNION ALL
  SELECT 'acl_nsp', jsonb_build_object('name', n.nspname, 'acl', coalesce(n.nspacl::text, ''))
    FROM pg_namespace n
   WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema'
  UNION ALL
  -- Sequences: last_value and is_called EXACT TEXT end to end (no Number()).
  SELECT 'seqval', jsonb_build_object('name', seq.schemaname || '.' || seq.sequencename,
    'last_value', coalesce(seq.last_value::text, 'unused'), 'is_called', (seq.last_value IS NOT NULL))
    FROM pg_sequences seq
   WHERE seq.schemaname NOT LIKE 'pg\\_%' ESCAPE '\\' AND seq.schemaname <> 'information_schema'
) objs ORDER BY kind, body::text`;

/** R2 statement-kind x catalog matrix (bounded-universe binding). Every
 *  gate-accepted statement kind maps to the catalogs it may write. Diff scope
 *  = union(matrix writable catalogs) + the NEVER-TOUCH set. Maintenance rule:
 *  adding a gate statement kind REQUIRES updating this matrix in the same
 *  change. Writable (data-object) classes accept NEW rows only; any change
 *  to a PRE-EXISTING row (alteration or drop) is a hard fail. NEVER-TOUCH:
 *  ANY delta (add, drop, or alteration) is a hard fail + rollback. */
export const STATEMENT_CATALOG_MATRIX: Readonly<Record<string, readonly string[]>> = {
  'create table': ['owner_rel', 'acl_rel'],
  'create index': ['owner_rel', 'acl_rel'],
  'drop table': [],
  'drop index': [],
  'alter table': ['owner_rel', 'acl_rel'],
  'insert/update/delete/select': [],
};
const NEVER_TOUCH_KINDS: ReadonlySet<string> = new Set([
  'pg_proc', 'pg_trigger', 'pg_rewrite', 'pg_operator', 'pg_opclass', 'pg_cast',
  'pg_extension', 'pg_event_trigger', 'pg_policy', 'pg_default_acl',
  'pg_db_role_setting', 'pg_description',
]);
const VALUE_MAP_KINDS: ReadonlySet<string> = new Set(['owner_rel', 'owner_nsp', 'acl_rel', 'acl_nsp', 'seqval']);

export interface CatalogRow { kind: string; body: Record<string, unknown>; bodyText: string; hash: string }
/** Canonical per-row JSON strings (kind + one jsonb object) - the unit tests
 *  and evidence compare these; the diff engine hashes per row. */
export async function catalogSnapshot(conn: Queryable): Promise<string[]> {
  const rows = await catalogSnapshotRows(conn);
  return rows.map(r => `${r.kind} ${r.bodyText}`).sort();
}
export async function catalogSnapshotRows(conn: Queryable): Promise<CatalogRow[]> {
  // ERR-PROPAGATE: a snapshot error aborts the step (no catch anywhere).
  const r = await conn.query(CATALOG_SNAPSHOT_SQL);
  return r.rows.map(row => {
    const kind = String(row['kind']);
    const bodyText = typeof row['body'] === 'string' ? String(row['body']) : JSON.stringify(row['body']);
    const hash = createHash('sha256').update(`${kind}\n${bodyText}`).digest('hex');
    return { kind, body: (typeof row['body'] === 'object' ? row['body'] : JSON.parse(bodyText)) as Record<string, unknown>, bodyText, hash };
  });
}

/** CTL-DDL-CONFINEMENT condition 6: sequence values are NON-TRANSACTIONAL -
 *  rollback never restores them. The runner captures pre-step sequence state
 *  and ACTIVELY RESTORES any drifted value after rolling a step back, then
 *  hard-fails; restoration (not just detection) is what makes the step's
 *  aftermath exactly equal. */
interface SeqVal { lastValue: string; isCalled: boolean }
async function sequenceValues(conn: Queryable): Promise<Map<string, SeqVal>> {
  const seqs = await conn.query(
    `SELECT schemaname, sequencename FROM pg_sequences WHERE schemaname NOT LIKE 'pg\\_%' ESCAPE '\\' AND schemaname <> 'information_schema'`,
  );
  const m = new Map<string, SeqVal>();
  for (const r of seqs.rows) {
    const sch = String(r['schemaname']); const seq = String(r['sequencename']);
    const v = await conn.query(`SELECT last_value::text AS lv, is_called AS ic FROM "${sch}"."${seq}"`);
    m.set(`${sch}.${seq}`, { lastValue: String(v.rows[0]?.['lv']), isCalled: Boolean(v.rows[0]?.['ic']) });
  }
  return m;
}
async function restoreSequenceValues(conn: Queryable, before: Map<string, SeqVal>): Promise<string[]> {
  const now = await sequenceValues(conn);
  const restored: string[] = [];
  for (const [name, bv] of before) {
    const nv = now.get(name);
    if (nv && (nv.lastValue !== bv.lastValue || nv.isCalled !== bv.isCalled)) {
      const [sch, seq] = name.split('.') as [string, string];
      // Exact text: the bigint travels as a string parameter, never a JS number.
      await conn.query(`SELECT pg_catalog.setval('"${sch}"."${seq}"', $1::text::bigint, $2)`, [bv.lastValue, bv.isCalled]);
      restored.push(name);
    }
  }
  return restored;
}

/** Absolute classes: ANY delta (add or remove) is a violation - a governed
 *  step never creates, alters, or drops code/security objects. Value-map
 *  classes (owner:/acl:/seqval:): only a VALUE change on an object present in
 *  BOTH snapshots is a violation; entries appearing/disappearing with
 *  created/dropped data objects are legal declarative DDL. */

/** R2 diff rule: NEVER-TOUCH kinds require an EXACT sorted-multiset match of
 *  per-row hashes (any add, drop, OR alteration of a pre-existing object is
 *  a hard fail). Value-map kinds (ownership/ACL/sequence values): rows whose
 *  identity NAME existed before must be byte-identical (alteration or drop =
 *  fail); brand-new names (data objects the step created) are legal. */
export function assertZeroCatalogDeltaRows(before: CatalogRow[], after: CatalogRow[], version: string): void {
  const violations: string[] = [];
  const count = (rows: CatalogRow[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.hash, (m.get(r.hash) ?? 0) + 1);
    return m;
  };
  const bNever = count(before.filter(r => NEVER_TOUCH_KINDS.has(r.kind)));
  const aNever = count(after.filter(r => NEVER_TOUCH_KINDS.has(r.kind)));
  const render = (rows: CatalogRow[], hash: string) => rows.find(r => r.hash === hash);
  for (const [h, n] of aNever) {
    const got = bNever.get(h) ?? 0;
    if (n > got) violations.push(`added ${render(after, h)!.kind} ${JSON.stringify(render(after, h)!.body)}`);
  }
  for (const [h, n] of bNever) {
    const got = aNever.get(h) ?? 0;
    if (n > got) violations.push(`removed-or-altered ${render(before, h)!.kind} ${JSON.stringify(render(before, h)!.body)}`);
  }
  const keyOf = (r: CatalogRow) => `${r.kind}:${String(r.body['name'])}`;
  const bVal = new Map(before.filter(r => VALUE_MAP_KINDS.has(r.kind)).map(r => [keyOf(r), r]));
  const aVal = new Map(after.filter(r => VALUE_MAP_KINDS.has(r.kind)).map(r => [keyOf(r), r]));
  for (const [k, bv] of bVal) {
    const av = aVal.get(k);
    if (!av) violations.push(`dropped ${bv.kind} ${JSON.stringify(bv.body)}`);
    else if (av.hash !== bv.hash) violations.push(`altered ${bv.kind} ${JSON.stringify(bv.body)} -> ${JSON.stringify(av.body)}`);
  }
  if (violations.length > 0) {
    throw new Error(
      `release-migrations: CATALOG DELTA refusal - step '${version}' changed the database code/privilege/ownership ` +
      `surface inside its transaction (${violations.join('; ')}). R2 canonical boundary: the NEVER-TOUCH set ` +
      `(pg_proc/trigger/rewrite/operator/opclass/cast/extension/event-trigger/policy/default-acl/db-role-setting/` +
      `description) permits NO delta, and ownership/ACL/sequence values on pre-existing objects permit none either - ` +
      `rolling back BEFORE COMMIT (fail-closed)`,
    );
  }
}
/** Back-compat wrapper used by tests/evidence written against text snapshots. */
export function assertZeroCatalogDelta(before: string[], after: string[], version: string): void {
  const parse = (rows: string[]): CatalogRow[] => rows.map(t => {
    const sp = t.indexOf(' ');
    const kind = t.slice(0, sp); const bodyText = t.slice(sp + 1);
    return { kind, body: JSON.parse(bodyText) as Record<string, unknown>, bodyText,
             hash: createHash('sha256').update(`${kind}\n${bodyText}`).digest('hex') };
  });
  assertZeroCatalogDeltaRows(parse(before), parse(after), version);
}

/** STRICT guard-object validation (independent security, 2026-09-18): exact
 *  own-key sets per kind, exact enums/booleans, canonical identifiers -
 *  validated BEFORE digest and BEFORE execution, so neither a smuggled key
 *  nor a coerced value can ride through either path. */
const IDENT_STRICT = /^[a-z_][a-z0-9_]{0,62}$/;
function strictIdent(v: unknown, what: string): string {
  if (typeof v !== 'string' || !IDENT_STRICT.test(v)) {
    throw new Error(`release-migrations: invalid assertion ${what} ${JSON.stringify(v)} (canonical identifier required)`);
  }
  return v;
}
function strictKeys(a: object, allowed: readonly string[], kind: string): void {
  const keys = Object.keys(a);
  for (const k of keys) {
    if (!allowed.includes(k)) throw new Error(`release-migrations: assertion kind '${kind}' carries unexpected key ${JSON.stringify(k)} (exact own-key set required)`);
  }
}

/** Validates a named guard and returns the runner-GENERATED guard SQL.
 *  Identifiers are strictly validated and double-quoted by the runner; every
 *  other byte of the generated statement is a fixed runner template with
 *  fully-qualified relations and pg_catalog functions. */
export function buildAssertionQuery(a: MigrationAssertion): string {
  if (!a || typeof a !== 'object') throw new Error('release-migrations: assertion must be an object');
  switch (a.kind) {
    case 'table-empty': {
      strictKeys(a, ['kind', 'table'], a.kind);
      const t = strictIdent(a.table, 'table');
      return `SELECT 1 AS violation FROM "${CONTROLLED_SCHEMA}"."${t}" LIMIT 1`;
    }
    case 'no-nulls': {
      strictKeys(a, ['kind', 'table', 'column'], a.kind);
      const t = strictIdent(a.table, 'table'); const c = strictIdent(a.column, 'column');
      return `SELECT 1 AS violation FROM "${CONTROLLED_SCHEMA}"."${t}" WHERE "${c}" IS NULL LIMIT 1`;
    }
    case 'no-duplicates': {
      strictKeys(a, ['kind', 'table', 'column', 'normalize', 'skipNulls'], a.kind);
      const t = strictIdent(a.table, 'table'); const c = strictIdent(a.column, 'column');
      if (a.normalize !== undefined && a.normalize !== 'btrim' && a.normalize !== 'none') {
        throw new Error(`release-migrations: assertion normalize must be exactly 'btrim' or 'none', got ${JSON.stringify(a.normalize)}`);
      }
      if (a.skipNulls !== undefined && typeof a.skipNulls !== 'boolean') {
        throw new Error(`release-migrations: assertion skipNulls must be an exact boolean, got ${JSON.stringify(a.skipNulls)}`);
      }
      const key = a.normalize === 'btrim' ? `pg_catalog.btrim("${c}")` : `"${c}"`;
      const where = a.skipNulls === false ? '' : ` WHERE "${c}" IS NOT NULL`;
      return `SELECT 1 AS violation FROM "${CONTROLLED_SCHEMA}"."${t}"${where} GROUP BY ${key} HAVING pg_catalog.count(*) > 1 LIMIT 1`;
    }
    default:
      throw new Error(`release-migrations: unknown assertion kind ${JSON.stringify((a as { kind?: string }).kind)} - named runner-owned kinds only`);
  }
}
export function validateAssertion(a: MigrationAssertion): void {
  buildAssertionQuery(a); // throws on invalid identifiers/kinds/keys
}

/** Key-sorted canonical JSON for the declared-primitive digest component. */
const canonicalJson = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
};

/** Integrity digest over the EXACT artifact text + declared primitives:
 *  version + name + sql + canonical primitive declaration. Editing anything
 *  that executes changes the digest and FAILS the runner/boot history check.
 *  `description` is operator display metadata and is deliberately NOT
 *  integrity-protected; only executed content is. */
export const stepDigest = (m: MigrationStep): string => {
  // Strict validation precedes hashing: an invalid guard object cannot be
  // digested (and therefore can never match an applied row or execute).
  for (const a of m.assertions ?? []) validateAssertion(a);
  for (const t of m.lockTables ?? []) {
    if (typeof t !== 'string' || !IDENT_STRICT.test(t)) throw new Error(`release-migrations: invalid lockTables identifier ${JSON.stringify(t)}`);
  }
  if (m.xactLockKey !== undefined && (!Number.isSafeInteger(m.xactLockKey) || m.xactLockKey < 0)) {
    throw new Error('release-migrations: xactLockKey must be a non-negative safe integer');
  }
  return createHash('sha256').update(
    `contake-migration/v6\n${m.version}\n${m.name}\n${canonicalArtifactSql(m.sql)}\n${canonicalJson({
      assertions: m.assertions ?? [], lockTables: m.lockTables ?? [], xactLockKey: m.xactLockKey ?? null,
    })}`,
  ).digest('hex');
};

/** 0001: the schema that used to be applied implicitly at server boot,
 *  extracted as a declarative artifact (frozen GRAPH_DDL/OTP_DDL - never edit
 *  in place). All IF NOT EXISTS: pre-migration databases adopt as a no-op
 *  baseline. */
export const MIGRATIONS: readonly MigrationStep[] = [
  {
    version: '0001',
    name: 'init-schema',
    description: 'Graph + OTP schema baseline (schema ownership moved out of app boot; idempotent IF NOT EXISTS).',
    sql: `${GRAPH_DDL};${OTP_DDL}`,
  },
  // SA lane plug-in contract (backend compatibility confirmed 2026-09-18;
  // TL reconciliation: declarative-only, guards as runner primitives):
  // register as '0002' when the SA track lands:
  // {
  //   version: '0002', name: 'users-phone-unique-index',
  //   description: 'users_phone_unique canonical partial unique index (SA lane)',
  //   xactLockKey: <SA migration lock key>,
  //   lockTables: ['users'],
  //   assertions: [
  //     { name: 'no_duplicate_normalized_phones', query: `SELECT phone FROM users WHERE phone IS NOT NULL GROUP BY btrim(phone) HAVING count(*) > 1` },
  //     { name: 'no_inconsistent_rows', query: `<SA inconsistency guard SELECT>` },
  //   ],
  //   sql: `CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(btrim(phone)) WHERE phone IS NOT NULL`,
  // }
  // Blocking guards hard-fail and roll back; normalization itself is set-based
  // DML in the artifact when SA ships it. The companion read-only structured
  // preflight remains operator evidence outside the migration. No second
  // runner may be introduced.
];

export const EXPECTED_SCHEMA_VERSIONS: readonly string[] = MIGRATIONS.map(m => m.version);

const RUNNER_LOCK_KEY = 841_000_001;

const RUNNER_DDL = `
CREATE TABLE IF NOT EXISTS public.schema_migrations(
  seq bigserial PRIMARY KEY,
  version text NOT NULL,
  name text NOT NULL,
  sha256 text NOT NULL,
  applied_by text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(version)
);
CREATE TABLE IF NOT EXISTS public.contake_db_identity(
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  deployment_label text NOT NULL,
  instance_id text NOT NULL,
  ext_baseline jsonb,
  migration_role text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.contake_db_identity ADD COLUMN IF NOT EXISTS ext_baseline jsonb;
ALTER TABLE public.contake_db_identity ADD COLUMN IF NOT EXISTS migration_role text;
`;

export interface DbIdentity { deploymentLabel: string; instanceId: string }
export interface MigrationRunResult { identity: DbIdentity; stampedNow: boolean; appliedNow: string[]; versions: string[] }
export interface AppliedMigrationRow { version: string; name: string; sha256: string }

const DEPLOYMENT_LABEL = /^[a-z0-9][a-z0-9-]{0,62}$/;

export async function readDbIdentity(conn: Connectable | Queryable): Promise<DbIdentity | undefined> {
  const t = await conn.query(`SELECT to_regclass('public.contake_db_identity') AS r`);
  if (!t.rows[0]?.['r']) return undefined;
  const r = await conn.query(`SELECT deployment_label, instance_id FROM public.contake_db_identity WHERE id = 1`);
  const row = r.rows[0];
  return row ? { deploymentLabel: String(row['deployment_label']), instanceId: String(row['instance_id']) } : undefined;
}

/** PRE-MUTATION target binding (security): READ-ONLY. Verifies an already
 *  stamped database matches the expected deployment label and optional
 *  pre-provisioned instance pin BEFORE any write. An unstamped database is a
 *  first run: allowed here, stamped by runMigrations, and surfaced as an
 *  operator-attended TOFU gate (never authentication). */
export async function verifyTargetPreconditions(
  conn: Connectable | Queryable,
  opts: { deployment: string; expectInstanceId?: string },
): Promise<{ firstRun: boolean; identity?: DbIdentity }> {
  if (!DEPLOYMENT_LABEL.test(opts.deployment)) {
    throw new Error(`release-migrations: invalid deployment label ${JSON.stringify(opts.deployment)} (expected ${DEPLOYMENT_LABEL})`);
  }
  const identity = await readDbIdentity(conn);
  if (!identity) {
    if (opts.expectInstanceId !== undefined) {
      throw new Error(
        `release-migrations: INSTANCE BINDING refusal - an instance pin ('${opts.expectInstanceId}') was presented but this ` +
        `database carries NO stamped identity. A pin can only bind an existing stamp; omit --expect-instance-id for the ` +
        `attended first-run TOFU gate (refusing BEFORE any write).`,
      );
    }
    return { firstRun: true };
  }
  if (identity.deploymentLabel !== opts.deployment) {
    throw new Error(
      `release-migrations: CROSS-DEPLOYMENT refusal - this database is stamped '${identity.deploymentLabel}' ` +
      `(instance ${identity.instanceId}) but the job presented '${opts.deployment}'. Refusing BEFORE any write.`,
    );
  }
  if (opts.expectInstanceId !== undefined && identity.instanceId !== opts.expectInstanceId) {
    throw new Error(
      `release-migrations: INSTANCE BINDING refusal - operator pinned instance '${opts.expectInstanceId}' ` +
      `but this database is stamped '${identity.instanceId}'. Refusing BEFORE any write.`,
    );
  }
  return { firstRun: false, identity };
}

async function readAppliedRows(conn: Queryable): Promise<AppliedMigrationRow[]> {
  const t = await conn.query(`SELECT to_regclass('public.schema_migrations') AS r`);
  if (!t.rows[0]?.['r']) return [];
  const r = await conn.query(`SELECT version, name, sha256 FROM public.schema_migrations ORDER BY seq`);
  return r.rows.map(row => ({ version: String(row['version']), name: String(row['name']), sha256: String(row['sha256']) }));
}

function verifyHistoryPrefix(applied: AppliedMigrationRow[], migrations: readonly MigrationStep[]): void {
  for (let i = 0; i < applied.length; i += 1) {
    const reg = migrations[i];
    const row = applied[i]!;
    if (!reg || reg.version !== row.version) {
      throw new Error(
        `release-migrations: FORWARD-ONLY refusal - applied version ${row.version} at position ${i + 1} ` +
        `is not the registry prefix (expected ${reg?.version ?? 'none'}). Unknown/gapped/out-of-order history; manual review required.`,
      );
    }
    if (row.name !== reg.name || row.sha256 !== stepDigest(reg)) {
      throw new Error(
        `release-migrations: INTEGRITY refusal - applied '${row.version}' does not match the registered artifact ` +
        `(stored name='${row.name}' sha256=${row.sha256.slice(0, 12)}..., expected name='${reg.name}' sha256=${stepDigest(reg).slice(0, 12)}...). ` +
        `History was edited outside the runner or the artifact drifted; manual review required.`,
      );
    }
  }
}

/** Validates a full registry before anything executes (fail fast, pre-lock). */
export function validateRegistry(migrations: readonly MigrationStep[]): void {
  for (let i = 0; i < migrations.length; i += 1) {
    const m = migrations[i]!;
    if (m.version !== String(i + 1).padStart(4, '0')) {
      throw new Error(`release-migrations: registry is not strictly sequential at index ${i} (version ${m.version}) - refusing`);
    }
    validateMigrationArtifact(m.sql);
    for (const a of m.assertions ?? []) validateAssertion(a);
    for (const t of m.lockTables ?? []) {
      if (typeof t !== 'string' || !IDENT_STRICT.test(t)) throw new Error(`release-migrations: invalid lockTables identifier ${JSON.stringify(t)}`);
    }
    if (m.xactLockKey !== undefined && (!Number.isSafeInteger(m.xactLockKey) || m.xactLockKey < 0)) {
      throw new Error('release-migrations: xactLockKey must be a non-negative safe integer');
    }
  }
}

/** Applies every pending migration in registry order. */
export async function runMigrations(
  conn: Connectable,
  opts: { deployment: string; appliedBy?: string; migrations?: readonly MigrationStep[]; expectInstanceId?: string },
): Promise<MigrationRunResult> {
  const migrations = opts.migrations ?? MIGRATIONS;
  validateRegistry(migrations);

  const client = await conn.connect();
  let identity: DbIdentity;
  let stampedNow = false;
  let applied: AppliedMigrationRow[];
  const appliedNow: string[] = [];
  try {
    // TL semantic layer: pin the migration session's search_path EMPTY for
    // the whole run - unqualified built-ins resolve to pg_catalog only and no
    // schema can be shadowed in. Re-pinned per step below.
    await client.query(`SET search_path = ''`);
    // R2: the fixed-name denylist is DELETED. Baseline equality only: the
    // extension set is pinned (name+version) at bootstrap TOFU into the
    // identity row and every later run must find it byte-identical. The
    // per-step NEVER-TOUCH diff separately forbids any in-run change.
    const extNow = await client.query(`SELECT jsonb_agg(jsonb_build_object('name', extname, 'version', extversion) ORDER BY extname) AS s FROM pg_extension`);
    const currentExt = JSON.stringify(extNow.rows[0]?.['s'] ?? []);
    await client.query(`SELECT pg_catalog.pg_advisory_lock(${RUNNER_LOCK_KEY})`);
    try {
      await client.query('BEGIN');
      try {
        for (const stmt of RUNNER_DDL.split(';').map(s => s.trim()).filter(Boolean)) await client.query(stmt);
        // Pre-mutation target binding is enforced inside the bootstrap tx as
        // well (the CLI also checks read-only before calling): any refusal
        // here still precedes every step write and rolls back.
        const pre = await verifyTargetPreconditions(client, { deployment: opts.deployment, expectInstanceId: opts.expectInstanceId });
        if (pre.firstRun) {
          identity = { deploymentLabel: opts.deployment, instanceId: randomBytes(8).toString('hex') };
          stampedNow = true;
          await client.query(
            `INSERT INTO public.contake_db_identity(id, deployment_label, instance_id, ext_baseline) VALUES(1, $1, $2, $3::jsonb)`,
            [identity.deploymentLabel, identity.instanceId, currentExt],
          );
        } else {
          identity = pre.identity!;
          const base = await client.query(`SELECT ext_baseline AS b FROM public.contake_db_identity WHERE id = 1`);
          const pinned = base.rows[0]?.['b'];
          if (pinned === null || pinned === undefined) {
            // One-time adoption for pre-R2 deployments: pin what is there.
            await client.query(`UPDATE public.contake_db_identity SET ext_baseline = $1::jsonb WHERE id = 1`, [currentExt]);
          } else if (JSON.stringify(pinned) !== currentExt) {
            throw new Error(
              `release-migrations: EXTENSION BASELINE refusal - installed extension set differs from the pinned ` +
              `bootstrap baseline (pinned ${JSON.stringify(pinned)} vs current ${currentExt}) - ` +
              `extensions change out of band only via a reviewed re-pin (fail-closed)`,
            );
          }
        }
        // R2 defense-in-depth (ruling §6): any code object the migration role
        // somehow leaves behind must be uncallable - REVOKE EXECUTE ON
        // FUNCTIONS from PUBLIC by DEFAULT, granted to no one. The SECURITY
        // INVOKER trigger path dies with it. Idempotent and runner-owned; the
        // boot gate asserts this default-privilege state on every boot.
        await client.query(`ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
        await client.query(`UPDATE public.contake_db_identity SET migration_role = CURRENT_USER WHERE id = 1`);
        applied = await readAppliedRows(client);
        verifyHistoryPrefix(applied, migrations);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      }

      // Pending steps: ONE runner-owned transaction per step - guard
      // primitives, artifact statements AND the version record commit
      // together or roll back together.
      for (const m of migrations.slice(applied.length)) {
        await client.query('BEGIN');
        // Captured inside the step; hoisted so the catch path can actively
        // restore non-transactional sequence state after ROLLBACK.
        let sequencesBefore: Map<string, SeqVal> | undefined;
        try {
          // Re-pin search_path INSIDE the step transaction (and again before
          // every artifact statement) so even a set_config smuggled through
          // any blind spot cannot redirect name resolution mid-step.
          await client.query(`SELECT pg_catalog.set_config('search_path', '', true)`);
          if (m.xactLockKey !== undefined) await client.query(`SELECT pg_catalog.pg_advisory_xact_lock(${m.xactLockKey})`);
          for (const t of m.lockTables ?? []) await client.query(`LOCK TABLE "${CONTROLLED_SCHEMA}"."${t}" IN SHARE ROW EXCLUSIVE MODE`);
          for (const a of m.assertions ?? []) {
            const guard = await client.query(buildAssertionQuery(a));
            if (guard.rows.length > 0) {
              throw new Error(
                `release-migrations: ASSERTION refusal - guard '${a.kind}' in '${m.version}' found violating row(s); ` +
                `migration blocked - rolling back (hard-fail, never silent-skip)`,
              );
            }
          }
          const catalogBefore = await catalogSnapshotRows(client);
          sequencesBefore = await sequenceValues(client);
          for (const stmt of artifactStatements(m.sql)) {
            await client.query(`SELECT pg_catalog.set_config('search_path', '', true)`);
            await client.query(stmt);
          }
          // Zero function/operator/cast/trigger/rule delta across the step.
          assertZeroCatalogDeltaRows(catalogBefore, await catalogSnapshotRows(client), m.version);
          // The whole-run session advisory lock must still be held (no
          // smuggled unlock): session-state assertion, not a name filter.
          const held = await client.query(
            `SELECT pg_catalog.count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_catalog.pg_backend_pid() AND granted`,
          );
          if (Number(held.rows[0]?.['n'] ?? 0) < 1) {
            throw new Error(`release-migrations: SESSION LOCK refusal - the whole-run advisory lock was lost inside step '${m.version}' - rolling back (fail-closed)`);
          }
          const ins = await client.query(
            `INSERT INTO public.schema_migrations(version, name, sha256, applied_by) VALUES($1, $2, $3, $4)
             ON CONFLICT (version) DO NOTHING`,
            [m.version, m.name, stepDigest(m), opts.appliedBy ?? 'release-job'],
          );
          if (ins.rowCount !== 1) {
            throw new Error(
              `release-migrations: version record for '${m.version}' collided inside its own transaction ` +
              `(rowCount=${ins.rowCount}) - history drift; rolling back the step`,
            );
          }
          await client.query('COMMIT');
          appliedNow.push(m.version);
        } catch (e) {
          await client.query('ROLLBACK').catch(() => undefined);
          // Condition 6: rollback cannot restore sequence state - do it
          // actively, then hard-fail with the original error retained.
          // ERR-PROPAGATE: a restore failure is itself a hard failure (no swallow).
          const restored = sequencesBefore ? await restoreSequenceValues(client, sequencesBefore) : [];
          if (restored.length > 0 && e instanceof Error) {
            e.message += ` [non-transactional sequence state actively restored: ${restored.join(', ')}]`;
          }
          throw e;
        }
      }
    } finally {
      await client.query(`SELECT pg_catalog.pg_advisory_unlock(${RUNNER_LOCK_KEY})`).catch(() => undefined);
      // The pin is scoped to the migration session - never leak it onto a
      // pooled connection's next tenant.
      // The pin (and any smuggled session GUC) is scoped to the migration
      // session - never leak session state onto a pooled connection's next
      // tenant.
      await client.query(`RESET ALL`).catch(() => undefined);
    }
  } finally {
    client.release();
  }
  return { identity, stampedNow, appliedNow, versions: [...applied.map(r => r.version), ...appliedNow] };
}

/** Boot identity requirement (independent QA + security, 2026-09-18): EVERY
 *  PostgreSQL boot - production, staging, dev - MUST present the immutable
 *  database instance identity it expects (CONTAKE_DB_INSTANCE_ID) alongside
 *  the deployment label. Missing or malformed means fail closed: no runtime
 *  ever serves a database whose identity it did not declare. */
export function requiredBootIdentity(deployment: string, instanceId: string | undefined): { deployment: string; instanceId: string } {
  if (!DEPLOYMENT_LABEL.test(deployment)) {
    throw new Error(`release-migrations: invalid boot deployment label ${JSON.stringify(deployment)} (fail-closed)`);
  }
  if (instanceId === undefined || !/^[0-9a-f]{16}$/.test(instanceId)) {
    throw new Error(
      `release-migrations: PostgreSQL boot ('${deployment}') requires CONTAKE_DB_INSTANCE_ID (the 16-hex instance id ` +
      `stamped by the release job and verified out-of-band at the operator TOFU gate) - refusing to boot (fail-closed)`,
    );
  }
  return { deployment, instanceId };
}

/** Boot-time gate (fail-closed): exact version sequence + digest integrity,
 *  and when provided the expected deployment label and instance identity,
 *  verified BEFORE anything serves. */
export async function assertSchemaCurrent(
  conn: Connectable | Queryable,
  expected: readonly MigrationStep[] = MIGRATIONS,
  opts?: { deployment?: string; instanceId?: string },
): Promise<void> {
  const t = await conn.query(`SELECT to_regclass('public.schema_migrations') AS r`);
  if (!t.rows[0]?.['r']) {
    throw new Error(
      'release-migrations: schema_migrations is missing - this database was never initialized by the release-migration job. ' +
      'Run `pnpm --filter @contake/api migrate:release` (direct schema-owner endpoint) BEFORE booting the app - refusing to boot (fail-closed)',
    );
  }
  const applied = await readAppliedRows(conn);
  const expectedVersions = expected.map(m => m.version);
  const appliedVersions = applied.map(r => r.version);
  const missing = expectedVersions.filter(v => !appliedVersions.includes(v));
  const unknown = appliedVersions.filter(v => !expectedVersions.includes(v));
  if (missing.length > 0 || unknown.length > 0 || applied.length !== expected.length) {
    throw new Error(
      `release-migrations: schema version mismatch - refusing to boot (fail-closed). ` +
      `expected=[${expectedVersions.join(',')}] applied=[${appliedVersions.join(',')}]` +
      (missing.length ? ` missing=[${missing.join(',')}] - run the release-migration job` : '') +
      (unknown.length ? ` unknown=[${unknown.join(',')}] - database is ahead of/foreign to this build; manual review` : ''),
    );
  }
  try {
    verifyHistoryPrefix(applied, expected);
  } catch (e) {
    throw new Error(`release-migrations: ${(e as Error).message} - refusing to boot (fail-closed)`);
  }
  // R2 ruling §6: the boot gate asserts the migration role's default-privilege
  // hardening is in place - PUBLIC must hold NO default EXECUTE on functions
  // the migration role creates (a surviving code object must be uncallable).
  {
    const dp = await conn.query(
      `SELECT r.rolname AS role, d.defaclacl::text AS acl
         FROM pg_default_acl d JOIN pg_roles r ON r.oid = d.defaclrole
        WHERE d.defaclobjtype = 'f' AND d.defaclnamespace = 0
          AND r.rolname = (SELECT migration_role FROM public.contake_db_identity WHERE id = 1)`,
    );
    const roleRow = await conn.query(`SELECT migration_role AS m FROM public.contake_db_identity WHERE id = 1`);
    const migRole = roleRow.rows[0]?.['m'];
    if (!migRole) {
      throw new Error(
        'release-migrations: no migration role recorded - this database predates the R2 default-privilege hardening. ' +
        'Run the release-migration job once to adopt it - refusing to boot (fail-closed)',
      );
    }
    const row = dp.rows[0];
    const acl = String(row?.['acl'] ?? '');
    if (!row || /(^\{|,)=/.test(acl)) {
      throw new Error(
        `release-migrations: DEFAULT PRIVILEGE refusal - migration role '${migRole}' lacks the PUBLIC function-EXECUTE ` +
        `revocation (observed default ACL: ${acl || 'none'}) - a persisting code object could be callable by any role. ` +
        `Run the release-migration job to re-apply hardening - refusing to boot (fail-closed)`,
      );
    }
  }
  if (opts?.deployment !== undefined || opts?.instanceId !== undefined) {
    const identity = await readDbIdentity(conn);
    if (!identity) {
      throw new Error('release-migrations: no database identity stamped - refusing to boot (fail-closed)');
    }
    if (opts.deployment !== undefined && identity.deploymentLabel !== opts.deployment) {
      throw new Error(
        `release-migrations: DEPLOYMENT refusal - this database is stamped '${identity.deploymentLabel}' ` +
        `(instance ${identity.instanceId}) but this runtime expects '${opts.deployment}'. Refusing to serve another deployment's database (fail-closed).`,
      );
    }
    if (opts.instanceId !== undefined && identity.instanceId !== opts.instanceId) {
      throw new Error(
        `release-migrations: INSTANCE refusal - this database is instance '${identity.instanceId}' ` +
        `but this runtime expects '${opts.instanceId}'. Refusing to serve a different database (fail-closed).`,
      );
    }
  }
}

/** Role separation (Neon): release migrations and the staging seed run as
 *  schema owner over the DIRECT endpoint; '-pooler' is refused. Returns a
 *  credential-free descriptor safe to log. */
export function assertDirectDatabaseUrl(databaseUrl: string): { host: string; database: string } {
  let u: URL;
  try {
    u = new URL(databaseUrl);
  } catch {
    throw new Error('release-migrations: DATABASE_URL is not a valid URL');
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new Error(`release-migrations: DATABASE_URL protocol must be postgres(ql), got ${u.protocol}`);
  }
  if (u.hostname.includes('-pooler')) {
    throw new Error(
      'release-migrations: POOLED endpoint refused - schema/maintenance work requires the DIRECT schema-owner endpoint ' +
      '(Neon pooled connections are the runtime role and cannot own DDL). Use the unpooled DATABASE_URL.',
    );
  }
  return { host: u.hostname, database: u.pathname.replace(/^\//, '') };
}
