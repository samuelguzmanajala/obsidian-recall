import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@context': path.resolve(__dirname, 'src/context'),
      '@app': path.resolve(__dirname, 'src/app'),
      '@backend': path.resolve(__dirname, 'src/app/backend'),
      '@frontend': path.resolve(__dirname, 'src/app/frontend'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
  },
});
