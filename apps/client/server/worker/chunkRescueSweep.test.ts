import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getSettingsValue: vi.fn(),
  fabFileFind: vi.fn(),
  sendToQueue: vi.fn(),
  // Spied (not a bare stub) so a test can assert the sweep passes BOTH the age cutoff and the
  // stale-claim cutoff: a one-arg call silently turns the stale-claim rescue arm back off.
  buildScanFilter: vi.fn((cutoff: Date, _staleClaimBefore: Date, _opts?: unknown) => ({
    chunkCount: 0,
    createdAt: { $lt: cutoff },
  })),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: h.getSettingsValue },
  FabFile: { find: h.fabFileFind },
}));
vi.mock('sst', () => ({ Resource: { fabFileChunkQueue: { url: 'http://elasticmq/fabFileChunkQueue' } } }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: (...a: unknown[]) => h.sendToQueue(...a) }));
vi.mock('./chunkScan', () => ({
  buildFabFileChunkScanFilter: (...a: unknown[]) => h.buildScanFilter(...(a as [Date, Date, unknown])),
  CHUNK_SCAN_BATCH: 50,
  CHUNK_SCAN_MIN_AGE_MS: 2 * 60_000,
  CHUNK_CLAIM_STALE_MS: 30 * 60_000,
}));

import { runChunkRescueSweep } from './chunkRescueSweep';

type Candidate = { _id: string; userId: string; batchId?: string };

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
/** The sweep only ever calls info/error on it; the real Logger's surface is irrelevant here. */
const runSweep = () => runChunkRescueSweep(logger as never);

const limitSpy = vi.fn();
const withCandidates = (candidates: Candidate[]) => {
  h.fabFileFind.mockReturnValue({
    select: () => ({
      limit: (n: number) => {
        limitSpy(n);
        return { lean: async () => candidates };
      },
    }),
  });
};

describe('runChunkRescueSweep (self-host chunk rescue)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Defaults: auto-chunk on, no candidates, sends succeed. The send stub is reset explicitly
    // because clearAllMocks() clears calls but NOT implementations - without this a test that
    // makes sendToQueue reject would leak that into every test after it in file order.
    h.getSettingsValue.mockResolvedValue(true);
    h.sendToQueue.mockResolvedValue(undefined);
    withCandidates([]);
  });

  it('does no work at all when auto-chunk is disabled', async () => {
    h.getSettingsValue.mockResolvedValue(false);

    await expect(runSweep()).resolves.toEqual({ enqueued: 0, failed: 0 });

    // The gate is before the QUERY, not just before the send: a disabled install must not pay for
    // an indexed scan of every complete-but-unchunked file once a minute, forever.
    expect(h.fabFileFind).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('selects with both cutoffs and the per-pass cap', async () => {
    await runSweep();

    expect(h.buildScanFilter).toHaveBeenCalledTimes(1);
    const [cutoff, staleClaimBefore] = h.buildScanFilter.mock.calls[0];
    expect(cutoff).toBeInstanceOf(Date);
    // The stale-claim arm rescues files whose worker died before clearing isChunking. Dropping this
    // argument is a silent regression: the filter still works, it just stops rescuing that class.
    expect(staleClaimBefore).toBeInstanceOf(Date);
    expect(staleClaimBefore.getTime()).toBeLessThan(cutoff.getTime());
    expect(limitSpy).toHaveBeenCalledWith(50);
  });

  it('stamps convergence provenance only on files that belong to a batch', async () => {
    withCandidates([
      { _id: 'ff1', userId: 'u1', batchId: 'b1' },
      { _id: 'ff2', userId: 'u2' },
    ]);

    await expect(runSweep()).resolves.toEqual({ enqueued: 2, failed: 0 });

    // Batch files are convergence work the kill switch may halt; a lone upload rescue is not, and
    // stamping it would make the switch stop it too.
    expect(h.sendToQueue).toHaveBeenCalledWith('http://elasticmq/fabFileChunkQueue', {
      fabFileId: 'ff1',
      userId: 'u1',
      origin: 'convergence',
    });
    expect(h.sendToQueue).toHaveBeenCalledWith('http://elasticmq/fabFileChunkQueue', {
      fabFileId: 'ff2',
      userId: 'u2',
    });
  });

  it('finishes the sweep when one enqueue fails, and reports the partial result (#2158)', async () => {
    // The sweep is the safety net for files the chunk pipeline lost, so it matters most under the
    // queue stress that makes a transient send failure likely. It used to reject out of the loop on
    // the first failure: every candidate behind it was abandoned until the next tick, and the count
    // it logged was the SELECTED size, so a tick that had sent almost nothing still read as a win.
    withCandidates([
      { _id: 'ff1', userId: 'u1' },
      { _id: 'ff2', userId: 'u2' },
      { _id: 'ff3', userId: 'u3' },
      { _id: 'ff4', userId: 'u4' },
    ]);
    // TWO fail, and neither is first or last: the middle placement distinguishes "kept going" from
    // "stopped early", and the second failure is what forces `failed` to accumulate - a counter
    // pinned to 1 would satisfy a single-failure fixture.
    h.sendToQueue.mockImplementation(async (_url: unknown, msg: { fabFileId: string }) => {
      if (msg.fabFileId === 'ff2' || msg.fabFileId === 'ff3') throw new Error('SQS throttled');
    });

    await expect(runSweep()).resolves.toEqual({ enqueued: 2, failed: 2 });

    // All four attempted - the ones behind a failure are not abandoned.
    expect(h.sendToQueue).toHaveBeenCalledTimes(4);
    expect(h.sendToQueue).toHaveBeenCalledWith('http://elasticmq/fabFileChunkQueue', {
      fabFileId: 'ff4',
      userId: 'u4',
    });
    // Each failure names its file. The sweep's return value is discarded by the scheduled-task
    // wrapper, so without this line an operator cannot tell WHICH files were not enqueued.
    for (const fabFileId of ['ff2', 'ff3']) {
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('failed to enqueue'),
        expect.objectContaining({ fabFileId, error: 'SQS throttled' })
      );
    }
    // And the summary is honest about the split rather than reporting the selected size.
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('enqueued 2 un-chunked file(s), 2 failed'));
  });

  it('still reports a tick whose every send failed', async () => {
    // The "did something" guard on the log line keys off failures too. Keying it off `enqueued`
    // alone would make a totally-broken queue look exactly like an idle install: silence.
    withCandidates([{ _id: 'ff1', userId: 'u1' }]);
    h.sendToQueue.mockRejectedValue(new Error('queue unreachable'));

    await expect(runSweep()).resolves.toEqual({ enqueued: 0, failed: 1 });

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('enqueued 0 un-chunked file(s), 1 failed'));
  });

  it('stays quiet when there is nothing to rescue', async () => {
    // Runs once a minute on every self-host install; a per-tick log line would bury the real ones.
    await expect(runSweep()).resolves.toEqual({ enqueued: 0, failed: 0 });

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('attempts every candidate across concurrency waves, not just the first wave', async () => {
    // The fan-out runs in fixed-size waves; an off-by-one in the slice window would silently drop
    // the tail of a full pass, which is indistinguishable from "the backlog was small" in the logs.
    const candidates = Array.from({ length: 25 }, (_, i) => ({ _id: `ff${i}`, userId: `u${i}` }));
    withCandidates(candidates);

    await expect(runSweep()).resolves.toEqual({ enqueued: 25, failed: 0 });

    expect(h.sendToQueue).toHaveBeenCalledTimes(25);
  });
});

describe('runChunkRescueSweep convergence-pause wiring', () => {
  // The self-host twin of the rows in dataLakeBatchReconcile.test.ts. Until the sweep was extracted
  // out of main.ts this had nowhere to live, so this side of the wiring was unpinned: the flag could
  // be dropped or hardcoded here and every suite stayed green.
  const withPauseFlag = (pauseFlag: unknown) =>
    h.getSettingsValue.mockImplementation(async (key: string) => (key === 'enableAutoChunk' ? true : pauseFlag));

  beforeEach(() => {
    vi.clearAllMocks();
    withCandidates([]);
  });

  it.each([
    ['ON - paused files must not consume the rescue cap', true, true],
    ['OFF - paused files must be swept back in and rebuilt', false, false],
  ])('kill switch %s', async (_label, pauseFlag, expected) => {
    withPauseFlag(pauseFlag);

    await runSweep();

    // Pinned as the third ARGUMENT, not as an outcome: the filter itself is mocked here, so this is
    // the only place this caller's wiring is observable. Dropping it no longer compiles; hardcoding
    // it to a constant is what these two rows still catch.
    expect(h.buildScanFilter).toHaveBeenCalledTimes(1);
    expect(h.buildScanFilter.mock.calls[0][2]).toEqual({ excludeConvergencePaused: expected });
  });

  it('treats a missing or non-boolean setting as OFF, never as ON', async () => {
    // `=== true` rather than coercion, deliberately: wrongly EXCLUDING is the far worse direction -
    // it strands every paused file with no automatic rebuild at all, since this sweep is their only
    // one. An unset setting or a legacy string must therefore fall to sweeping.
    for (const raw of [undefined, null, 'true', 1]) {
      h.buildScanFilter.mockClear();
      withPauseFlag(raw);

      await runSweep();

      expect(h.buildScanFilter.mock.calls[0][2]).toEqual({ excludeConvergencePaused: false });
    }
  });
});
