import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/*/tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**/*.ts'],
      exclude: ['packages/core/src/index.ts', 'packages/core/src/logger.ts'],
      reporter: ['text', 'lcov', 'html'],
    },
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
  resolve: {
    alias: {
      // Repo-rooted alias so web tests can import @agentx/core from anywhere.
      '@agentx/core': path.join(__dirname, 'packages', 'core', 'src', 'index.ts'),
    },
  },
});
