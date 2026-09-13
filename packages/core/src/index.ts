// @contake/core — generic core. Pure functions, no IO (architecture iron rule).
// contracts.v1.ts is the tech-lead-owned drop-in (v1.1, G0-frozen); never edited locally.
export * from './contracts.v1.js';
export { computeDomino } from './domino/computeDomino.js';
export {
  CycleError, assertAcyclic, dependencyPath, dependentsOf, topoSort,
  transitiveDependents, wouldCreateCycle,
} from './graph/dag.js';
export {
  ALL_ACTIONS, ALL_ROLES, RBAC_MATRIX_VERSION, effectiveDecision, inScope,
  rawDecision, reportAutoApplies,
} from './rbac/rbac.js';
export type { Decision } from './rbac/rbac.js';
export { PROFILES_VERSION, getProfile, hasProfile, listProfiles } from './profiles/profiles.js';
export { hhmmToMin, parseInstant, renderInstant, wallMinutes } from './domino/time.js';
