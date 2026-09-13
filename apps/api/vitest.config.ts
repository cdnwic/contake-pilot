import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'], testTimeout: 30000 },
  resolve: { alias: { '@contake/core': new URL('../../packages/core/src/index.ts', import.meta.url).pathname } },
});
