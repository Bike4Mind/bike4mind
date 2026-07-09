import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';
import { TIMEOUTS } from './e2e/constants';

dotenv.config({ path: path.resolve(__dirname, '.env.e2e') });

const adminAuthFile = './e2e/.auth/admin.json';

// Per-spec projects: each spec gets its own isolated setup + test user
const specProjects = [
  // notebook first — its credits tests must run before prompts can exhaust the global timeout
  {
    name: 'notebook',
    setupMatch: /(?:^|\/)notebook\.setup\.ts$/,
    testMatch: /(?:^|\/)notebook\.spec\.ts$/,
    auth: './e2e/.auth/notebook-user.json',
  },
  {
    name: 'prompts',
    setupMatch: /(?:^|\/)prompts\.setup\.ts$/,
    testMatch: /(?:^|\/)prompts\.spec\.ts$/,
    auth: './e2e/.auth/prompts-user.json',
  },
  {
    name: 'notebook-files',
    setupMatch: /(?:^|\/)notebook-files\.setup\.ts$/,
    testMatch: /(?:^|\/)notebook-files\.spec\.ts$/,
    auth: './e2e/.auth/notebook-files-user.json',
  },
  {
    name: 'projects',
    setupMatch: /(?:^|\/)projects\.setup\.ts$/,
    testMatch: /(?:^|\/)projects\.spec\.ts$/,
    auth: './e2e/.auth/projects-user.json',
  },
  {
    name: 'agents',
    setupMatch: /(?:^|\/)agents\.setup\.ts$/,
    testMatch: /(?:^|\/)agents\.spec\.ts$/,
    auth: './e2e/.auth/agents-user.json',
  },
  {
    name: 'image-gen',
    setupMatch: /(?:^|\/)image-gen\.setup\.ts$/,
    testMatch: /(?:^|\/)image-generation\.spec\.ts$/,
    auth: './e2e/.auth/image-gen-user.json',
  },
  {
    name: 'profile',
    setupMatch: /(?:^|\/)profile\.setup\.ts$/,
    testMatch: /(?:^|\/)profile\.spec\.ts$/,
    auth: './e2e/.auth/profile-user.json',
  },
  {
    name: 'tavern',
    setupMatch: /(?:^|\/)tavern\.setup\.ts$/,
    testMatch: /(?:^|\/)tavern\.spec\.ts$/,
    auth: './e2e/.auth/tavern-user.json',
  },
  {
    name: 'search',
    setupMatch: /(?:^|\/)search\.setup\.ts$/,
    testMatch: /(?:^|\/)search\.spec\.ts$/,
    auth: './e2e/.auth/search-user.json',
  },
  {
    name: 'skills',
    setupMatch: /(?:^|\/)skills\.setup\.ts$/,
    testMatch: /(?:^|\/)skills\.spec\.ts$/,
    auth: './e2e/.auth/skills-user.json',
  },
  // AI latency suites: only included when AI_LATENCY_RUN=true (e2e-ai-latency workflow)
  ...(process.env.AI_LATENCY_RUN === 'true'
    ? [
        {
          name: 'ai-latency-short-answers',
          setupMatch: /(?:^|\/)ai-latency-short-answers\.setup\.ts$/,
          testMatch: /(?:^|\/)ai-latency-short-answers\.spec\.ts$/,
          auth: './e2e/.auth/ai-latency-short-answers-user.json',
        },
        {
          name: 'ai-latency-long-answers',
          setupMatch: /(?:^|\/)ai-latency-long-answers\.setup\.ts$/,
          testMatch: /(?:^|\/)ai-latency-long-answers\.spec\.ts$/,
          auth: './e2e/.auth/ai-latency-long-answers-user.json',
        },
        {
          name: 'ai-latency-tool-prompts',
          setupMatch: /(?:^|\/)ai-latency-tool-prompts\.setup\.ts$/,
          testMatch: /(?:^|\/)ai-latency-tool-prompts\.spec\.ts$/,
          auth: './e2e/.auth/ai-latency-tool-prompts-user.json',
        },
        {
          name: 'ai-latency-intermediate-tools',
          setupMatch: /(?:^|\/)ai-latency-intermediate-tools\.setup\.ts$/,
          testMatch: /(?:^|\/)ai-latency-intermediate-tools\.spec\.ts$/,
          auth: './e2e/.auth/ai-latency-intermediate-tools-user.json',
        },
      ]
    : []),
];

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: Number(process.env.PW_WORKERS) || 3,
  timeout: TIMEOUTS.TEST,
  // 30 min: with PW_WORKERS=3 the full suite runs in ~15–20 min under normal conditions,
  // leaving a 10-min buffer. The GitHub Actions job cap is 35 min, so this inner guard
  // gives Playwright time to run teardown and write artifacts before the job is killed.
  globalTimeout: process.env.CI && process.env.AI_LATENCY_RUN !== 'true' ? 30 * 60_000 : undefined,
  expect: { timeout: TIMEOUTS.VISIBLE },
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  outputDir: 'e2e/test-results',
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'pw-results.json' }]]
    : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: process.env.API_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    // Core setup: admin, manager, invite code (runs first)
    {
      name: 'setup-core',
      testMatch: /(?:^|\/)core\.setup\.ts$/,
    },
    // Warmup: prime Lambda containers + SSR pages using admin auth
    {
      name: 'warmup',
      testMatch: /(?:^|\/)warmup\.setup\.ts$/,
      dependencies: ['setup-core'],
      use: { storageState: adminAuthFile },
    },
    // Per-spec setup projects (each creates only its own user)
    ...specProjects.map(({ name, setupMatch }) => ({
      name: `setup-${name}`,
      testMatch: [setupMatch],
      dependencies: ['warmup'],
    })),
    // Unauthenticated specs need core + projects user (for login credentials)
    {
      name: 'unauthenticated',
      use: { ...devices['Desktop Chrome'] },
      testMatch: [/(?:^|\/)auth\.spec\.ts$/, /(?:^|\/)signup\.spec\.ts$/],
      dependencies: ['setup-core', 'setup-projects'],
    },
    // Admin specs
    {
      name: 'admin',
      use: {
        ...devices['Desktop Chrome'],
        storageState: adminAuthFile,
      },
      dependencies: ['setup-core', 'unauthenticated'],
      testMatch: [/(?:^|\/)admin\.spec\.ts$/],
    },
    // Per-spec test projects (each depends only on its own setup)
    ...specProjects.map(({ name, testMatch, auth }) => ({
      name,
      use: {
        ...devices['Desktop Chrome'],
        storageState: auth,
      },
      dependencies: [`setup-${name}`],
      testMatch: [testMatch],
    })),
    // Model discovery for the CI full-matrix job (AI_LATENCY_RUN only). Reuses the
    // short-answers test user/auth so it sees the same modal a latency spec would.
    ...(process.env.AI_LATENCY_RUN === 'true'
      ? [
          {
            name: 'ai-latency-discover',
            use: {
              ...devices['Desktop Chrome'],
              storageState: './e2e/.auth/ai-latency-short-answers-user.json',
            },
            dependencies: ['setup-ai-latency-short-answers'],
            testMatch: [/(?:^|\/)ai-latency-discover\.spec\.ts$/],
          },
        ]
      : []),
  ],
});
