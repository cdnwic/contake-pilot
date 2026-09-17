import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node', include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'], testTimeout: 30000,
    // Fail-closed hotfix (2026-09-17): the API exposes OTP devCode ONLY for
    // CONTAKE_DEV_OTP === 'true'. Tests that log in via OTP opt in EXPLICITLY
    // here (harness-level, never in shipped code); production-shaped runs
    // leave it unset and stay closed.
    env: { CONTAKE_DEV_OTP: 'true' },
  },
  resolve: {
    alias: {
      '@contake/core': new URL('../../packages/core/src/index.ts', import.meta.url).pathname,
      // Hermetic FE fixtures: QA e2e tests import absolute qa-workspace paths
      // (/home/sandbox/qa-workspace/<fe>/.../src/api/*.ts). The original FE
      // sources were never part of the recovery bundle; the fixtures under
      // tests/fixtures/qa-workspace are REAL clients reconstructed against the
      // tests' contract and the live backend. Vite string-alias prefix-matches
      // absolute importees, so the tests resolve hermetically without edits.
      '/home/sandbox/qa-workspace': new URL('./tests/fixtures/qa-workspace', import.meta.url).pathname,
    },
  },
});
