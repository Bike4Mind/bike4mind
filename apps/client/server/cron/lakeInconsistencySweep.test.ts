import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindDue = vi.fn();
const mockHasMoreDue = vi.fn();
const mockMarkScanned = vi.fn();
const mockUpdateLake = vi.fn();

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  dataLakeRepository: {
    findDueForInconsistencyScan: (...args: unknown[]) => mockFindDue(...args),
    hasMoreDueForInconsistencyScan: (...args: unknown[]) => mockHasMoreDue(...args),
    markInconsistencyScanned: (...args: unknown[]) => mockMarkScanned(...args),
    update: (...args: unknown[]) => mockUpdateLake(...args),
  },
  dataLakeFindingRepository: { listDismissedKeys: vi.fn().mockResolvedValue([]) },
  fabFileRepository: {},
  fabFileChunkRepository: {},
}));

const mockDetect = vi.fn();
const mockRecordFindings = vi.fn();
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    detectLakeInconsistencies: (...args: unknown[]) => mockDetect(...args),
    recordLakeFindings: (...args: unknown[]) => mockRecordFindings(...args),
    INCONSISTENCY_DETECTOR: 'lexical',
  },
}));

vi.mock('@bike4mind/observability', () => {
  const mockLogger: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    Logger: vi.fn(function () {
      return mockLogger;
    }),
  };
});

vi.mock('@server/utils/config', () => ({
  Config: { MONGODB_URI: 'mongodb://localhost:27017/%STAGE%' },
}));

vi.mock('sst', () => ({ Resource: { App: { stage: 'dev' } } }));

const mockEmitMetric = vi.fn().mockResolvedValue(undefined);
vi.mock('@server/utils/cloudwatch', () => ({
  emitMetric: (...args: unknown[]) => mockEmitMetric(...args),
}));

vi.mock('@aws-sdk/client-cloudwatch', () => ({ StandardUnit: { Count: 'Count' } }));

import { handler } from './lakeInconsistencySweep';

const lake = (overrides: Record<string, unknown> = {}) => ({
  id: 'lake-1',
  datalakeTag: 'datalake:one',
  fileTagPrefix: 'one:',
  createdByUserId: 'user-1',
  lastInconsistencyScanAt: null,
  ...overrides,
});

const finding = (subject: string) => ({
  kind: 'metric-disagreement',
  subject,
  documentCount: 2,
  evidence: [{ fabFileId: 'file-a', fileName: 'a.md', excerpt: 'one figure' }],
});

const report = (overrides: Record<string, unknown> = {}) => ({
  findings: [finding('revenue')],
  countsByKind: {
    'superlative-conflict': 0,
    'metric-disagreement': 1,
    'relationship-conflict': 0,
    'expired-claim': 0,
  },
  sampled: true,
  truncated: false,
  memberSampled: false,
  memberCount: 2,
  ...overrides,
});

/** The detector's result envelope: the stored report plus the dismissals it kept out of it. */
const detectResult = (overrides: Record<string, unknown> = {}, suppressed: unknown[] = []) => ({
  report: report(overrides),
  suppressed,
});

const metricValue = (name: string) => mockEmitMetric.mock.calls.find(call => call[1] === name)?.[2];

describe('lakeInconsistencySweep cron', () => {
  beforeEach(() => {
    // resetAllMocks, not clearAllMocks: a `mockResolvedValueOnce` the handler never consumes
    // (pagination stopping after one page) would otherwise leak into the next test.
    vi.resetAllMocks();
    mockFindDue.mockResolvedValue([]);
    mockHasMoreDue.mockResolvedValue(false);
    mockDetect.mockResolvedValue(detectResult());
    mockRecordFindings.mockResolvedValue({ recorded: 1, failed: 0 });
    mockUpdateLake.mockResolvedValue(undefined);
    mockMarkScanned.mockResolvedValue(undefined);
  });

  it('reports zero scanned when there are no active lakes', async () => {
    const result = await handler();
    expect(result).toMatchObject({ status: 'OK', scanned: 0, failed: 0, truncated: false });
    expect(mockDetect).not.toHaveBeenCalled();
  });

  it('starts the scan with no cursor and a page-sized limit', async () => {
    await handler();
    expect(mockFindDue.mock.calls[0][0]).toMatchObject({ cursor: null, limit: 25 });
  });

  it('runs detection per lake, records the findings as rows, then stores the summary', async () => {
    mockFindDue.mockResolvedValueOnce([lake()]).mockResolvedValueOnce([]);

    const result = await handler();

    expect(result).toMatchObject({ status: 'OK', scanned: 1, failed: 0, findingsRecorded: 1, findingsFailed: 0 });
    expect(mockRecordFindings).toHaveBeenCalledTimes(1);
    const [lakeId, findings, options] = mockRecordFindings.mock.calls[0];
    expect(lakeId).toBe('lake-1');
    expect(findings).toEqual([finding('revenue')]);
    expect(options).toMatchObject({ detector: 'lexical' });
    expect(mockMarkScanned).toHaveBeenCalledWith('lake-1', expect.any(Date));
  });

  it('stores the run summary WITHOUT the findings, so no excerpt lands on the lake document', async () => {
    // The whole point of the findings model: the lake carries what the RUN reported about itself,
    // never what it found. A findings array here is a second, unkeyed copy of every row - and a
    // retention hole, since the purge-time sweeps reach rows only.
    mockFindDue.mockResolvedValueOnce([lake()]).mockResolvedValueOnce([]);

    await handler();

    const stored = mockUpdateLake.mock.calls[0][0];
    expect(stored.inconsistencyReport).not.toHaveProperty('findings');
    expect(stored.inconsistencyReport).toMatchObject({
      sampled: true,
      truncated: false,
      memberSampled: false,
      memberCount: 2,
      countsByKind: { 'metric-disagreement': 1 },
    });
    expect(stored.inconsistencyComputedAt).toBeInstanceOf(Date);
  });

  it('writes the findings before dating the summary, so a summary never outruns its rows', async () => {
    mockFindDue.mockResolvedValueOnce([lake()]).mockResolvedValueOnce([]);
    const order: string[] = [];
    mockRecordFindings.mockImplementation(async () => {
      order.push('findings');
      return { recorded: 1, failed: 0 };
    });
    mockUpdateLake.mockImplementation(async () => {
      order.push('summary');
    });

    await handler();

    expect(order).toEqual(['findings', 'summary']);
  });

  it('stamps one instant across a run, and passes it as the findings seenAt', async () => {
    // `seenAt` is what "everything this pass still saw" is compared against, so a run's rows and
    // its summary have to agree on one instant rather than drifting by each write's latency.
    mockFindDue.mockResolvedValueOnce([lake({ id: 'a' }), lake({ id: 'b' })]).mockResolvedValueOnce([]);

    await handler();

    const seenAts = mockRecordFindings.mock.calls.map(call => call[2].seenAt);
    const computedAts = mockUpdateLake.mock.calls.map(call => call[0].inconsistencyComputedAt);
    expect(new Set([...seenAts, ...computedAts]).size).toBe(1);
    expect(mockMarkScanned.mock.calls[0][1]).toBe(seenAts[0]);
  });

  it('excludes its own stamp from the candidate set, so a lake it scanned cannot be rescanned', async () => {
    // The scan sorts on the field the run mutates as it walks. Without this exclusion every lake
    // already scanned re-enters the candidate set behind an older cursor - and here that means a
    // second ~1000-chunk pass, not just a wasted aggregation.
    mockFindDue.mockResolvedValueOnce([lake()]).mockResolvedValueOnce([]);

    await handler();

    const stamped = mockMarkScanned.mock.calls[0][1];
    for (const [params] of mockFindDue.mock.calls) {
      expect(params.excludeScannedAt).toBe(stamped);
    }
  });

  it('isolates a per-lake failure so the rest of the run still completes', async () => {
    mockFindDue.mockResolvedValueOnce([lake({ id: 'lake-fail' }), lake({ id: 'lake-ok' })]).mockResolvedValueOnce([]);
    mockDetect.mockRejectedValueOnce(new Error('chunk read blew up')).mockResolvedValue(detectResult());

    const result = await handler();

    expect(result).toMatchObject({ scanned: 2, failed: 1 });
    expect(mockRecordFindings).toHaveBeenCalledTimes(1);
  });

  it('does not date a summary for a lake whose detection pass failed', async () => {
    // `inconsistencyComputedAt` is read as "detection ran". A failed pass that stamped it would
    // present the PREVIOUS run's counts as today's answer.
    mockFindDue.mockResolvedValueOnce([lake({ id: 'lake-fail' })]).mockResolvedValueOnce([]);
    mockDetect.mockRejectedValueOnce(new Error('boom'));

    await handler();

    expect(mockUpdateLake).not.toHaveBeenCalled();
  });

  it('stamps lastInconsistencyScanAt even for a lake whose pass failed, so it rotates to the back', async () => {
    mockFindDue.mockResolvedValueOnce([lake({ id: 'lake-fail' })]).mockResolvedValueOnce([]);
    mockDetect.mockRejectedValueOnce(new Error('boom'));

    const result = await handler();

    expect(result.failed).toBe(1);
    // A lake stuck failing must lose its "never scanned" priority, or it and everything capped
    // behind it starve forever.
    expect(mockMarkScanned).toHaveBeenCalledWith('lake-fail', expect.any(Date));
  });

  it('withholds the summary, and counts the lake as failed, when findings went unwritten', async () => {
    // `recordLakeFindings` isolates per-finding failures into `failed` and never throws, so
    // ordering the writes cannot be the whole guard: without an explicit gate the sweep would date
    // a fresh summary and a full countsByKind over rows that were never persisted. GET
    // /inconsistencies selects findings BY that date, so the result would be counts with no
    // findings beside them.
    mockFindDue.mockResolvedValueOnce([lake()]).mockResolvedValueOnce([]);
    mockRecordFindings.mockResolvedValueOnce({ recorded: 0, failed: 1 });

    const result = await handler();

    expect(mockUpdateLake).not.toHaveBeenCalled();
    // Counted as a failed lake, not a quiet one - `findingsRecorded: 0` alone is indistinguishable
    // from a genuinely clean corpus.
    expect(result).toMatchObject({ failed: 1, findingsRecorded: 0, findingsFailed: 1 });
  });

  it('still stamps a lake whose summary was withheld, so it retries next run', async () => {
    mockFindDue.mockResolvedValueOnce([lake()]).mockResolvedValueOnce([]);
    mockRecordFindings.mockResolvedValueOnce({ recorded: 0, failed: 1 });

    await handler();

    expect(mockMarkScanned).toHaveBeenCalledWith('lake-1', expect.any(Date));
  });

  it('emits a findings-failed metric, not just a log line', async () => {
    // Per-finding failures never reach the per-lake `failed` counter on their own, so without this
    // metric a sweep whose every write is failing publishes FindingsRecorded 0 / Failures 0 - the
    // one shape an alarm cannot tell from a clean run over a clean corpus.
    mockFindDue.mockResolvedValueOnce([lake()]).mockResolvedValueOnce([]);
    mockRecordFindings.mockResolvedValueOnce({ recorded: 0, failed: 3 });

    await handler();

    expect(metricValue('LakeInconsistencySweepFindingsFailed')).toBe(3);
  });

  it('stops on its wall-clock budget and reports the remainder, rather than being killed mid-run', async () => {
    // MAX_LAKES_PER_RUN caps how many lakes are attempted, never how long one takes. On a Lambda
    // timeout the run metric has already been emitted and none of the others have, so a sweep that
    // times out nightly looks exactly like one that could not reach the database.
    const page = Array.from({ length: 25 }, (_, i) => lake({ id: `slow-${i}` }));
    mockFindDue.mockResolvedValue(page);
    mockHasMoreDue.mockResolvedValue(true);
    // One page's worth of work pushes past the 11-minute budget.
    let clock = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 6 * 60 * 1000));

    const result = await handler();

    nowSpy.mockRestore();
    // Stopped well short of the 200-lake cap, and said so.
    expect(result.scanned).toBeLessThan(200);
    expect(result.truncated).toBe(true);
  });

  it('paginates by a staleness+id keyset until a short page ends the scan', async () => {
    const scannedAt = new Date('2026-01-01T00:00:00Z');
    const firstPage = Array.from({ length: 25 }, (_, i) =>
      lake({ id: `lake-${i + 1}`, lastInconsistencyScanAt: scannedAt })
    );
    mockFindDue
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([lake({ id: 'lake-26', lastInconsistencyScanAt: null })]);

    const result = await handler();

    expect(result.scanned).toBe(26);
    expect(mockFindDue).toHaveBeenCalledTimes(2);
    // The cursor tracks the SORT key, not just `_id` - the scan order is staleness.
    expect(mockFindDue.mock.calls[1][0].cursor).toEqual({
      lastInconsistencyScanAt: scannedAt,
      id: 'lake-25',
    });
  });

  it('caps a run at MAX_LAKES_PER_RUN and reports the deferred remainder as truncated', async () => {
    const page = Array.from({ length: 25 }, (_, i) => lake({ id: `lake-${i}` }));
    mockFindDue.mockResolvedValue(page);
    mockHasMoreDue.mockResolvedValue(true);

    const result = await handler();

    expect(result.scanned).toBe(200);
    expect(result.truncated).toBe(true);
    expect(mockFindDue).toHaveBeenCalledTimes(8);
  });

  it('does not report truncated when the fleet size is an exact multiple of the cap', async () => {
    const page = Array.from({ length: 25 }, (_, i) => lake({ id: `lake-${i}` }));
    mockFindDue.mockResolvedValue(page);
    mockHasMoreDue.mockResolvedValue(false);

    const result = await handler();

    expect(result.scanned).toBe(200);
    expect(result.truncated).toBe(false);
  });

  it('reads one year for the whole run, so a run straddling New Year grades every lake alike', async () => {
    mockFindDue.mockResolvedValueOnce([lake({ id: 'a' }), lake({ id: 'b' })]).mockResolvedValueOnce([]);

    await handler();

    const years = mockDetect.mock.calls.map(call => call[1]);
    expect(new Set(years).size).toBe(1);
    expect(years[0]).toBe(new Date().getUTCFullYear());
  });

  it('emits the run metric even when the scan itself throws', async () => {
    mockFindDue.mockRejectedValue(new Error('cannot reach primary'));

    await expect(handler()).rejects.toThrow('cannot reach primary');

    expect(metricValue('LakeInconsistencySweepRuns')).toBe(1);
  });
});
