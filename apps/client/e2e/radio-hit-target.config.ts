import { defineConfig, devices } from '@playwright/test';

// Standalone entry point for the same spec in playwright.config.ts, without app cleanup or auth.
export default defineConfig({
  testDir: '.',
  testMatch: 'radio-hit-target.spec.tsx',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  timeout: 30_000,
  use: { ...devices['Desktop Chrome'] },
});
