import { describe, expect, it, vi } from 'vitest';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

import {
  applyDlqCountCeiling,
  DLQ_GROUP_DISCARD_MAX_ROUNDS,
  runDlqBatches,
  runDlqGroupDiscard,
  type DlqGroupDiscardResponse,
} from './dlqManagement';

describe('runDlqBatches', () => {
  it('sends each queue in chunks of 100 and tags every outcome with its queue', async () => {
    const ids = Array.from({ length: 150 }, (_, index) => `m${index}`);
    const send = vi.fn(async (_queue: string, chunk: string[]) => ({
      results: chunk.map(messageId => ({ messageId, status: 'replayed' as const })),
    }));
    const outcomes = await runDlqBatches(
      new Map([
        ['billing', ids],
        ['files', ['f1']],
      ]),
      send
    );
    expect(send.mock.calls.map(([queue, chunk]) => [queue, chunk.length])).toEqual([
      ['billing', 100],
      ['billing', 50],
      ['files', 1],
    ]);
    expect(outcomes).toHaveLength(151);
    expect(outcomes.at(-1)).toEqual({ messageId: 'f1', queueLabel: 'files', status: 'replayed' });
  });

  it('reports an ID the server did not answer as not found', async () => {
    const outcomes = await runDlqBatches(new Map([['q', ['a', 'b']]]), async () => ({
      results: [{ messageId: 'a', status: 'replayed' as const }],
    }));
    expect(outcomes.map(outcome => [outcome.messageId, outcome.status])).toEqual([
      ['a', 'replayed'],
      ['b', 'notFound'],
    ]);
  });

  it('marks a failed chunk as failed and still sends the next queue', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValueOnce({ results: [{ messageId: 'c', status: 'replayed' }] });
    const outcomes = await runDlqBatches(
      new Map([
        ['q1', ['a', 'b']],
        ['q2', ['c']],
      ]),
      send
    );
    expect(outcomes).toEqual([
      { messageId: 'a', queueLabel: 'q1', status: 'failed', reason: 'throttled' },
      { messageId: 'b', queueLabel: 'q1', status: 'failed', reason: 'throttled' },
      { messageId: 'c', queueLabel: 'q2', status: 'replayed' },
    ]);
  });
});

const round = (overrides: Partial<DlqGroupDiscardResponse> = {}): DlqGroupDiscardResponse => ({
  discarded: 50,
  failed: 0,
  examined: 60,
  stoppedBy: 'limit',
  complete: false,
  results: [],
  ...overrides,
});

describe('runDlqGroupDiscard', () => {
  it('calls again until the queue is exhausted and reports the running total', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(round())
      .mockResolvedValueOnce(round({ discarded: 21, stoppedBy: 'exhausted', complete: true }));
    const progress: number[] = [];
    const outcome = await runDlqGroupDiscard(send, { onProgress: done => progress.push(done) });
    expect(outcome).toEqual({ discarded: 71, failed: 0, historyPending: 0, complete: true });
    expect(progress).toEqual([50, 71]);
  });

  it('stops when a round discards nothing, without claiming the group is gone', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(round())
      .mockResolvedValueOnce(round({ discarded: 0, stoppedBy: 'budget' }));
    const outcome = await runDlqGroupDiscard(send);
    expect(outcome).toMatchObject({ discarded: 50, complete: false, stopped: 'no_progress' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('stops between rounds once cancelled', async () => {
    let cancelled = false;
    const send = vi.fn(async () => {
      cancelled = true;
      return round();
    });
    const outcome = await runDlqGroupDiscard(send, { isCancelled: () => cancelled });
    expect(outcome).toMatchObject({ discarded: 50, stopped: 'cancelled' });
    expect(send).toHaveBeenCalledOnce();
  });

  it('stops on a lookup failure and at the round limit', async () => {
    await expect(
      runDlqGroupDiscard(vi.fn().mockResolvedValue(round({ discarded: 0, stoppedBy: 'lookup_failed' })))
    ).resolves.toMatchObject({ stopped: 'lookup_failed' });
    const send = vi.fn().mockResolvedValue(round());
    await expect(runDlqGroupDiscard(send)).resolves.toMatchObject({ stopped: 'max_rounds' });
    expect(send).toHaveBeenCalledTimes(DLQ_GROUP_DISCARD_MAX_ROUNDS);
  });

  it('counts failures and unconfirmed history, keeping the first failure reason', async () => {
    const send = vi.fn().mockResolvedValue(
      round({
        discarded: 1,
        failed: 1,
        complete: true,
        stoppedBy: 'exhausted',
        results: [
          { messageId: 'm1', status: 'discarded', historyPending: true },
          { messageId: 'm2', status: 'failed', reason: 'AccessDenied' },
        ],
      })
    );
    await expect(runDlqGroupDiscard(send)).resolves.toEqual({
      discarded: 1,
      failed: 1,
      historyPending: 1,
      complete: true,
      firstFailure: 'AccessDenied',
    });
  });

  it('throws when the first round fails, but keeps progress when a later one does', async () => {
    await expect(runDlqGroupDiscard(vi.fn().mockRejectedValue(new Error('502')))).rejects.toThrow('502');
    const send = vi.fn().mockResolvedValueOnce(round()).mockRejectedValueOnce(new Error('502'));
    await expect(runDlqGroupDiscard(send)).resolves.toMatchObject({
      discarded: 50,
      stopped: 'error',
      firstFailure: '502',
    });
  });
});

describe('applyDlqCountCeiling', () => {
  const now = 1_000_000;
  const ceilings = { cron: { ceiling: 4, until: now + 1000 } };

  it('caps a lagging count at what the discard left until the window ends', () => {
    expect(applyDlqCountCeiling(ceilings, 'cron', 75, now)).toBe(4);
    expect(applyDlqCountCeiling(ceilings, 'cron', 2, now)).toBe(2);
    expect(applyDlqCountCeiling(ceilings, 'cron', 75, now + 1000)).toBe(75);
  });

  it('leaves other queues and unreadable counts alone', () => {
    expect(applyDlqCountCeiling(ceilings, 'billing', 9, now)).toBe(9);
    expect(applyDlqCountCeiling(ceilings, 'cron', -1, now)).toBe(-1);
    expect(applyDlqCountCeiling(undefined, 'cron', 9, now)).toBe(9);
  });
});
