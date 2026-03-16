import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@context': path.resolve(__dirname, 'context/src'),
      '@backend': path.resolve(__dirname, 'app/backend/src'),
      '@frontend': path.resolve(__dirname, 'app/frontend/src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
  },
});
