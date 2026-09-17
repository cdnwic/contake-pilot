/** REWRITE (r3): the v1.2 contract file was lost (era skew); r2.1's v1 shim re-exports it.
 *  Additive compatibility shim only — re-exports v1.1 so the preserved v1 shim chain resolves.
 *  NOT a canonical contract definition. Canonical = contracts.v1.ts (v1.19) + contracts.v2.ts. */
export * from './contake-core-contracts.v1.1';
