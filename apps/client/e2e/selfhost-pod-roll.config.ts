import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.e2e') });

// Standalone entry point: this check replaces pods on the target, so it is never part of the
// default suite in playwright.config.ts and takes none of its setup projects or cleanup sweep.
// No retries and one worker: a retry would roll the pods again and could turn a real failure
// (a gateway that never returns) into a pass.
export default defineConfig({
  testDir: '.',
  testMatch: 'selfhost-pod-roll.spec.ts',
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  // Three chat turns, two pod rolls and two reconnect waits; each step has its own bound.
  timeout: 30 * 60_000,
  outputDir: 'test-results',
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.API_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
