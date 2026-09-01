import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getSettingsValue: vi.fn(),
  fabFileFind: vi.fn(),
  fabFileSelect: vi.fn(),
  sendToQueue: vi.fn(),
  findPauseOverrides: vi.fn(async () => [] as unknown[]),
  dataLakeFind: vi.fn(async () => [] as unknown[]),
  // Spied (not a bare stub) so a test can assert the sweep passes BOTH the age cutoff and the
  // stale-claim cutoff: a one-arg call silently turns the stale-claim rescue arm back off.
  buildScanFilter: vi.fn((cutoff: Date, _staleClaimBefore: Date, _opts?: unknown) => ({
    chunkCount: 0,
    createdAt: { $lt: cutoff },
  })),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {
    getSettingsValue: h.getSettingsValue,
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
  dataLakeRepository: { find: (...a: unknown[]) => h.dataLakeFind(...(a as [])) },
  scopedSettingsRepository: { findBySettingName: (...a: unknown[]) => h.findPauseOverrides(...(a as [])) },
  FabFile: { find: h.fabFileFind },
  buildDataLakeMembershipFilter: (scope: { datalakeTag: string }) => ({ membershipFor: scope.datalakeTag }),
}));
// Faithful-but-minimal stand-ins: meta-tag membership and lake-rung overrides are all these cases
// use. The real predicate and the real narrower-wins resolution are exercised unmocked in
// server/dataLakes/convergencePauseScope.test.ts and settings/resolveScopedSetting.test.ts.
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    satisfiesMembershipScope: (scope: { datalakeTag: string }, file: { tags?: { name: string }[] }) =>
      (file?.tags ?? []).some(tag => tag.name === scope.datalakeTag),
  },
  scopedSettingsService: {
    scopeForLake: (lake: { id: string }) => ({ lakeId: lake.id }),
    resolveScopedSettingFromOverrides: (
      _key: string,
      scopes: { lakeId?: string }[],
      platformValue: boolean,
      rows: { scopeLevel: string; scopeId: string; settingValue: string }[]
    ) =>
      scopes.map(scope => {
        const row = rows.find(r => r.scopeLevel === 'lake' && r.scopeId === scope.lakeId);
        return { value: row ? row.settingValue === 'true' : platformValue, source: row ? 'lake' : 'platform' };
      }),
  },
}));
vi.mock('sst', () => ({ Resource: { fabFileChunkQueue: { url: 'http://elasticmq/fabFileChunkQueue' } } }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: (...a: unknown[]) => h.sendToQueue(...a) }));
// Only the filter is stubbed; buildChunkScanQueuePayload stays real so the payload shape this
// sweep sends is asserted against the shared producer, not a local copy of it. Spreading the actual
// module also keeps the cutoff constants real, which the cutoff assertions below depend on.
vi.mock('./chunkScan', async importActual => ({
  ...(await importActual<typeof import('./chunkScan')>()),
  buildFabFileChunkScanFilter: (...a: unknown[]) => h.buildScanFilter(...(a as [Date, Date, unknown])),
}));

import { runChunkRescueSweep } from './chunkRescueSweep';

type Candidate = { _id: string; userId: string; batchId?: string; tags?: { name: string; strength: number }[] };

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
/** The sweep only ever calls info/error on it; the real Logger's surface is irrelevant here. */
const SELF_HOST_LIMIT = 50;
const runSweep = (limit = SELF_HOST_LIMIT) => runChunkRescueSweep({ limit, logger: logger as never });

const limitSpy = vi.fn();
const withCandidates = (candidates: Candidate[]) => {
  h.fabFileFind.mockReturnValue({
    // The projection is spied, not ignored: the lean() fixtures below carry userId whatever is
    // projected, so without this a trim back to '_id' would keep every test green and ship
    // `userId: 'undefined'` to the queue.
    select: (projection: string) => ({
      limit: (n: number) => {
        h.fabFileSelect(projection);
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
    h.findPauseOverrides.mockResolvedValue([]);
    h.dataLakeFind.mockResolvedValue([]);
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

  it('projects userId as well as _id - the payload needs it and the fixtures would mask its absence', async () => {
    withCandidates([{ _id: 'ff1', userId: 'u1' }]);

    await runSweep();

    expect(h.fabFileSelect).toHaveBeenCalledWith('_id userId');
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

  it('stamps convergence provenance on every message, batch or not', async () => {
    withCandidates([
      { _id: 'ff1', userId: 'u1', batchId: 'b1' },
      { _id: 'ff2', userId: 'u2' },
    ]);

    await expect(runSweep()).resolves.toEqual({ enqueued: 2, failed: 0 });

    // A scheduled rescue is background work whatever its batchId. Stamping only batch files let an
    // un-stamped re-enqueue default to `user` in isConvergenceHalted, so a file the chunk handler
    // had just parked as paused got chunked and embedded on the next tick.
    for (const [fabFileId, userId] of [
      ['ff1', 'u1'],
      ['ff2', 'u2'],
    ]) {
      expect(h.sendToQueue).toHaveBeenCalledWith('http://elasticmq/fabFileChunkQueue', {
        fabFileId,
        userId,
        origin: 'convergence',
      });
    }
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
      origin: 'convergence',
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

describe('runChunkRescueSweep convergence-pause wiring (#2120/#2157)', () => {
  // Until the sweep was extracted out of main.ts this had nowhere to live, so this side of the
  // wiring was unpinned: the flag could be dropped or hardcoded and every suite stayed green. Now
  // both drivers share this function, so these rows cover the cron too.
  const withPauseFlag = (pauseFlag: unknown) =>
    h.getSettingsValue.mockImplementation(async (key: string) => (key === 'enableAutoChunk' ? true : pauseFlag));

  const LAKE_ID = '0123456789abcdef01230001';
  const lakeOverride = [
    { scopeLevel: 'lake', scopeId: LAKE_ID, settingName: 'PauseLakeConvergence', settingValue: 'true' },
  ];
  const lakeDoc = [{ id: LAKE_ID, datalakeTag: 'datalake:alpha', createdByUserId: 'creator-1' }];

  beforeEach(() => {
    vi.clearAllMocks();
    h.sendToQueue.mockResolvedValue(undefined);
    h.findPauseOverrides.mockResolvedValue([]);
    h.dataLakeFind.mockResolvedValue([]);
    withCandidates([]);
  });

  it.each([
    ['ON - stalled files must not consume the rescue cap', true, true],
    ['OFF - stalled files must be swept back in and rebuilt', false, false],
  ])('platform switch %s', async (_label, pauseFlag, expected) => {
    withPauseFlag(pauseFlag);

    await runSweep();

    // Pinned as the third ARGUMENT, not as an outcome: the filter itself is mocked here, so this is
    // the only place the wiring is observable. Dropping it no longer compiles; hardcoding it to a
    // constant is what these two rows still catch.
    expect(h.buildScanFilter).toHaveBeenCalledTimes(1);
    expect(h.buildScanFilter.mock.calls[0][2]).toEqual({
      convergencePause: { platformPaused: expected, paused: [], running: [] },
    });
  });

  it('treats a missing or non-boolean setting as OFF, never as ON', async () => {
    // `=== true` rather than coercion, deliberately: wrongly EXCLUDING is the far worse direction -
    // it strands every stalled file with no automatic rebuild at all, since this sweep is their only
    // one. An unset setting or a legacy string must therefore fall to sweeping.
    for (const raw of [undefined, null, 'true', 1]) {
      h.buildScanFilter.mockClear();
      withPauseFlag(raw);

      await runSweep();

      expect(h.buildScanFilter.mock.calls[0][2]).toEqual({
        convergencePause: { platformPaused: false, paused: [], running: [] },
      });
    }
  });

  it('reads BOTH settings by name - enableAutoChunk to gate, PauseLakeConvergence to scope', async () => {
    // By KEY, not just by call count: a sweep reading the wrong key would still gate and still
    // resolve, just against someone else's lever, and every other assertion here would pass.
    withPauseFlag(false);

    await runSweep();

    const keys = h.getSettingsValue.mock.calls.map(c => c[0]);
    expect(keys).toContain('enableAutoChunk');
    expect(keys).toContain('PauseLakeConvergence');
  });

  it('with no override anywhere, never reads the lakes collection', async () => {
    // The fast path this design rests on: a sweep on an install that has never set a scoped pause
    // must cost exactly what it cost before #2157.
    withPauseFlag(false);

    await runSweep();

    expect(h.dataLakeFind).not.toHaveBeenCalled();
    expect(h.fabFileSelect).toHaveBeenLastCalledWith('_id userId');
  });

  it.each([
    ['the hosted cron', 500],
    ['the self-host worker', 50],
  ])('passes %s budget straight through to the query limit', async (_label, limit) => {
    // The ONLY thing the two drivers differ on, and what silently regressed while they were separate
    // copies: a hardcoded cap here would serve one driver the other's budget.
    withPauseFlag(false);

    await runSweep(limit);

    expect(limitSpy).toHaveBeenCalledWith(limit);
  });

  it('routes a lake-scoped pause into the filter AND onto the message (#2157)', async () => {
    // The end-to-end wiring of the fix. Before it, both halves read the raw platform value: this file
    // was selected with no exclusion and enqueued with no lakeId, so the handler's own re-check
    // resolved platform-only too and re-chunked a file whose lake was explicitly paused.
    withPauseFlag(false);
    h.findPauseOverrides.mockResolvedValue(lakeOverride);
    h.dataLakeFind.mockResolvedValue(lakeDoc);
    withCandidates([
      { _id: 'ff-member', userId: 'u1', tags: [{ name: 'datalake:alpha', strength: 1 }] },
      { _id: 'ff-outsider', userId: 'u2', tags: [{ name: 'datalake:other', strength: 1 }] },
    ]);

    await runSweep();

    expect(h.buildScanFilter.mock.calls[0][2]).toEqual({
      convergencePause: { platformPaused: false, paused: [{ membershipFor: 'datalake:alpha' }], running: [] },
    });
    // `tags` is projected only when an override exists - it is the sole input to the resolution below.
    expect(h.fabFileSelect).toHaveBeenLastCalledWith('_id userId tags');
    // Exact shapes, not objectContaining: a dropped lakeId is precisely the silent regression this
    // guards, and objectContaining passes just as happily without it.
    expect(h.sendToQueue).toHaveBeenCalledWith(expect.anything(), {
      fabFileId: 'ff-member',
      userId: 'u1',
      origin: 'convergence',
      lakeId: LAKE_ID,
    });
    // A file outside every overridden lake gets no lakeId, so it keeps platform-only resolution -
    // correct for it. It is still stamped haltable, because every sweep message is (#2309).
    expect(h.sendToQueue).toHaveBeenCalledWith(expect.anything(), {
      fabFileId: 'ff-outsider',
      userId: 'u2',
      origin: 'convergence',
    });
  });

  it('stamps a RUNNING lake too, which is how an override of a platform pause is honoured', async () => {
    // Without the lakeId the handler would resolve the platform value (ON) and halt a file whose lake
    // explicitly opted out of the pause.
    withPauseFlag(true);
    h.findPauseOverrides.mockResolvedValue([{ ...lakeOverride[0], settingValue: 'false' }]);
    h.dataLakeFind.mockResolvedValue(lakeDoc);
    withCandidates([{ _id: 'ff1', userId: 'u1', tags: [{ name: 'datalake:alpha', strength: 1 }] }]);

    await runSweep();

    expect(h.buildScanFilter.mock.calls[0][2]).toEqual({
      convergencePause: { platformPaused: true, paused: [], running: [{ membershipFor: 'datalake:alpha' }] },
    });
    expect(h.sendToQueue).toHaveBeenCalledWith(expect.anything(), {
      fabFileId: 'ff1',
      userId: 'u1',
      origin: 'convergence',
      lakeId: LAKE_ID,
    });
  });

  it('a failed override read aborts the sweep rather than sweeping as if nothing were paused', async () => {
    // Unknown must not become "not paused": that would re-chunk a scoped-paused lake's files,
    // rewriting passages an operator froze. The only cost of aborting is rescue latency.
    withPauseFlag(false);
    h.findPauseOverrides.mockRejectedValue(new Error('overlay down'));
    withCandidates([{ _id: 'ff1', userId: 'u1' }]);

    await expect(runSweep()).rejects.toThrow('overlay down');
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });
});
