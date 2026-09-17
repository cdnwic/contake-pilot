import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    rollupOptions: {
      input: { main: 'index.html', focus: 'focus.html', login: 'login.html' },
    },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
} as any);