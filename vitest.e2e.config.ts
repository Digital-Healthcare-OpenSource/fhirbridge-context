import { defineConfig } from 'vitest/config';

/** End-to-end tests run the BUILT CLI (`npm run build` first). */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
