import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 20000 },
  resolve: { alias: { '@contake/core': new URL('./src/index.ts', import.meta.url).pathname } },
});
