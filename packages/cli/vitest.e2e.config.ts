/**
 * Vitest config for end-to-end harness tests under packages/cli/test/e2e/.
 *
 * Kept separate from the unit-test config (vitest.config.ts) so:
 *   - `pnpm test`     runs fast unit tests in src/
 *   - `pnpm test:e2e` runs the harness suite
 *   - `pnpm test:all` runs both
 *
 * The e2e tests construct a real ReActAgent against a faux LLM backend, so
 * they're not as cheap as a vi.fn() unit test, but they're still fully
 * deterministic - no network, no API keys, no real provider.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/e2e/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    setupFiles: ['./src/test-utils/setupTests.ts'],
    // E2E tests can take a bit longer than unit tests; bump the default
    // timeout to keep flakes from environmental jitter at bay.
    testTimeout: 15_000,
  },
});
