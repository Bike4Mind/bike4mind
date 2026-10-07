import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@workers/cron/githubLakeReconcile', () => ({ runGitHubLakeReconcile: run }));
vi.mock('@server/utils/sqs', () => ({ receiveFromQueue: vi.fn(), deleteFromQueue: vi.fn() }));

const { SelfHostWorker } = await import('./selfHostWorker');
const { registerGitHubLakeReconcile, GITHUB_LAKE_RECONCILE_INTERVAL_MS } = await import('./githubLakeReconcile');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

beforeEach(() => {
  vi.useFakeTimers();
  run.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

it('reconciles every 15 minutes, not at startup', async () => {
  expect(GITHUB_LAKE_RECONCILE_INTERVAL_MS).toBe(15 * 60_000);
  const worker = new SelfHostWorker(logger);
  registerGitHubLakeReconcile(worker);
  worker.start();
  expect(run).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(GITHUB_LAKE_RECONCILE_INTERVAL_MS - 1);
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(GITHUB_LAKE_RECONCILE_INTERVAL_MS);
  expect(run).toHaveBeenCalledTimes(2);
  await worker.stop();
});
