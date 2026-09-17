/**
 * SHIM for the pinned QA corpus's stale import path (./contake-core-contracts.v1).
 * Re-exports the current pinned contracts (v1.2). Reported to tech lead; remove when the
 * corpus import path is fixed in a future version bump. Frontend code must import v1.2 directly.
 */
export * from './contake-core-contracts.v1.2';