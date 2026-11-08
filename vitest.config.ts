import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/cli.ts', 'src/**/*.d.ts'],
      // Thresholds are enforced only when vitest runs with --coverage, so the
      // empty project is not gated before src/schema, src/events, src/sessions
      // and src/replayer/parsers exist.
      thresholds: {
        'src/schema/**': { lines: 90, branches: 85 },
        'src/smoke/**': { lines: 90, branches: 85 },
        'src/events/**': { lines: 90, branches: 85 },
        'src/sessions/**': { lines: 90, branches: 85 },
        'src/replayer/parsers/**': { lines: 90, branches: 85 },
        'src/conform/**': { lines: 90, branches: 85 },
      },
    },
  },
});
