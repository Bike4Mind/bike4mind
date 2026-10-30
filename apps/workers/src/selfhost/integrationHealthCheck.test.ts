import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@bike4mind/server-utils/services/integrationHealthService', () => ({ runAllProbes: run }));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ receiveFromQueue: vi.fn(), deleteFromQueue: vi.fn() }));

import { SelfHostWorker } from './selfHostWorker';
import { INTEGRATION_HEALTH_CHECK_INTERVAL_MS, registerIntegrationHealthCheck } from './integrationHealthCheck';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

beforeEach(() => {
  vi.useFakeTimers();
  run.mockReset().mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

it('matches the hosted five-minute cadence', () => {
  expect(INTEGRATION_HEALTH_CHECK_INTERVAL_MS).toBe(300_000);
});

it('does not probe at boot, then probes every 5 minutes without CloudWatch', async () => {
  const worker = new SelfHostWorker(logger);
  registerIntegrationHealthCheck(worker, logger);
  worker.start();

  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(INTEGRATION_HEALTH_CHECK_INTERVAL_MS - 1);
  expect(run).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledExactlyOnceWith(logger, { emitMetrics: false });

  await vi.advanceTimersByTimeAsync(INTEGRATION_HEALTH_CHECK_INTERVAL_MS);
  expect(run).toHaveBeenCalledTimes(2);

  await worker.stop();
});

it('drains an in-flight probe run on stop', async () => {
  let finish!: () => void;
  run.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  const worker = new SelfHostWorker(logger);
  registerIntegrationHealthCheck(worker, logger);
  worker.start();
  await vi.advanceTimersByTimeAsync(INTEGRATION_HEALTH_CHECK_INTERVAL_MS);
  expect(run).toHaveBeenCalledTimes(1);

  let stopped = false;
  const stop = worker.stop(1000).then(() => {
    stopped = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(stopped).toBe(false);

  finish();
  await stop;
  expect(stopped).toBe(true);
});
