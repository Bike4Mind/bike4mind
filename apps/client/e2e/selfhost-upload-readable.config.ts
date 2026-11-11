import { defineConfig, devices } from '@playwright/test';

// Standalone entry point for the self-host upload-readable check. Not part of playwright.config.ts:
// that suite's global setup and per-spec users depend on /api/test/*, which a self-host install
// does not serve. Usage is in selfhost-upload-readable.spec.ts.
export default defineConfig({
  testDir: '.',
  forbidOnly: !!process.env.CI,
  // One attempt: a retry would upload a second file and replace the pod again, and a mutation run
  // must not get a second chance to pass.
  retries: 0,
  workers: 1,
  outputDir: 'test-results/selfhost-upload-readable',
  reporter: [['list']],
  projects: [
    // No target and no browser: proves the byte comparison and the pod-replacement verdict fail
    // when they should.
    { name: 'selftest', testMatch: 'selfhost-upload-readable.selftest.spec.ts' },
    {
      name: 'live',
      testMatch: 'selfhost-upload-readable.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: process.env.SELFHOST_URL, trace: 'retain-on-failure' },
    },
  ],
});
