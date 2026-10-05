import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ dispatch: vi.fn(), renew: vi.fn() }));
vi.mock('@server/queueHandlers/dataLakeCleanup', () => ({ dispatch: h.dispatch }));
vi.mock('@server/utils/sqs', () => ({ changeMessageVisibility: h.renew }));
import { registerDataLakeCleanupQueue } from './dataLakeCleanupQueue';

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
const setup = () => {
  const registerQueueHandler = vi.fn();
  registerDataLakeCleanupQueue({ registerQueueHandler }, 'http://broker/cleanup', { warn: vi.fn() });
  return registerQueueHandler.mock.calls[0];
};
it('receives one cleanup and leaves exhaustion to the broker DLQ, never the worker drop cap', () => {
  const call = setup();
  expect(call[0]).toBe('dataLakeCleanupQueue');
  expect(call[3]).toEqual({ batchSize: 1, visibilityTimeoutSec: 720, maxReceiveCount: Number.MAX_SAFE_INTEGER });
});
it('renews visibility while work runs and disposes the timer after completion', async () => {
  vi.useFakeTimers();
  h.renew.mockResolvedValue(undefined);
  let finish!: () => void;
  h.dispatch.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  const run = setup()[2];
  const work = run({ Records: [{ receiptHandle: 'receipt' }] }, {});
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.renew).toHaveBeenCalledWith('http://broker/cleanup', 'receipt', 720);
  finish();
  await work;
  const calls = h.renew.mock.calls.length;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.renew).toHaveBeenCalledTimes(calls);
});
it('does not acknowledge a completed handler after visibility renewal failed', async () => {
  vi.useFakeTimers();
  h.renew.mockRejectedValue(new Error('broker offline'));
  let finish!: () => void;
  h.dispatch.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  const work = setup()[2]({ Records: [{ receiptHandle: 'receipt' }] }, {});
  const assertion = expect(work).rejects.toThrow('broker offline');
  await vi.advanceTimersByTimeAsync(60_000);
  finish();
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});

it('warns and does not register an absent queue', () => {
  const registerQueueHandler = vi.fn();
  const warn = vi.fn();
  registerDataLakeCleanupQueue({ registerQueueHandler }, undefined, { warn });
  expect(registerQueueHandler).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledOnce();
});
it('refuses a missing receipt before dispatch or renewal', async () => {
  await expect(setup()[2]({ Records: [{}] }, {})).rejects.toThrow('no receipt');
  expect(h.dispatch).not.toHaveBeenCalled();
  expect(h.renew).not.toHaveBeenCalled();
});
it('clears the renewal timer when dispatch throws', async () => {
  vi.useFakeTimers();
  h.dispatch.mockRejectedValueOnce(new Error('cleanup failed'));
  await expect(setup()[2]({ Records: [{ receiptHandle: 'receipt' }] }, {})).rejects.toThrow('cleanup failed');
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.renew).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it('waits for an in-flight renewal rejection after handler completion', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  let rejectRenewal!: (error: Error) => void;
  h.dispatch.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  h.renew.mockImplementationOnce(
    () =>
      new Promise<void>((_, reject) => {
        rejectRenewal = reject;
      })
  );
  const work = setup()[2]({ Records: [{ receiptHandle: 'receipt' }] }, {});
  const assertion = expect(work).rejects.toThrow('late renewal failed');
  await vi.advanceTimersByTimeAsync(60_000);
  finish();
  await Promise.resolve();
  rejectRenewal(new Error('late renewal failed'));
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});
