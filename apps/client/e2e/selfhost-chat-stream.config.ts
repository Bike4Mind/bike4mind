import { defineConfig, devices } from '@playwright/test';

// Standalone entry point for the self-host chat streaming check. It is not part of
// playwright.config.ts: that suite seeds users through the hosted /api/test endpoints, which a
// self-host target does not serve. See selfhost-chat-stream.spec.ts for the environment it reads.
//
//   pnpm --filter @bike4mind/client exec playwright test -c e2e/selfhost-chat-stream.config.ts
export default defineConfig({
  testDir: '.',
  testMatch: 'selfhost-chat-stream.spec.ts',
  forbidOnly: !!process.env.CI,
  // No retries: a second attempt would send a second prompt and could hide a dropped stream.
  retries: 0,
  workers: 1,
  // Sign-in, one model reply and a reload; a cold local model is the slow case.
  timeout: 6 * 60_000,
  outputDir: 'test-results/selfhost-chat-stream',
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.SELFHOST_URL || 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
