import { defineConfig } from 'vitest/config';

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
      '@agentx/core': '/Users/darrenjones/AgentX/packages/core/src/index.ts',
    },
  },
});
