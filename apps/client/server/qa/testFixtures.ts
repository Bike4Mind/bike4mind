import type { QaRunIngestRequest, QaRunInput, QaTestResultInput } from '@bike4mind/common';

/** Shared by the server/qa and pages/api/qa tests. Names are placeholders (public repo). */
export const passedTest = (testKey: string): QaTestResultInput => ({
  testKey,
  title: testKey.split(' > ').slice(1).join(' > ') || testKey,
  status: 'passed',
  durationMs: 1000,
  retries: 0,
  artifacts: [],
});

export const failedTest = (testKey: string, extra: Partial<QaTestResultInput> = {}): QaTestResultInput => ({
  ...passedTest(testKey),
  status: 'failed',
  retries: 2,
  error: 'expect(locator).toBeVisible() failed',
  ...extra,
});

export const TEST_A = 'notebook.spec.ts > Notebook > creates';
export const TEST_B = 'notebook.spec.ts > Notebook > saves';

/** A run in the stored (camelCase) shape, as ingestRun takes it. */
export function makeIngest(overrides: Partial<QaRunInput> = {}): QaRunInput {
  return {
    product: 'product-a',
    suite: 'Core',
    env: 'staging',
    branch: 'main',
    trigger: 'Run via Deployer',
    source: 'ci',
    ciRunUrl: 'https://github.com/example/repo/actions/runs/100',
    sha: 'abc123',
    startedAt: '2026-09-28T09:00:00.000Z',
    durationMs: 60000,
    counts: { passed: 2, failed: 0, skipped: 0, notStarted: 0, ran: 2, total: 2 },
    suiteSummary: [{ name: 'Notebook', passed: 2, ran: 2, notRun: 0 }],
    metrics: [],
    externalRunId: '100-1',
    tests: [passedTest(TEST_A), passedTest(TEST_B)],
    ...overrides,
  };
}

/** The same run as the CI script sends it (snake_case wire, see QaRunIngestRequestSchema). */
export function makeIngestRequest(overrides: Partial<QaRunIngestRequest> = {}): QaRunIngestRequest {
  return {
    product: 'product-a',
    suite: 'Core',
    env: 'staging',
    branch: 'main',
    trigger: 'Run via Deployer',
    source: 'ci',
    ci_run_url: 'https://github.com/example/repo/actions/runs/100',
    sha: 'abc123',
    started_at: '2026-09-28T09:00:00.000Z',
    duration_ms: 60000,
    counts: { passed: 2, failed: 0, skipped: 0, not_started: 0, ran: 2, total: 2 },
    suite_summary: [{ name: 'Notebook', passed: 2, ran: 2, not_run: 0 }],
    metrics: [],
    external_run_id: '100-1',
    tests: [TEST_A, TEST_B].map(test_key => ({
      test_key,
      title: test_key.split(' > ').slice(1).join(' > '),
      status: 'passed' as const,
      duration_ms: 1000,
      retries: 0,
      artifacts: [],
    })),
    ...overrides,
  };
}
