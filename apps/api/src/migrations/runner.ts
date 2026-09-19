/** Release-migration runner - R3 closed-template execution contract with
 *  the R4 integrity binding (trust-head rulings 2026-09-18; supersedes the
 *  rejected artifact-SQL line 976db452/c862cbbe/4f947f3e/356c9e97/4d97f31a).
 *
 *  ONE shared runner owns ALL schema evolution:
 *  - CLOSED TEMPLATE REGISTRY (R3). A migration step is INERT DATA:
 *    { version, name, description, template, params } plus runner-owned
 *    guard primitives. There is NO caller SQL anywhere - no artifact text,
 *    no parser, no AST allowlist (deleted, not refactored). Templates are
 *    reviewed runner-owned code; capability grows ONLY by adding a reviewed
 *    template to the private registry.
 *  - INTEGRITY BINDING (R4): self-consistency is not authenticity. The
 *    registry (templates, named forms, frozen baseline derivations) is
 *    MODULE-PRIVATE and deeply frozen at load; NOTHING exports it and no
 *    render capability crosses the module boundary - callers submit inert
 *    artifact data and receive results/refusals; rendered SQL never leaves
 *    the runner.
 *  - INERT BLUEPRINT (R5): the registry is PURE CANONICAL DATA - statement
 *    shape strings with named placeholders, data parameter declarations,
 *    enum fragment maps, named forms, canonical sample vectors. ZERO render
 *    closures exist; ONE runner-private assembly mechanism interprets the
 *    data. REGISTRY_DIGEST hashes the canonical blueprint data ONLY (no
 *    Function.toString, nothing build-derived), so source/tsx, tsc dist,
 *    vitest and the real-PG run compute ONE identical value. Runner code is
 *    anchored by the code trust chain (head SHA -> lockfile -> literal
 *    build -> dist hashes -> instance pin); the blueprint is anchored by
 *    REGISTRY_DIGEST - two distinct anchors, neither impersonates the other.
 *    Legacy NULL adoption (extension baseline or registry anchor) writes
 *    NOTHING without BOTH operator pins (expect-instance-id AND
 *    expect-registry-digest).
 *  - TWO TRUST ANCHORS (R4): Anchor A - the reviewer records the EXPECTED
 *    REGISTRY_DIGEST from the reviewed source tree (never the code's
 *    self-report) and qualification/deploy compares. Anchor B - the first
 *    governed run on a pinned deployment+instance records REGISTRY_DIGEST
 *    into the migration identity; every later run and every boot compares
 *    and refuses on drift with the observed mismatch.
 *  - SINGLE-STATEMENT CONSTRUCTION (R4): asserted at module load over the
 *    private frozen registry - no template shape or named form may contain
 *    a statement separator (module refuses to load otherwise). Only
 *    validated canonical identifiers reach statement position; every
 *    literal is $n-bound through the extended protocol; one driver call
 *    per rendered statement.
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
  | { readonly kind: 'no-duplicates'; readonly table: string; readonly column: string; readonly normalize?: 'btrim' | 'btrim-nullif-empty' | 'none'; readonly skipNulls?: boolean };

/** R3: a migration step is INERT DATA - a registry template name plus
 *  strictly typed params. No caller SQL exists anywhere in the system. */
export interface MigrationStep {
  /** Zero-padded, strictly increasing ('0001', '0002', ...). */
  readonly version: string;
  readonly name: string;
  readonly description: string;
  /** Closed runner-owned registry template name. */
  readonly template: string;
  /** Strictly typed params (identifier/literal/closed-enum/named-expression);
   *  validated and bound by the runner - never interpolated raw. */
  readonly params?: Readonly<Record<string, unknown>>;
  /** Runner-executed zero-row guards (hard-fail), evaluated BEFORE the step. */
  readonly assertions?: readonly MigrationAssertion[];
  /** Runner-executed `LOCK TABLE <t> IN SHARE ROW EXCLUSIVE MODE` before the step. */
  readonly lockTables?: readonly string[];
  /** SA2+SA3: steps that mutate credential-identity row data require the
   *  attended-TOFU operator ack, enforced by the RUNNER against the PERSISTED
   *  issued-nonce record (recomputed under the step's locks, same
   *  transaction - no TOCTOU gap). NO caller-supplied label (deployment,
   *  env, mode) relaxes this gate in the shipped artifact (SA3 section 3). */
  readonly requiresOperatorAck?: boolean;
  /** Runner-executed pg_advisory_xact_lock(key) first (step-scoped). */
  readonly xactLockKey?: number;
}

/** R3 PRIMARY BOUNDARY: the CLOSED TEMPLATE REGISTRY. Named, frozen,
 *  parameterized SQL shapes - reviewed like code, versioned, hash-pinned.
 *  Capability grows ONLY by adding a reviewed template here; there is no
 *  artifact-level escape hatch. The real-parser AST allowlist machinery is
 *  DELETED (R3 §1), not refactored: artifacts carry no SQL to parse. */

/** Named expression forms: the ONLY way an expression enters a statement.
 *  Free-text expressions do not exist (expression indexes are covered
 *  without caller text). */
const NAMED_EXPRESSIONS: Readonly<Record<string, string>> = {
  EXPR_NORM_PHONE: 'btrim(phone)',
  EXPR_NONE: '',
};
const NAMED_PREDICATES: Readonly<Record<string, string>> = {
  PRED_PHONE_NOT_NULL: 'phone IS NOT NULL',
  PRED_NONE: '',
};

/** Named NORMALIZATION forms (SA1 ruling 2026-09-19): the ONLY way a row-data
 *  normalization enters a DATA statement. Inert literal text; the {column} /
 *  {jsonColumn} / {jsonKey} references are bound through the SAME closed
 *  assembly passes as every other placeholder - no free text exists.
 *  NORM_*_NULLIF_EMPTY: blank is ABSENCE, not identity - trim, then empty
 *  becomes NULL, so the partial unique index excludes absent phones by
 *  construction. */
const NAMED_NORMALIZATIONS: Readonly<Record<string, string>> = {
  NORM_COL_BTRIM_NULLIF_EMPTY: `NULLIF(pg_catalog.btrim({column}), '')`,
  NORM_COL_BTRIM: `pg_catalog.btrim({column})`,
  NORM_JSON_BTRIM_NULLIF_EMPTY: `NULLIF(pg_catalog.btrim({jsonColumn}->>{jsonKey}), '')`,
  NORM_JSON_BTRIM: `pg_catalog.btrim({jsonColumn}->>{jsonKey})`,
};

export type TemplateParamKind = 'identifier' | 'enum' | 'expression';
export interface RenderedStatement { text: string; values: unknown[] }

/** R5 section 1: parameter declarations are PURE DATA. Every variation the
 *  assembly mechanism needs is declared here as data - no function values
 *  exist anywhere in the blueprint. */
export interface IdentifierParamDecl { readonly kind: 'identifier'; readonly quote: 'bare' | 'schema' }
export interface EnumParamDecl { readonly kind: 'enum'; readonly values: readonly string[]; readonly fragments: Readonly<Record<string, string>> }
export interface ExpressionParamDecl {
  readonly kind: 'expression';
  readonly forms: 'expressions' | 'predicates' | 'normalizations';
  /** Fragment patterns; {form} is the named-form text, {param} references
   *  another declared param (resolved by the assembly mechanism). */
  readonly nonEmpty: string;
  readonly empty: string;
}
export type ParamDecl = IdentifierParamDecl | EnumParamDecl | ExpressionParamDecl;

export interface TemplateEntry {
  readonly name: string;
  readonly description: string;
  /** Typed parameter declarations (pure data). Exact own-key sets enforced. */
  readonly params: Readonly<Record<string, ParamDecl>>;
  /** Catalogs this template may write (statement-kind x catalog matrix, R2 carried). */
  readonly writesCatalogs: readonly string[];
  /** Statement shapes with {param} placeholders (pure data), assembled by
   *  the ONE runner-private mechanism. */
  readonly shapes: readonly string[];
  /** Canonical sample vector (schema-valid), used by the load-time
   *  single-statement assertion and by reviewer recomputation. */
  readonly sample: Readonly<Record<string, unknown>>;
}

const CONTROLLED_SCHEMA = 'public';
const IDENT_STRICT_LOCAL = /^[a-z_][a-z0-9_]{0,62}$/;
function templateRefusal(why: string): never {
  throw new Error(`release-migrations: TEMPLATE refusal - ${why} (fail-closed)`);
}
/** Identifier params: strict shape only. System schemas and extension-owned
 *  objects CANNOT be targeted by construction - every identifier is pinned
 *  into the controlled schema as a bare name ("public"."name"); a name
 *  carrying quotes/semicolons/schema paths fails the shape check. */
function bindIdentifier(v: unknown, what: string): string {
  if (typeof v !== 'string' || !IDENT_STRICT_LOCAL.test(v)) {
    templateRefusal(`identifier param '${what}' must be a canonical lowercase identifier, got ${JSON.stringify(v)}`);
  }
  if (v.startsWith('pg_')) templateRefusal(`identifier param '${what}' targets a system namespace prefix (${v})`);
  return v;
}
// R5: no literal param kind exists in the blueprint; every value entering a
// statement does so through one of the three data-declared kinds above.
function bindEnum(v: unknown, what: string, allowed: readonly string[]): string {
  if (typeof v !== 'string' || !allowed.includes(v)) {
    templateRefusal(`enum param '${what}' must be one of [${allowed.join(', ')}], got ${JSON.stringify(v)}`);
  }
  return v;
}
function bindExpression(v: unknown, what: string, forms: Readonly<Record<string, string>>): string {
  if (typeof v !== 'string' || !(v in forms)) {
    templateRefusal(`expression param '${what}' must be a NAMED registry form [${Object.keys(forms).join(', ')}], got ${JSON.stringify(v)}`);
  }
  return forms[v]!;
}

/** The frozen 0001 baseline statements (GRAPH_DDL/OTP_DDL from the repo layer
 *  - runner-owned reviewed constants, never caller input). */
const BASELINE_0001_STATEMENTS: readonly string[] = `${GRAPH_DDL};${OTP_DDL}`
  .split(';')
  // Frozen runner-owned text may carry `--` comment lines; they carry no
  // semantics, so strip them before the closed-shape check (an AST did this in R2).
  .map(x => x.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n').trim())
  .filter(Boolean)
  .map(text => {
    // R3: the migration session pins search_path EMPTY and no AST exists, so
    // qualification is a CLOSED-FORM rewrite of runner-owned frozen text: every
    // baseline statement must match the single permitted shape exactly, or the
    // module fails closed at load. `now()` resolves via implicit pg_catalog.
    // Exactly three closed shapes exist in the frozen baseline; anything else fails closed.
    const t = /^CREATE TABLE IF NOT EXISTS ([a-z_][a-z0-9_]*)\(([\s\S]*)$/.exec(text);
    if (t) return `CREATE TABLE IF NOT EXISTS "public"."${t[1]}"(${t[2]}`;
    const i = /^CREATE (UNIQUE )?INDEX IF NOT EXISTS ([a-z_][a-z0-9_]*) ON ([a-z_][a-z0-9_]*)\(([\s\S]*)$/.exec(text);
    // PG forbids schema-qualifying the index NAME; qualifying the TABLE pins the index schema deterministically.
    if (i) return `CREATE ${i[1] ?? ''}INDEX IF NOT EXISTS "${i[2]}" ON "public"."${i[3]}"(${i[4]}`;
    throw new Error(`release-migrations: TEMPLATE integrity refusal - frozen baseline statement deviates from its closed shapes: ${text.slice(0, 80)}`);
  });

/** R5 section 1: the registry is INERT CANONICAL DATA - shape strings with
 *  named placeholders, data parameter declarations, named forms, canonical
 *  sample vectors. Zero render closures exist anywhere in it. */
const TEMPLATES: readonly TemplateEntry[] = [
  {
    name: 'init.schema-baseline.0001',
    description: '0001 graph + OTP schema baseline (frozen DDL constants; IF NOT EXISTS adoption).',
    params: {},
    writesCatalogs: ['owner_rel', 'acl_rel'],
    shapes: BASELINE_0001_STATEMENTS,
    sample: {},
  },
  {
    name: 'ddl.create-index',
    description: 'Create an index on ONE controlled-schema table; expression only via a NAMED form; predicate only via a NAMED form.',
    params: {
      index: { kind: 'identifier', quote: 'bare' },
      table: { kind: 'identifier', quote: 'schema' },
      unique: { kind: 'enum', values: ['unique', 'plain'], fragments: { unique: 'UNIQUE ', plain: '' } },
      ifNotExists: { kind: 'enum', values: ['if-not-exists', 'strict'], fragments: { 'if-not-exists': 'IF NOT EXISTS ', strict: '' } },
      expression: { kind: 'expression', forms: 'expressions', nonEmpty: '{form}', empty: '"{table}"' },
      predicate: { kind: 'expression', forms: 'predicates', nonEmpty: ' WHERE {form}', empty: '' },
    },
    writesCatalogs: ['owner_rel', 'acl_rel'],
    shapes: ['CREATE {unique}INDEX {ifNotExists}{index} ON {table} ({expression}){predicate}'],
    sample: { index: 'sa_idx', table: 'users', unique: 'unique', expression: 'EXPR_NORM_PHONE', predicate: 'PRED_PHONE_NOT_NULL', ifNotExists: 'if-not-exists' },
  },
  {
    name: 'data.normalize-users-phone',
    description:
      'SA lane DATA family: normalize users.phone AND the embedded data.phone JSON key via NAMED closed forms ' +
      '(value-preserving; never picks a representation winner, never deletes). Writes ROW DATA only - no catalog classes.',
    params: {
      table: { kind: 'identifier', quote: 'schema' },
      column: { kind: 'identifier', quote: 'bare' },
      jsonColumn: { kind: 'identifier', quote: 'bare' },
      // The JSON key enters ONLY as this closed enum literal (no free text):
      jsonKey: { kind: 'enum', values: ['phone'], fragments: { phone: `'phone'` } },
      // SA1 ruling: the normalizations enter ONLY as named closed forms:
      columnNorm: { kind: 'expression', forms: 'normalizations', nonEmpty: '{form}', empty: '{column}' },
      jsonNorm: { kind: 'expression', forms: 'normalizations', nonEmpty: '{form}', empty: '{jsonColumn}->>{jsonKey}' },
    },
    writesCatalogs: [],
    shapes: [
      'UPDATE {table} SET {column} = {columnNorm}, ' +
      '{jsonColumn} = CASE WHEN ({jsonColumn}->>{jsonKey}) IS NOT NULL ' +
      'THEN pg_catalog.jsonb_set({jsonColumn}, ARRAY[{jsonKey}], coalesce(pg_catalog.to_jsonb({jsonNorm}), ' + "'null'::jsonb" + '), false) ' +
      'ELSE {jsonColumn} END ' +
      'WHERE ({column} IS DISTINCT FROM {columnNorm}) ' +
      'OR (({jsonColumn}->>{jsonKey}) IS NOT NULL AND ({jsonColumn}->>{jsonKey}) IS DISTINCT FROM {jsonNorm})',
    ],
    sample: { table: 'users', column: 'phone', jsonColumn: 'data', jsonKey: 'phone', columnNorm: 'NORM_COL_BTRIM_NULLIF_EMPTY', jsonNorm: 'NORM_JSON_BTRIM_NULLIF_EMPTY' },
  },
];

/** R5 section 1: the ONE assembly mechanism over the inert data. Runner code
 *  is anchored by the code trust chain (exact head SHA -> frozen lockfile ->
 *  literal build -> dist hashes -> instance pin); the BLUEPRINT it interprets
 *  is anchored by REGISTRY_DIGEST. Two distinct anchors; neither impersonates
 *  the other. */
function fragmentFor(decl: ParamDecl, value: unknown, paramName: string): string {
  switch (decl.kind) {
    case 'identifier': {
      const v = bindIdentifier(value, paramName);
      return decl.quote === 'schema' ? `"${CONTROLLED_SCHEMA}"."${v}"` : `"${v}"`;
    }
    case 'enum': {
      const v = bindEnum(value, paramName, decl.values);
      const f = decl.fragments[v];
      if (f === undefined) templateRefusal(`enum param '${paramName}' has no declared fragment for ${JSON.stringify(v)}`);
      return f;
    }
    case 'expression': {
      const forms = decl.forms === 'expressions' ? NAMED_EXPRESSIONS : decl.forms === 'predicates' ? NAMED_PREDICATES : NAMED_NORMALIZATIONS;
      const form = bindExpression(value, paramName, forms);
      return (form === '' ? decl.empty : decl.nonEmpty).replaceAll('{form}', form);
    }
  }
}

function assembleShape(shape: string, t: TemplateEntry, params: Readonly<Record<string, unknown>>): string {
  let text = shape;
  // Two passes: fragments may themselves reference params (e.g. '"{table}"').
  for (let pass = 0; pass < 2; pass++) {
    for (const [pname, decl] of Object.entries(t.params)) {
      text = text.replaceAll(`{${pname}}`, fragmentFor(decl, params[pname], pname));
    }
  }
  if (/\{[a-zA-Z]+\}/.test(text)) templateRefusal(`unresolved placeholder in assembled statement: ${text.slice(0, 80)}`);
  return text;
}

const templateByName = new Map(TEMPLATES.map(t => [t.name, t]));
function getTemplate(name: string): TemplateEntry {
  const t = templateByName.get(name);
  if (!t) templateRefusal(`unknown template name ${JSON.stringify(name)} - the registry is closed`);
  return t!;
}
/** Validate a step's params against the template declarations (exact own-key
 *  sets) and assemble the bound statements the runner executes - through the
 *  ONE mechanism, over the inert blueprint data. */
function renderStepStatements(m: MigrationStep): readonly RenderedStatement[] {
  const t = getTemplate(m.template);
  const params = m.params ?? {};
  const specKeys = Object.keys(t.params).sort();
  const given = Object.keys(params).sort();
  if (JSON.stringify(given) !== JSON.stringify(specKeys)) {
    templateRefusal(`step '${m.version}' params ${JSON.stringify(given)} do not exactly match template '${t.name}' schema ${JSON.stringify(specKeys)}`);
  }
  return t.shapes.map(shape => ({ text: assembleShape(shape, t, params), values: [] as unknown[] }));
}

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
/** Key-sorted canonical JSON for the declared-primitive digest component. */
const canonicalJson = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
};

/** R4 section 1: deep freeze at load - the registry, named forms and frozen
 *  baseline derivations are module-private AND immutable in-process. */
const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object') {
    for (const k of Object.keys(o as Record<string, unknown>)) deepFreeze((o as Record<string, unknown>)[k]);
    Object.freeze(o);
  }
  return o;
};
deepFreeze(NAMED_EXPRESSIONS);
deepFreeze(NAMED_PREDICATES);
deepFreeze(NAMED_NORMALIZATIONS);
deepFreeze(TEMPLATES);

/** R4 section 1: ONE canonical serialization of the full frozen blueprint,
 *  hashed at module load AFTER freezing, from the private state. Anchor A
 *  records this value from reviewed source; anchor B records it in the
 *  migration identity at the first pinned governed run. */
/** R5 sections 1+2: ONE canonical digest over the blueprint DATA ONLY.
 *  Nothing executable-as-text, nothing build-derived, no Function.toString
 *  anywhere - toolchain-independent by construction (like the DATA digest):
 *  source/tsx, tsc dist, vitest and the real-PG run all compute the SAME
 *  value. Anchor A records this value from reviewed source; anchor B records
 *  it in the migration identity at the first pinned governed run. */
/** SA2 preimage discipline (ruling 2026-09-19): the digest preimage is an
 *  EXPLICIT, canonical, independently enumerable manifest - one entry per
 *  artifact with executable semantics (runner-owned closed templates, named
 *  expressions, named predicates, named normalizations, frozen baselines, and
 *  any future named structure). Each entry carries a role tag, identifier and
 *  CONTENT HASH; nothing with semantic effect may exist outside the manifest.
 *  The manifest exposes HASHES ONLY - no render content leaves the module
 *  (R4 confinement preserved); reviewers recompute content hashes from
 *  reviewed source, then the manifest digest. */
export interface BlueprintManifestEntry {
  readonly role: 'template' | 'named-expression' | 'named-predicate' | 'named-normalization' | 'frozen-baseline' | 'runner-ddl';
  readonly id: string;
  readonly contentHash: string;
}
const manifestMemberHash = (role: string, id: string, content: unknown): string =>
  createHash('sha256').update(`contake-manifest-member/v1\n${role}\n${id}\n${canonicalJson(content)}`).digest('hex');

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
ALTER TABLE public.contake_db_identity ADD COLUMN IF NOT EXISTS registry_digest text;
`;

const RUNNER_EVIDENCE_DDL = `
CREATE TABLE IF NOT EXISTS public.schema_migration_evidence(
  seq bigserial PRIMARY KEY,
  event_id text NOT NULL,
  version text NOT NULL,
  kind text NOT NULL,
  report jsonb NOT NULL,
  list_digest text NOT NULL,
  target text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id)
);
ALTER TABLE public.schema_migration_evidence ADD COLUMN IF NOT EXISTS event_id text;
UPDATE public.schema_migration_evidence SET event_id = 'legacy-' || seq::text WHERE event_id IS NULL;
ALTER TABLE public.schema_migration_evidence ALTER COLUMN event_id SET NOT NULL;
ALTER TABLE public.schema_migration_evidence DROP CONSTRAINT IF EXISTS schema_migration_evidence_version_kind_key;
CREATE UNIQUE INDEX IF NOT EXISTS schema_migration_evidence_event_id_key ON public.schema_migration_evidence(event_id)`;

/** SA3 section 4: issued-nonce ack lifecycle (runner-owned). Every ack is a
 *  PERSISTED record minted by the preflight issuance path - an arbitrary
 *  nonce plus the public canonical digest constructs nothing (Q1). State
 *  transitions are guarded single-row UPDATEs (state='issued' precondition):
 *  consumption and invalidation are mutually exclusive and a second
 *  transition attempt is a LOUD conflict, never a silent no-op (Q2). */
const RUNNER_ACK_DDL = `
CREATE TABLE IF NOT EXISTS public.schema_migration_acks(
  nonce text PRIMARY KEY,
  target text NOT NULL,
  deployment_label text NOT NULL,
  plan_digest text NOT NULL,
  list_digest text NOT NULL,
  state text NOT NULL CHECK (state IN ('issued','consumed','invalidated')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  transitioned_at timestamptz
)`;

/** SA3 section 5: DIRTY/INDETERMINATE target marker (runner-owned). An
 *  evidence-write failure marks the target dirty and BLOCKS all subsequent
 *  ack issuance and migration runs until attended resolution. This is a
 *  singleton state marker, not the append-only evidence trail; the trail
 *  records the attended resolution as its own unique append-only event. */
const RUNNER_TARGET_STATE_DDL = `
CREATE TABLE IF NOT EXISTS public.schema_migration_target_state(
  target text PRIMARY KEY,
  dirty boolean NOT NULL DEFAULT false,
  dirty_reason jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;


const buildBlueprintManifest = (): readonly BlueprintManifestEntry[] => {
  const entries: BlueprintManifestEntry[] = [];
  entries.push({ role: 'frozen-baseline', id: '0001-baseline', contentHash: manifestMemberHash('frozen-baseline', '0001-baseline', BASELINE_0001_STATEMENTS) });
  // SA2-A ruling section 3(a): runner-owned bookkeeping DDL (ledger + evidence)
  // is a closed runner-owned template and a MANIFEST MEMBER - tampering with
  // the evidence schema flips REGISTRY_DIGEST like any other member.
  entries.push({ role: 'runner-ddl', id: 'runner-ddl.schema-migrations+identity', contentHash: manifestMemberHash('runner-ddl', 'runner-ddl.schema-migrations+identity', RUNNER_DDL) });
  entries.push({ role: 'runner-ddl', id: 'runner-ddl.schema-migration-evidence', contentHash: manifestMemberHash('runner-ddl', 'runner-ddl.schema-migration-evidence', RUNNER_EVIDENCE_DDL) });
  // SA3: the ack-lifecycle and dirty-marker bookkeeping DDL are runner-owned
  // closed templates and MANIFEST MEMBERS on the same terms.
  entries.push({ role: 'runner-ddl', id: 'runner-ddl.schema-migration-acks', contentHash: manifestMemberHash('runner-ddl', 'runner-ddl.schema-migration-acks', RUNNER_ACK_DDL) });
  entries.push({ role: 'runner-ddl', id: 'runner-ddl.schema-migration-target-state', contentHash: manifestMemberHash('runner-ddl', 'runner-ddl.schema-migration-target-state', RUNNER_TARGET_STATE_DDL) });
  for (const t of TEMPLATES) {
    // description is operator display metadata (not executable) - excluded,
    // consistent with step-digest doctrine.
    entries.push({ role: 'template', id: t.name, contentHash: manifestMemberHash('template', t.name, { params: t.params, shapes: t.shapes, writesCatalogs: t.writesCatalogs }) });
  }
  for (const [family, map, role] of [
    ['expressions', NAMED_EXPRESSIONS, 'named-expression'],
    ['predicates', NAMED_PREDICATES, 'named-predicate'],
    ['normalizations', NAMED_NORMALIZATIONS, 'named-normalization'],
  ] as const) {
    for (const k of Object.keys(map).sort()) {
      entries.push({ role, id: `${family}.${k}`, contentHash: manifestMemberHash(role, `${family}.${k}`, map[k]) });
    }
  }
  return entries;
};

/** Anchor A surface (SA2): the canonical manifest - detached, frozen, HASHES
 *  ONLY. Every member is inside the effective preimage BY CONSTRUCTION;
 *  per-member tamper moves the digest (constructive regression in the suite). */
export const BLUEPRINT_MANIFEST: readonly BlueprintManifestEntry[] = deepFreeze([...buildBlueprintManifest()]);

/** PURE member-hash computation over caller-supplied data (SA2
 *  constructive-verification seam; same recipe the manifest uses). */
export function manifestMemberHashForReview(role: string, id: string, content: unknown): string {
  return manifestMemberHash(role, id, content);
}

/** PURE canonical digest over caller-supplied manifest entries (SA2
 *  constructive-verification seam; computes over data only). */
export function digestManifestForReview(entries: readonly BlueprintManifestEntry[]): string {
  return createHash('sha256').update(`contake-registry/v3\n${canonicalJson(entries)}`).digest('hex');
}

export const REGISTRY_DIGEST: string = digestManifestForReview(BLUEPRINT_MANIFEST);

/** R4 section 4: single-statement construction guarantee. Exported ONLY as a
 *  pure assertion over caller-supplied forms (no registry content leaves the
 *  module) so the evidence suite can observe the refusal on tampered forms;
 *  module load runs it over the private frozen registry below. */
export function assertSingleStatementForms(forms: readonly string[], ctx: string): void {
  for (const f of forms) {
    if (f.includes(';')) {
      throw new Error(
        `release-migrations: LOAD INTEGRITY refusal - statement separator in ${ctx}: ${JSON.stringify(f.slice(0, 100))} - ` +
        `the runner module refuses to load with a multi-statement shape (fail-closed)`,
      );
    }
  }
}
{
  // Load-time assertion over the private frozen registry: every template
  // shape, assembled from its DECLARED canonical sample vector (data), and
  // every named form - a statement separator refuses the module at load.
  for (const t of TEMPLATES) {
    const rendered = renderStepStatements({ version: '0000', name: 'load-check', description: 'load-check', template: t.name, params: t.sample });
    assertSingleStatementForms(rendered.map(st => st.text), `template '${t.name}'`);
  }
  assertSingleStatementForms(Object.values(NAMED_EXPRESSIONS), 'NAMED_EXPRESSIONS');
  assertSingleStatementForms(Object.values(NAMED_PREDICATES), 'NAMED_PREDICATES');
  assertSingleStatementForms(Object.values(NAMED_NORMALIZATIONS), 'NAMED_NORMALIZATIONS');
}

const STATEMENT_CATALOG_MATRIX: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  TEMPLATES.map(t => [t.name, t.writesCatalogs]),
);
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
export async function sequenceValues(conn: Queryable): Promise<Map<string, SeqVal>> {
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
export async function restoreSequenceValues(conn: Queryable, before: Map<string, SeqVal>): Promise<string[]> {
  const now = await sequenceValues(conn);
  const restored: string[] = [];
  for (const [name, bv] of before) {
    const nv = now.get(name);
    // No swallow anywhere in the restore path: a sequence that VANISHED since
    // capture cannot be restored - that is an explicit restore failure with
    // dirty/indeterminate labeling, never a silent skip.
    if (!nv) throw new Error(`release-migrations: SEQUENCE RESTORE failure (DIRTY/INDETERMINATE) - "${name}" vanished since capture; pinned value ${bv.lastValue} (is_called=${bv.isCalled}) cannot be restored`);
    if (nv.lastValue !== bv.lastValue || nv.isCalled !== bv.isCalled) {
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
      if (a.normalize !== undefined && a.normalize !== 'btrim' && a.normalize !== 'btrim-nullif-empty' && a.normalize !== 'none') {
        throw new Error(`release-migrations: assertion normalize must be exactly 'btrim', 'btrim-nullif-empty' or 'none', got ${JSON.stringify(a.normalize)}`);
      }
      if (a.skipNulls !== undefined && typeof a.skipNulls !== 'boolean') {
        throw new Error(`release-migrations: assertion skipNulls must be an exact boolean, got ${JSON.stringify(a.skipNulls)}`);
      }
      // SA1 ruling (2026-09-19): 'btrim-nullif-empty' treats blank as ABSENCE -
      // the grouping key is NULLIF(btrim,'') and NULL keys never collide
      // (two absent phones are not the same phone).
      // SA3 section 6: the key is built from the NAMED_NORMALIZATIONS
      // registry members themselves (ONE source of truth - no detached
      // literal copy; the constructive tamper matrix proves the wiring).
      const key = a.normalize === 'btrim-nullif-empty' ? NAMED_NORMALIZATIONS['NORM_COL_BTRIM_NULLIF_EMPTY']!.replaceAll('{column}', `"${c}"`)
        : a.normalize === 'btrim' ? NAMED_NORMALIZATIONS['NORM_COL_BTRIM']!.replaceAll('{column}', `"${c}"`) : `"${c}"`;
      const where = a.normalize === 'btrim-nullif-empty'
        ? (a.skipNulls === false ? '' : ` WHERE ${key} IS NOT NULL`)
        : (a.skipNulls === false ? '' : ` WHERE "${c}" IS NOT NULL`);
      return `SELECT 1 AS violation FROM "${CONTROLLED_SCHEMA}"."${t}"${where} GROUP BY ${key} HAVING pg_catalog.count(*) > 1 LIMIT 1`;
    }
    default:
      throw new Error(`release-migrations: unknown assertion kind ${JSON.stringify((a as { kind?: string }).kind)} - named runner-owned kinds only`);
  }
}
export function validateAssertion(a: MigrationAssertion): void {
  buildAssertionQuery(a); // throws on invalid identifiers/kinds/keys
}


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
  // Inert-data integrity: template name + HASH-PINNED template identity +
  // canonical typed params. Tampering with artifact bytes (params) or the
  // registry (template source) changes the digest and fails history checks.
  const t = getTemplate(m.template);
  const params = m.params ?? {};
  const specKeys = Object.keys(t.params).sort();
  if (JSON.stringify(Object.keys(params).sort()) !== JSON.stringify(specKeys)) {
    templateRefusal(`step '${m.version}' params do not exactly match template '${t.name}' schema`);
  }
  return createHash('sha256').update(
    `contake-migration/v9\n${REGISTRY_DIGEST}\n${m.version}\n${m.name}\n${m.template}\n${canonicalJson({
      params, assertions: m.assertions ?? [], lockTables: m.lockTables ?? [], xactLockKey: m.xactLockKey ?? null,
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
    template: 'init.schema-baseline.0001',
    params: {},
  },
  // SA lane plug-in (landed 2026-09-19, declarative-only per the R3
  // contract; supersedes the commented sketch): migrateUsersPhone is
  // re-expressed as TWO inert-data steps - one step = one template, and
  // artifact SQL no longer exists. 0002 normalizes ROW DATA through the
  // closed DATA template family (never general DML); 0003 creates the
  // canonical expression index through named forms. Both steps carry the SA
  // migration xact lock + users table lock + the collision guard as runner
  // primitives. The companion read-only structured preflight
  // (cross-representation collision/inconsistency reporting) remains
  // operator evidence OUTSIDE the migration artifact - the closed guard
  // union intentionally cannot express it.
  {
    version: '0002',
    name: 'users-phone-normalize',
    description:
      'SA lane (SA1 ruling 2026-09-19): trim users.phone and data.phone JSON to their own values ' +
      "with blank-as-ABSENCE (NULLIF(btrim(x),'') -> NULL; the partial index then excludes absent phones " +
      'by construction). Fail-loud on normalized REAL-phone collisions; never deletes, never picks a representation winner.',
    template: 'data.normalize-users-phone',
    params: { table: 'users', column: 'phone', jsonColumn: 'data', jsonKey: 'phone', columnNorm: 'NORM_COL_BTRIM_NULLIF_EMPTY', jsonNorm: 'NORM_JSON_BTRIM_NULLIF_EMPTY' },
    xactLockKey: 7263849598301, // 'users-phone-migration'
    lockTables: ['users'],
    requiresOperatorAck: true,
    assertions: [{ kind: 'no-duplicates', table: 'users', column: 'phone', normalize: 'btrim-nullif-empty', skipNulls: true }],
  },
  {
    version: '0003',
    name: 'users-phone-unique-index',
    description: 'users_phone_unique canonical partial unique index on btrim(phone) (SA lane).',
    template: 'ddl.create-index',
    params: { index: 'users_phone_unique', table: 'users', unique: 'unique', expression: 'EXPR_NORM_PHONE', predicate: 'PRED_PHONE_NOT_NULL', ifNotExists: 'if-not-exists' },
    xactLockKey: 7263849598301, // 'users-phone-migration'
    lockTables: ['users'],
    requiresOperatorAck: true,
    // SA1 ruling: guard re-fires AFTER normalization with blank-as-absence.
    assertions: [{ kind: 'no-duplicates', table: 'users', column: 'phone', normalize: 'btrim-nullif-empty', skipNulls: true }],
  },
];

export const EXPECTED_SCHEMA_VERSIONS: readonly string[] = MIGRATIONS.map(m => m.version);

const RUNNER_LOCK_KEY = 841_000_001;

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
  opts: { deployment: string; expectInstanceId?: string; expectRegistryDigest?: string },
): Promise<{ firstRun: boolean; identity?: DbIdentity }> {
  if (!DEPLOYMENT_LABEL.test(opts.deployment)) {
    throw new Error(`release-migrations: invalid deployment label ${JSON.stringify(opts.deployment)} (expected ${DEPLOYMENT_LABEL})`);
  }
  // R5 section 2/3: a wrong registry-digest pin refuses BEFORE any write, on
  // first-run TOFU and on stamped databases alike (authenticity, not
  // self-consistency - the pin is the operator's independently recomputed
  // expectation from reviewed source).
  if (opts.expectRegistryDigest !== undefined && opts.expectRegistryDigest !== REGISTRY_DIGEST) {
    throw new Error(
      `release-migrations: REGISTRY PIN refusal - operator pinned registry digest ${String(opts.expectRegistryDigest).slice(0, 16)}... ` +
      `but the running blueprint computes ${REGISTRY_DIGEST.slice(0, 16)}... Refusing BEFORE any write (fail-closed).`,
    );
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
    renderStepStatements(m); // unknown template / param-schema drift refuses here
    for (const a of m.assertions ?? []) validateAssertion(a);
    for (const t of m.lockTables ?? []) {
      if (typeof t !== 'string' || !IDENT_STRICT.test(t)) throw new Error(`release-migrations: invalid lockTables identifier ${JSON.stringify(t)}`);
    }
    if (m.requiresOperatorAck !== undefined && typeof m.requiresOperatorAck !== 'boolean') {
      throw new Error('release-migrations: requiresOperatorAck must be an exact boolean');
    }
    if (m.xactLockKey !== undefined && (!Number.isSafeInteger(m.xactLockKey) || m.xactLockKey < 0)) {
      throw new Error('release-migrations: xactLockKey must be a non-negative safe integer');
    }
  }
}

/** SA2 canonical operator preflight (runner-owned, the ONE implementation -
 *  the read-only companion script AND the in-transaction gate both use this,
 *  so a wrapper can never substitute a different list). READ-ONLY queries.
 *  SA2-A: the report binds THE PLAN (the pending gated steps' identities:
 *  version + name + step digest) PLUS target identity (current_database() +
 *  deployment) PLUS the canonical inconsistency lists PLUS an operator
 *  nonce - the ack authorizes ONE attended run of ONE plan on ONE target in
 *  ONE state, and a re-mint is always a fresh string (fresh nonce). */
export interface OperatorPlanStep { readonly version: string; readonly name: string; readonly sha256: string }
export interface OperatorPreflightReport {
  readonly target: string;
  readonly deployment: string;
  readonly plan: readonly OperatorPlanStep[];
  readonly nonce: string;
  readonly collisionGroups: readonly unknown[];
  readonly crossRepresentationInconsistencies: readonly unknown[];
  readonly blankPhoneUsers: readonly unknown[];
}
/** PURE canonical listDigest over a caller-supplied preflight report (SA2-A
 *  constructive-verification seam; computes over data only). */
export function operatorListDigestForReview(report: OperatorPreflightReport): string {
  return createHash('sha256').update(`contake-operator-preflight/v2\n${canonicalJson(report)}`).digest('hex');
}
/** The gated steps still pending given the applied history (plan identity). */
function pendingGatedSteps(applied: readonly AppliedMigrationRow[], migrations: readonly MigrationStep[]): readonly MigrationStep[] {
  return migrations.slice(applied.length).filter(m => m.requiresOperatorAck === true);
}
export async function computeUsersPhonePreflight(
  conn: Queryable,
  opts: { deployment: string; migrations?: readonly MigrationStep[]; nonce?: string },
): Promise<OperatorPreflightReport & { listDigest: string }> {
  const migrations = opts.migrations ?? MIGRATIONS;
  const NORM = `NULLIF(pg_catalog.btrim(phone), '')`;
  const JNORM = `NULLIF(pg_catalog.btrim(data->>'phone'), '')`;
  const t = await conn.query(`SELECT pg_catalog.current_database() AS d`);
  const target = String(t.rows[0]?.['d']);
  const applied = await readAppliedRows(conn);
  const plan: OperatorPlanStep[] = pendingGatedSteps(applied, migrations).map(m => ({ version: m.version, name: m.name, sha256: stepDigest(m) }));
  // Fresh databases (pre-0001) have no users table yet: the attended list is
  // EMPTY, and the runner's in-transaction recompute (after 0001 creates the
  // table, still empty) matches it. Existing databases list real state.
  const reg = await conn.query(`SELECT pg_catalog.to_regclass('public.users') AS r`);
  const lists = reg.rows[0]?.['r']
    ? {
        collisionGroups: (await conn.query(
          `SELECT ${NORM} AS norm_phone, jsonb_agg(jsonb_build_object('userId', user_id, 'orgId', org_id) ORDER BY user_id) AS users
           FROM "public"."users" WHERE ${NORM} IS NOT NULL GROUP BY ${NORM} HAVING pg_catalog.count(*) > 1 ORDER BY 1`)).rows,
        crossRepresentationInconsistencies: (await conn.query(
          `SELECT user_id AS "userId", org_id AS "orgId", ${NORM} AS "columnPhone", ${JNORM} AS "jsonPhone"
           FROM "public"."users" WHERE ${NORM} IS NOT NULL AND ${JNORM} IS NOT NULL AND ${NORM} <> ${JNORM} ORDER BY user_id`)).rows,
        blankPhoneUsers: (await conn.query(
          `SELECT user_id AS "userId", org_id AS "orgId" FROM "public"."users"
           WHERE phone IS NOT NULL AND ${NORM} IS NULL ORDER BY user_id`)).rows,
      }
    : { collisionGroups: [], crossRepresentationInconsistencies: [], blankPhoneUsers: [] };
  const report: OperatorPreflightReport = {
    target, deployment: opts.deployment, plan, nonce: opts.nonce ?? randomBytes(8).toString('hex'), ...lists,
  };
  return { ...report, listDigest: operatorListDigestForReview(report) };
}
/** The exact ack string the operator must supply for THIS plan+target+state.
 *  Format: ack:<nonce>:<listDigest> - the nonce rides along so the runner can
 *  recompute the digest; single-use is enforced on the full string. */
export function operatorAckFor(preflight: { nonce: string; listDigest: string }): string {
  return `ack:${preflight.nonce}:${preflight.listDigest}`;
}
const ACK_FORMAT = /^ack:([0-9a-f]{16}):([0-9a-f]{64})$/;

/** SA3 section 4: canonical plan digest (the pending gated steps'
 *  identities: version + name + step digest) - the ack record binds it
 *  separately so a plan mismatch is directly inspectable. */
const planDigestFor = (plan: readonly OperatorPlanStep[]): string =>
  createHash('sha256').update(`contake-operator-plan/v1\n${canonicalJson(plan)}`).digest('hex');

/** Runner-owned bookkeeping DDL, idempotently ensured inside the caller's
 *  transaction (the caller holds the session advisory lock). Shared by
 *  runMigrations bootstrap AND preflight issuance - SA3: issuance persists,
 *  so the bookkeeping must exist before the first governed run. Evidence
 *  writes are plain unique-event INSERTs: NO ON CONFLICT DO NOTHING anywhere
 *  in the evidence path (SA3 section 5); a conflict is a LOUD failure. */
async function ensureRunnerBookkeeping(client: Queryable): Promise<void> {
  const evBefore = await client.query(`SELECT to_regclass('public.schema_migration_evidence') AS r`);
  for (const ddl of [RUNNER_DDL, RUNNER_EVIDENCE_DDL, RUNNER_ACK_DDL, RUNNER_TARGET_STATE_DDL]) {
    for (const stmt of ddl.split(';').map(s => s.trim()).filter(Boolean)) await client.query(stmt);
  }
  if (!evBefore.rows[0]?.['r']) {
    // The evidence table's own bootstrap creation is recorded once
    // (post-creation self-record). Check-then-insert under the session
    // advisory lock is race-free; no silent-conflict escape hatch exists.
    const member = BLUEPRINT_MANIFEST.find(e => e.id === 'runner-ddl.schema-migration-evidence')!;
    const existing = await client.query(`SELECT 1 FROM public.schema_migration_evidence WHERE kind = 'runner-bootstrap' LIMIT 1`);
    if (existing.rows.length === 0) {
      await client.query(
        `INSERT INTO public.schema_migration_evidence(event_id, version, kind, report, list_digest, target) VALUES($1, '0000', 'runner-bootstrap', $2::jsonb, $3, pg_catalog.current_database())`,
        [randomBytes(16).toString('hex'), JSON.stringify({ table: 'schema_migration_evidence', createdBy: 'runner-bootstrap', ddlContentHash: member.contentHash }), member.contentHash],
      );
    }
  }
}

/** SA3 section 5: a DIRTY/INDETERMINATE target blocks all ack issuance and
 *  all migration runs until attended resolution (attendedResolveDirty). */
async function assertTargetNotDirty(client: Queryable): Promise<void> {
  const d = await client.query(`SELECT dirty, dirty_reason FROM public.schema_migration_target_state WHERE target = pg_catalog.current_database()`);
  if (d.rows[0]?.['dirty'] === true) {
    throw new Error(
      `release-migrations: DIRTY TARGET refusal - this database is marked DIRTY/INDETERMINATE ` +
      `(reason: ${JSON.stringify(d.rows[0]['dirty_reason'])}); attended resolution via attendedResolveDirty is required ` +
      `before any further preflight issuance or migration run (fail-closed)`,
    );
  }
}

/** SA3 section 4: preflight ISSUANCE - the ONLY way an ack comes into
 *  existence. Under the runner's session advisory lock: recompute the
 *  canonical preflight, mint a unique nonce, and PERSIST the issued record
 *  bound to target + deployment + plan + listDigest, plus a unique
 *  append-only 'ack-issued' evidence event. No nonce record, no ack: an
 *  arbitrary nonce plus the public canonical digest constructs nothing. */
export async function issueOperatorPreflight(
  conn: Connectable,
  opts: { deployment: string; migrations?: readonly MigrationStep[] },
): Promise<OperatorPreflightReport & { listDigest: string }> {
  const client = await conn.connect();
  try {
    await client.query(`SET search_path = ''`);
    await client.query(`SELECT pg_catalog.pg_advisory_lock(${RUNNER_LOCK_KEY})`);
    try {
      await client.query('BEGIN');
      try {
        await ensureRunnerBookkeeping(client);
        await assertTargetNotDirty(client);
        const pf = await computeUsersPhonePreflight(client, { deployment: opts.deployment, migrations: opts.migrations });
        await client.query(
          `INSERT INTO public.schema_migration_acks(nonce, target, deployment_label, plan_digest, list_digest, state) VALUES($1, $2, $3, $4, $5, 'issued')`,
          [pf.nonce, pf.target, pf.deployment, planDigestFor(pf.plan), pf.listDigest],
        );
        await client.query(
          `INSERT INTO public.schema_migration_evidence(event_id, version, kind, report, list_digest, target) VALUES($1, '0000', 'ack-issued', $2::jsonb, $3, $4)`,
          [randomBytes(16).toString('hex'), JSON.stringify({
            nonce: pf.nonce, deployment: pf.deployment, plan: pf.plan,
            collisionGroups: pf.collisionGroups, crossRepresentationInconsistencies: pf.crossRepresentationInconsistencies, blankPhoneUsers: pf.blankPhoneUsers,
          }), pf.listDigest, pf.target],
        );
        await client.query('COMMIT');
        return pf;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
    } finally {
      await client.query(`SELECT pg_catalog.pg_advisory_unlock(${RUNNER_LOCK_KEY})`).catch(() => undefined);
      await client.query(`RESET ALL`).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

/** SA3 section 5: ATTENDED resolution of a DIRTY/INDETERMINATE target.
 *  Requires an operator note; records a unique append-only 'dirty-resolved'
 *  evidence event retaining the prior dirty reason, then clears the marker. */
export async function attendedResolveDirty(conn: Connectable, opts: { note: string; resolvedBy?: string }): Promise<void> {
  if (typeof opts.note !== 'string' || opts.note.trim().length < 8) {
    throw new Error('release-migrations: attended DIRTY resolution requires an operator note (>= 8 chars) - refusing (fail-closed)');
  }
  const client = await conn.connect();
  try {
    await client.query(`SET search_path = ''`);
    await client.query(`SELECT pg_catalog.pg_advisory_lock(${RUNNER_LOCK_KEY})`);
    try {
      await client.query('BEGIN');
      try {
        const d = await client.query(`SELECT dirty, dirty_reason FROM public.schema_migration_target_state WHERE target = pg_catalog.current_database() FOR UPDATE`);
        if (d.rows.length === 0 || d.rows[0]!['dirty'] !== true) {
          throw new Error('release-migrations: attended DIRTY resolution refused - this target is NOT dirty (nothing to resolve)');
        }
        await client.query(
          `INSERT INTO public.schema_migration_evidence(event_id, version, kind, report, list_digest, target) VALUES($1, '0000', 'dirty-resolved', $2::jsonb, 'dirty-resolved', pg_catalog.current_database())`,
          [randomBytes(16).toString('hex'), JSON.stringify({ priorDirtyReason: d.rows[0]!['dirty_reason'], resolutionNote: opts.note, resolvedBy: opts.resolvedBy ?? 'operator' })],
        );
        await client.query(
          `UPDATE public.schema_migration_target_state SET dirty = false, dirty_reason = $1::jsonb, updated_at = now() WHERE target = pg_catalog.current_database()`,
          [JSON.stringify({ resolved: true, note: opts.note })],
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
    } finally {
      await client.query(`SELECT pg_catalog.pg_advisory_unlock(${RUNNER_LOCK_KEY})`).catch(() => undefined);
      await client.query(`RESET ALL`).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

/** SA2-A section 2(c): canonical state projection the gated plan's safety
 *  depends on, ALREADY normalized (NULLIF(btrim,'')) - idempotent under the
 *  plan's own mutation, so the post-step digest must equal the pre-step
 *  digest exactly; any deviation (interleaving write, wrong mutation) aborts. */
const USERS_STATE_PROJECTION =
  `SELECT user_id AS u, org_id AS o, NULLIF(pg_catalog.btrim(phone), '') AS p, NULLIF(pg_catalog.btrim(data->>'phone'), '') AS jp
   FROM "public"."users" ORDER BY user_id`;
async function usersStateDigest(conn: Queryable): Promise<string> {
  const reg = await conn.query(`SELECT pg_catalog.to_regclass('public.users') AS r`);
  if (!reg.rows[0]?.['r']) return createHash('sha256').update('contake-users-state/v1\n[]').digest('hex');
  const r = await conn.query(USERS_STATE_PROJECTION);
  return createHash('sha256').update(`contake-users-state/v1\n${canonicalJson(r.rows)}`).digest('hex');
}

/** Applies every pending migration in registry order. */
export async function runMigrations(
  conn: Connectable,
  opts: { deployment: string; appliedBy?: string; migrations?: readonly MigrationStep[]; expectInstanceId?: string; expectRegistryDigest?: string; operatorAck?: string },
): Promise<MigrationRunResult> {
  const migrations = opts.migrations ?? MIGRATIONS;
  validateRegistry(migrations);

  const client = await conn.connect();
  let identity: DbIdentity;
  let stampedNow = false;
  let applied: AppliedMigrationRow[];
  const appliedNow: string[] = [];
  /** SA2: an ack accepted by an earlier gated step IN THIS RUN covers the
   *  later gated steps of the same attended sequence (0002 normalizes the
   *  rows, which legitimately moves the recomputed lists for 0003). The
   *  recompute still runs; the continuation match holds only inside this
   *  locked run - a replayed ack in a LATER run matches nothing. */
  let gateAcceptedThisRun: string | undefined;
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
        // SA3: ONE shared idempotent bookkeeping ensure (the same path the
        // preflight issuance uses); plain unique-event INSERTs only.
        await ensureRunnerBookkeeping(client);
        // Pre-mutation target binding is enforced inside the bootstrap tx as
        // well (the CLI also checks read-only before calling): any refusal
        // here still precedes every step write and rolls back.
        const pre = await verifyTargetPreconditions(client, { deployment: opts.deployment, expectInstanceId: opts.expectInstanceId, expectRegistryDigest: opts.expectRegistryDigest });
        if (pre.firstRun) {
          identity = { deploymentLabel: opts.deployment, instanceId: randomBytes(8).toString('hex') };
          stampedNow = true;
          // R4 Anchor B: the first pinned governed run records REGISTRY_DIGEST
          // into the migration identity (a TOFU event, operator-attended).
          await client.query(
            `INSERT INTO public.contake_db_identity(id, deployment_label, instance_id, ext_baseline, registry_digest) VALUES(1, $1, $2, $3::jsonb, $4)`,
            [identity.deploymentLabel, identity.instanceId, currentExt, REGISTRY_DIGEST],
          );
        } else {
          identity = pre.identity!;
          // R5 section 3: legacy NULL adoption (extension baseline OR registry
          // anchor) writes NOTHING without BOTH operator pins verified against
          // the stamped identity and the running blueprint (fail-closed).
          const requireAdoptionPins = (what: string): void => {
            const missing: string[] = [];
            if (opts.expectInstanceId === undefined) missing.push('expect-instance-id');
            if (opts.expectRegistryDigest === undefined) missing.push('expect-registry-digest');
            if (missing.length > 0) {
              throw new Error(
                `release-migrations: LEGACY ADOPTION refusal - ${what} is NULL on a stamped identity; adopting it writes ` +
                `nothing without BOTH operator pins (missing ${missing.join(' + ')}) - re-run with --expect-instance-id and ` +
                `--expect-registry-digest after verifying them from reviewed source (fail-closed)`,
              );
            }
            if (opts.expectInstanceId !== identity.instanceId) {
              throw new Error(
                `release-migrations: LEGACY ADOPTION refusal - expect-instance-id ${JSON.stringify(opts.expectInstanceId)} does not ` +
                `match the stamped instance ${identity.instanceId} - refusing to adopt ${what} (fail-closed)`,
              );
            }
            if (opts.expectRegistryDigest !== REGISTRY_DIGEST) {
              throw new Error(
                `release-migrations: LEGACY ADOPTION refusal - expect-registry-digest ${String(opts.expectRegistryDigest).slice(0, 16)}... does not ` +
                `match the running REGISTRY_DIGEST ${REGISTRY_DIGEST.slice(0, 16)}... - refusing to adopt ${what} (fail-closed)`,
              );
            }
          };
          const base = await client.query(`SELECT ext_baseline AS b FROM public.contake_db_identity WHERE id = 1`);
          const pinned = base.rows[0]?.['b'];
          if (pinned === null || pinned === undefined) {
            // One-time adoption for pre-R2 deployments: pin what is there,
            // only with both operator pins (R5 section 3).
            requireAdoptionPins('extension baseline');
            await client.query(`UPDATE public.contake_db_identity SET ext_baseline = $1::jsonb WHERE id = 1`, [currentExt]);
          } else if (JSON.stringify(pinned) !== currentExt) {
            throw new Error(
              `release-migrations: EXTENSION BASELINE refusal - installed extension set differs from the pinned ` +
              `bootstrap baseline (pinned ${JSON.stringify(pinned)} vs current ${currentExt}) - ` +
              `extensions change out of band only via a reviewed re-pin (fail-closed)`,
            );
          }
          // R4 Anchor B: DB-anchored registry digest. Drift means the running
          // blueprint no longer matches the one this environment anchored -
          // refuse with the observed mismatch (fail-closed).
          const anchor = await client.query(`SELECT registry_digest AS d FROM public.contake_db_identity WHERE id = 1`);
          const anchored = anchor.rows[0]?.['d'];
          if (anchored === null || anchored === undefined) {
            // One-time adoption for pre-R4 deployments, only with both
            // operator pins (R5 section 3).
            requireAdoptionPins('registry anchor');
            await client.query(`UPDATE public.contake_db_identity SET registry_digest = $1 WHERE id = 1`, [REGISTRY_DIGEST]);
          } else if (String(anchored) !== REGISTRY_DIGEST) {
            throw new Error(
              `release-migrations: ANCHOR refusal - DB-anchored REGISTRY_DIGEST drift ` +
              `(anchored ${String(anchored).slice(0, 16)}... vs actual ${REGISTRY_DIGEST.slice(0, 16)}...): the running registry ` +
              `no longer matches the blueprint this deployment+instance anchored at its first governed run (fail-closed)`,
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
        // SA3 section 5: a DIRTY/INDETERMINATE target blocks every run.
        await assertTargetNotDirty(client);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      }

      // Pending steps: ONE runner-owned transaction per step - guard
      // primitives, artifact statements AND the version record commit
      // together or roll back together.
      // Pending steps: ONE runner-owned transaction per step - guard
      // primitives, artifact statements AND the version record commit
      // together or roll back together. SA2-A section 2(a): consecutive
      // gated steps (the attended 0002->0003 plan) run inside ONE shared
      // transaction under the run's locks - no interleaving write can land
      // between them; an abort rolls back the whole plan and invalidates
      // the ack.
      const pending = migrations.slice(applied.length);
      for (let gi = 0; gi < pending.length;) {
        const group: MigrationStep[] = [pending[gi]!];
        if (pending[gi]!.requiresOperatorAck === true) {
          while (gi + group.length < pending.length && pending[gi + group.length]!.requiresOperatorAck === true) {
            group.push(pending[gi + group.length]!);
          }
        }
        gi += group.length;
        await client.query('BEGIN');
        // Captured inside the steps; hoisted so the catch path can actively
        // restore non-transactional sequence state after ROLLBACK.
        const sequenceCaptures: Map<string, SeqVal>[] = [];
        let ackNonceToInvalidate: string | undefined;
        try {
          for (const m of group) {
            // Re-pin search_path INSIDE the transaction (and again before
            // every artifact statement) so even a set_config smuggled through
            // any blind spot cannot redirect name resolution mid-step.
            await client.query(`SELECT pg_catalog.set_config('search_path', '', true)`);
            if (m.xactLockKey !== undefined) await client.query(`SELECT pg_catalog.pg_advisory_xact_lock(${m.xactLockKey})`);
            for (const t of m.lockTables ?? []) await client.query(`LOCK TABLE "${CONTROLLED_SCHEMA}"."${t}" IN SHARE ROW EXCLUSIVE MODE`);
            // SA2/SA2-A/SA3 real-entrypoint operator gate: the RUNNER
            // recomputes the canonical preflight HERE - over the FULL current
            // table, same canonical enumeration the issuance displayed,
            // inside the locks, same transaction (no TOCTOU gap) - and
            // accepts ONLY an ack whose nonce is a PERSISTED, issued,
            // unconsumed record bound to THIS target + deployment + plan +
            // recomputed listDigest (SA3 section 4: no nonce record, no
            // ack). Consumption is ONE guarded UPDATE inside the group
            // transaction - atomic with the gated DDL; a second transition
            // attempt is a LOUD conflict, never a silent no-op (SA3 sections
            // 4+5). NO caller-supplied label (deployment, env, mode) relaxes
            // this gate anywhere in the shipped artifact (SA3 section 3).
            let gateReport: (OperatorPreflightReport & { listDigest: string }) | undefined;
            let preStateDigest: string | undefined;
            if (m.requiresOperatorAck === true) {
              const pf = await computeUsersPhonePreflight(client, { deployment: opts.deployment, migrations, nonce: '0000000000000000' });
              const parsed = typeof opts.operatorAck === 'string' ? ACK_FORMAT.exec(opts.operatorAck) : null;
              const isContinuation = gateAcceptedThisRun !== undefined && opts.operatorAck === gateAcceptedThisRun;
              const expectedDigest = parsed
                ? operatorListDigestForReview({ target: pf.target, deployment: pf.deployment, plan: pf.plan, nonce: parsed[1]!, collisionGroups: pf.collisionGroups, crossRepresentationInconsistencies: pf.crossRepresentationInconsistencies, blankPhoneUsers: pf.blankPhoneUsers })
                : undefined;
              if (!isContinuation) {
                if (!parsed) {
                  throw new Error(
                    `release-migrations: OPERATOR GATE refusal - step '${m.version}' mutates credential-identity row data and ` +
                    `requires an ISSUED attended-TOFU ack (ack:<nonce>:<listDigest>) for THIS plan+target+state (target ${pf.target}, ` +
                    `deployment ${opts.deployment}, plan [${pf.plan.map(x => x.version).join(',')}], listDigest ${pf.listDigest.slice(0, 16)}...). ` +
                    `Supplied ack is absent or malformed - refusing BEFORE any write (fail-closed, rolling back).`,
                  );
                }
                const nonce = parsed[1]!;
                const rec = await client.query(
                  `SELECT target, deployment_label, plan_digest, list_digest, state FROM public.schema_migration_acks WHERE nonce = $1 FOR UPDATE`,
                  [nonce],
                );
                if (rec.rows.length === 0) {
                  throw new Error(
                    `release-migrations: OPERATOR GATE refusal - NO ISSUED PREFLIGHT: ack nonce ${nonce} has no issuance record. ` +
                    `An ack exists ONLY as the persisted output of the preflight issuance path (issueOperatorPreflight); an arbitrary ` +
                    `nonce plus the public canonical digest constructs nothing (fail-closed, rolling back).`,
                  );
                }
                const r0 = rec.rows[0]!;
                if (String(r0['target']) !== pf.target || String(r0['deployment_label']) !== opts.deployment) {
                  throw new Error(
                    `release-migrations: OPERATOR GATE refusal - CROSS-TARGET ack: issued for target '${String(r0['target'])}' ` +
                    `deployment '${String(r0['deployment_label'])}', presented against '${pf.target}'/'${opts.deployment}' (fail-closed, rolling back).`,
                  );
                }
                if (String(r0['plan_digest']) !== planDigestFor(pf.plan)) {
                  throw new Error(
                    `release-migrations: OPERATOR GATE refusal - PLAN MISMATCH: the issued ack binds plan digest ` +
                    `${String(r0['plan_digest']).slice(0, 16)}... but the pending gated plan digests ${planDigestFor(pf.plan).slice(0, 16)}... (fail-closed, rolling back).`,
                  );
                }
                if (parsed[2] !== expectedDigest || String(r0['list_digest']) !== expectedDigest) {
                  throw new Error(
                    `release-migrations: OPERATOR GATE refusal - ack digest mismatch: wrong or STALE state (the recomputed canonical ` +
                    `lists under lock disagree with the issued binding, or the digest was constructed off-path). Mint a fresh ack ` +
                    `from a fresh issuance (fail-closed, rolling back).`,
                  );
                }
                if (String(r0['state']) !== 'issued') {
                  throw new Error(
                    `release-migrations: OPERATOR GATE refusal - ACK LIFECYCLE: ack nonce ${nonce} is already '${String(r0['state'])}'. ` +
                    `Consumed and invalidated acks are dead; a second transition is a loud conflict, never a silent no-op. ` +
                    `Mint a fresh ack from a fresh issuance (fail-closed, rolling back).`,
                  );
                }
                // The ack is ACCEPTED from here: ANY later failure in this
                // group (consumption write, event write, guard, DDL) aborts
                // into the invalidation path (SA3 section 5).
                gateAcceptedThisRun = opts.operatorAck;
                ackNonceToInvalidate = nonce;
                // Consume atomically WITH the gated plan: ONE guarded UPDATE
                // inside the group transaction (rolls back with it on abort).
                const consumed = await client.query(
                  `UPDATE public.schema_migration_acks SET state = 'consumed', transitioned_at = now() WHERE nonce = $1 AND state = 'issued'`,
                  [nonce],
                );
                if (consumed.rowCount !== 1) {
                  throw new Error(
                    `release-migrations: OPERATOR GATE refusal - ACK LIFECYCLE conflict: consuming nonce ${nonce} transitioned ` +
                    `${String(consumed.rowCount)} rows (expected exactly 1 issued record) - loud conflict (fail-closed, rolling back).`,
                  );
                }
                await client.query(
                  `INSERT INTO public.schema_migration_evidence(event_id, version, kind, report, list_digest, target) VALUES($1, $2, 'ack-consumed', $3::jsonb, $4, $5)`,
                  [randomBytes(16).toString('hex'), m.version, JSON.stringify({ nonce, ack: opts.operatorAck, plan: pf.plan }), expectedDigest, pf.target],
                );
              }
              // Persist the digest BOUND TO THE ACK (its nonce), so the
              // evidence record is independently derivable from the ack.
              gateReport = expectedDigest !== undefined ? { ...pf, listDigest: expectedDigest } : pf;
              preStateDigest = await usersStateDigest(client);
            }
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
            sequenceCaptures.push(await sequenceValues(client));
            for (const stmt of renderStepStatements(m)) {
              await client.query(`SELECT pg_catalog.set_config('search_path', '', true)`);
              await client.query(stmt.text, stmt.values);
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
            let postStateDigest: string | undefined;
            if (gateReport) {
              // SA2-A section 2(c): the post-step state must EQUAL the
              // canonical derivation of applying the plan to the acknowledged
              // state. The state projection is normalized (idempotent), so
              // post == pre exactly; a mismatch (interleaving write, wrong
              // mutation) aborts the run and invalidates the ack.
              postStateDigest = await usersStateDigest(client);
              if (postStateDigest !== preStateDigest) {
                throw new Error(
                  `release-migrations: STATE DERIVATION refusal - post-'${m.version}' state digest ${postStateDigest.slice(0, 16)}... ` +
                  `does not equal the canonical derivation of the acknowledged state ${String(preStateDigest).slice(0, 16)}... - ` +
                  `aborting the run; the ack is invalidated (fail-closed)`,
                );
              }
            }
            // SA3 section 5: plain INSERT - a version collision is a LOUD
            // unique-violation failure, never a silently dropped write.
            await client.query(
              `INSERT INTO public.schema_migrations(version, name, sha256, applied_by) VALUES($1, $2, $3, $4)`,
              [m.version, m.name, stepDigest(m), opts.appliedBy ?? 'release-job'],
            );
            if (gateReport) {
              // Persist the acknowledged report + per-step pre/post digests
              // with the migration's evidence record (rolls back with the
              // group on any failure).
              // SA3 section 5: unique append-only event identity (fresh
              // event_id per event); a conflict is a LOUD failure.
              await client.query(
                `INSERT INTO public.schema_migration_evidence(event_id, version, kind, report, list_digest, target) VALUES($1, $2, 'attended-tofu', $3::jsonb, $4, $5)`,
                [randomBytes(16).toString('hex'), m.version, JSON.stringify({
                  ack: opts.operatorAck, plan: gateReport.plan, nonce: gateReport.nonce,
                  preStateDigest, postStateDigest,
                  report: { collisionGroups: gateReport.collisionGroups, crossRepresentationInconsistencies: gateReport.crossRepresentationInconsistencies, blankPhoneUsers: gateReport.blankPhoneUsers },
                }), gateReport.listDigest, gateReport.target],
              );
            }
          }
          await client.query('COMMIT');
          for (const m of group) appliedNow.push(m.version);
        } catch (e) {
          await client.query('ROLLBACK').catch(() => undefined);
          // Condition 6: rollback cannot restore sequence state - do it
          // actively, then hard-fail with the original error retained.
          // ERR-PROPAGATE with DIRTY labeling: a restore FAILURE makes the
          // step's aftermath unprovable - DIRTY/INDETERMINATE hard failure
          // retaining BOTH error records (original + restore).
          for (const captured of sequenceCaptures) {
            const restored = await restoreSequenceValues(client, captured).catch((re) => {
              const original = e instanceof Error ? e.message : String(e);
              const restoreErr = re instanceof Error ? re.message : String(re);
              throw new Error(
                `release-migrations: DIRTY/INDETERMINATE step group - sequence restoration could not be proven; ` +
                `the database may hold non-transactional drift. original failure: ${original} | restore failure: ${restoreErr} (fail-closed)`,
              );
            });
            if (restored.length > 0 && e instanceof Error) {
              e.message += ` [non-transactional sequence state actively restored: ${restored.join(', ')}]`;
            }
          }
          // SA2-A section 2(c): any failure between steps aborts the run and
          // INVALIDATES the ack - recorded in the evidence trail (append-only)
          // in a fresh transaction so the record survives the rollback;
          // later runs require a fresh ack (replay refusal). AFTER the
          // sequence restore: the record's seq value must survive above the
          // restored baseline (rewinding beneath a persisted row would
          // collide on the next insert).
          if (ackNonceToInvalidate !== undefined) {
            // SA3 sections 4+5: the abort INVALIDATES the issued ack
            // (guarded single-row transition + unique append-only event).
            // NO catch-and-continue: if either write fails the aftermath is
            // unprovable - mark the target DIRTY/INDETERMINATE (retaining
            // BOTH error records) and block all further issuance and runs
            // until attended resolution. Runs AFTER the sequence restore
            // above: the event's seq value must survive above the restored
            // baseline (rewinding beneath a persisted row would collide on
            // the next insert).
            const originalFailure = e instanceof Error ? e.message : String(e);
            try {
              const inv = await client.query(
                `UPDATE public.schema_migration_acks SET state = 'invalidated', transitioned_at = now() WHERE nonce = $1 AND state = 'issued'`,
                [ackNonceToInvalidate],
              );
              if (inv.rowCount !== 1) {
                throw new Error(`ack lifecycle conflict: invalidating nonce ${ackNonceToInvalidate} transitioned ${String(inv.rowCount)} rows (expected exactly 1 issued record)`);
              }
              await client.query(
                `INSERT INTO public.schema_migration_evidence(event_id, version, kind, report, list_digest, target) VALUES($1, $2, 'ack-invalidated', $3::jsonb, 'invalidated', pg_catalog.current_database())`,
                [randomBytes(16).toString('hex'), group[0]!.version, JSON.stringify({ nonce: ackNonceToInvalidate, reason: originalFailure })],
              );
            } catch (invErr) {
              const invalidationFailure = invErr instanceof Error ? invErr.message : String(invErr);
              const dirtyReason = JSON.stringify({ originalFailure, invalidationFailure });
              // Best-effort dirty MARKER on the singleton state row (the
              // evidence trail itself may be the failed writer). This is a
              // state marker, not an append-only event - the loud upsert
              // never drops an event.
              await client.query(
                `INSERT INTO public.schema_migration_target_state(target, dirty, dirty_reason, updated_at) VALUES(pg_catalog.current_database(), true, $1::jsonb, now()) ON CONFLICT (target) DO UPDATE SET dirty = true, dirty_reason = $1::jsonb, updated_at = now()`,
                [dirtyReason],
              ).catch(() => undefined);
              throw new Error(
                `release-migrations: DIRTY/INDETERMINATE - the abort's ack invalidation could not be persisted; the target is ` +
                `marked DIRTY and blocks all further preflight issuance and migration runs until attended resolution ` +
                `(attendedResolveDirty). original failure: ${originalFailure} | invalidation failure: ${invalidationFailure} (fail-closed)`,
              );
            }
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
  // R4 Anchor B at boot: the DB-anchored registry digest must match the
  // running blueprint, with the observed mismatch on drift (fail-closed).
  {
    const anchor = await conn.query(`SELECT registry_digest AS d FROM public.contake_db_identity WHERE id = 1`);
    const anchored = anchor.rows[0]?.['d'];
    if (anchored === null || anchored === undefined) {
      throw new Error(
        'release-migrations: no DB-anchored REGISTRY_DIGEST - this database predates the R4 integrity anchor. ' +
        'Run the release-migration job once to adopt it - refusing to boot (fail-closed)',
      );
    }
    if (String(anchored) !== REGISTRY_DIGEST) {
      throw new Error(
        `release-migrations: ANCHOR refusal - DB-anchored REGISTRY_DIGEST drift ` +
        `(anchored ${String(anchored).slice(0, 16)}... vs actual ${REGISTRY_DIGEST.slice(0, 16)}...) - refusing to boot (fail-closed)`,
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
