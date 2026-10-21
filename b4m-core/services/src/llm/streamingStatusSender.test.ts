import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStreamingStatusSender } from './streamingStatusSender';

const INTERVAL_MS = 100;

describe('createStreamingStatusSender', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps one leading and one trailing send during the turn', async () => {
    const send = vi.fn();
    const sender = createStreamingStatusSender(send, INTERVAL_MS, false);

    sender();
    sender();
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending trailing send across the status flip', async () => {
    const send = vi.fn();
    const sender = createStreamingStatusSender(send, INTERVAL_MS, false);

    sender();
    sender();
    sender.cancel();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends directly and cancels harmlessly when throttling is disabled', async () => {
    const send = vi.fn();
    const sender = createStreamingStatusSender(send, INTERVAL_MS, true);

    sender();
    sender();
    expect(send).toHaveBeenCalledTimes(2);

    expect(() => sender.cancel()).not.toThrow();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    sender();
    expect(send).toHaveBeenCalledTimes(3);
  });
});
