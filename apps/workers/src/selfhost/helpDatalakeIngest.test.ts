import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as path from 'path';
import type { Logger } from '@bike4mind/observability';
const { run, findOldestActiveAdminId } = vi.hoisted(() => ({ run: vi.fn(), findOldestActiveAdminId: vi.fn() }));
vi.mock('@workers/cron/helpDatalakeIngest', () => ({
  runHelpDatalakeIngest: run,
  corpusRoot: () => path.join(process.cwd(), 'help-corpus'),
}));
vi.mock('@bike4mind/database', () => ({ userRepository: { findOldestActiveAdminId } }));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ receiveFromQueue: vi.fn(), deleteFromQueue: vi.fn() }));
import { SelfHostWorker } from './selfHostWorker';
import { HELP_DATALAKE_INGEST_INTERVAL_MS, registerHelpDatalakeIngest } from './helpDatalakeIngest';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
beforeEach(() => {
  vi.useFakeTimers();
  run.mockReset().mockResolvedValue({ skipped: 'no-owner' });
  findOldestActiveAdminId.mockReset().mockResolvedValue('admin-1');
});
afterEach(() => vi.useRealTimers());
it('runs on startup and then every six hours, from the worker working directory corpus', async () => {
  const worker = new SelfHostWorker(logger);
  registerHelpDatalakeIngest(worker);
  worker.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ corpusRoot: path.join(process.cwd(), 'help-corpus') }));
  await vi.advanceTimersByTimeAsync(HELP_DATALAKE_INGEST_INTERVAL_MS);
  expect(run).toHaveBeenCalledTimes(2);
  await worker.stop();
});
it('offers the oldest active admin as the bootstrap owner', async () => {
  const worker = new SelfHostWorker(logger);
  registerHelpDatalakeIngest(worker);
  worker.start();
  await vi.advanceTimersByTimeAsync(0);
  const { bootstrapOwnerId } = run.mock.calls[0][0] as { bootstrapOwnerId: () => Promise<string | null> };
  expect(await bootstrapOwnerId()).toBe('admin-1');
  await worker.stop();
});
