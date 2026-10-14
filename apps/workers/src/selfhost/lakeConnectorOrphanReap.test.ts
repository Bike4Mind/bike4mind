import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@workers/cron/lakeConnectorOrphanReap', () => ({ runLakeConnectorOrphanReap: run }));
vi.mock('@server/utils/sqs', () => ({ receiveFromQueue: vi.fn(), deleteFromQueue: vi.fn() }));

const { SelfHostWorker } = await import('./selfHostWorker');
const { registerLakeConnectorOrphanReap, LAKE_CONNECTOR_ORPHAN_REAP_INTERVAL_MS } =
  await import('./lakeConnectorOrphanReap');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

beforeEach(() => {
  vi.useFakeTimers();
  run.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

it('reaps once a day, not at startup', async () => {
  expect(LAKE_CONNECTOR_ORPHAN_REAP_INTERVAL_MS).toBe(24 * 60 * 60_000);
  const worker = new SelfHostWorker(logger);
  registerLakeConnectorOrphanReap(worker);
  worker.start();
  expect(run).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(LAKE_CONNECTOR_ORPHAN_REAP_INTERVAL_MS - 1);
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(1);
  await worker.stop();
});
