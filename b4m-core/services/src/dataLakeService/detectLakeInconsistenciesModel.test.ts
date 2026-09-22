import { describe, it, expect, vi, beforeEach } from 'vitest';

const evaluateMock = vi.fn();

vi.mock('../llm/LakeContradictionReadingService', () => ({
  LakeContradictionReadingService: class {
    evaluate = (...args: unknown[]) => evaluateMock(...args);
  },
}));

const {
  detectLakeInconsistenciesModel,
  MODEL_INCONSISTENCY_MEMBER_SAMPLE,
  MODEL_INCONSISTENCY_CHUNKS_PER_MEMBER,
  MODEL_INCONSISTENCY_BATCH_SIZE,
  MODEL_INCONSISTENCY_MAX_BATCH_FAILURES,
  MODEL_INCONSISTENCY_FINDINGS_CAP,
  MODEL_INCONSISTENCY_BATCH_BUDGET_MS,
} = await import('./detectLakeInconsistenciesModel');

const lake = {
  id: 'lake1',
  datalakeTag: 'datalake:acme',
  fileTagPrefix: 'acme:',
  createdByUserId: 'u1',
};

type MemberRow = { fabFileId: string; fileName?: string };
const memberRow = (fabFileId: string, fileName = `${fabFileId}.pdf`): MemberRow => ({ fabFileId, fileName });

const makeAdapters = (
  members: MemberRow[],
  textsById: Record<string, string[]> = {},
  dismissedKeys: { kind: string; subject: string }[] = []
) => {
  const findChunkTextSample = vi.fn(async (fabFileId: string) => textsById[fabFileId] ?? ['text']);
  return {
    db: {
      fabFiles: { findDataLakeMembershipMembers: vi.fn(async () => members) },
      fabFileChunks: { findChunkTextSample },
      dataLakeFindings: { listDismissedKeys: vi.fn(async () => dismissedKeys) },
    },
    apiKeyTable: {} as never,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  };
};

describe('detectLakeInconsistenciesModel', () => {
  beforeEach(() => {
    evaluateMock.mockReset();
    evaluateMock.mockResolvedValue([]);
  });

  it('never scans on a null datalakeTag - this reads document text', async () => {
    const adapters = makeAdapters([memberRow('a')]);

    const result = await detectLakeInconsistenciesModel({ ...lake, datalakeTag: '' }, adapters as never);

    expect(adapters.db.fabFiles.findDataLakeMembershipMembers).not.toHaveBeenCalled();
    expect(result).toEqual({
      findings: [],
      memberCount: 0,
      memberSampled: false,
      batchesRun: 0,
      batchesFailed: 0,
      batchesUnpersisted: 0,
      subjectsDropped: 0,
      dismissedSuppressed: 0,
      subjectsMerged: 0,
      deadlineReached: false,
      truncated: false,
    });
  });

  it('reads chunk text with its own, deeper bound than the lexical pass', async () => {
    const adapters = makeAdapters([memberRow('a'), memberRow('b')]);

    await detectLakeInconsistenciesModel(lake, adapters as never);

    expect(adapters.db.fabFileChunks.findChunkTextSample).toHaveBeenCalledWith(
      'a',
      MODEL_INCONSISTENCY_CHUNKS_PER_MEMBER
    );
  });

  it('bounds the member scan and reports the result as sampled', async () => {
    const tooMany = Array.from({ length: MODEL_INCONSISTENCY_MEMBER_SAMPLE + 1 }, (_, i) => memberRow(`f${i}`));
    const adapters = makeAdapters(tooMany);

    const result = await detectLakeInconsistenciesModel(lake, adapters as never);

    expect(result.memberSampled).toBe(true);
    expect(adapters.db.fabFileChunks.findChunkTextSample).toHaveBeenCalledTimes(MODEL_INCONSISTENCY_MEMBER_SAMPLE);
    expect(adapters.logger.warn).toHaveBeenCalledWith(expect.stringContaining('memberSampled'));
  });

  it('skips the LLM call entirely with fewer than two readable documents', async () => {
    const adapters = makeAdapters([memberRow('a')]);

    const result = await detectLakeInconsistenciesModel(lake, adapters as never);

    expect(evaluateMock).not.toHaveBeenCalled();
    expect(result.memberCount).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it('isolates an unreadable member instead of failing the whole run', async () => {
    const adapters = makeAdapters([memberRow('bad'), memberRow('a'), memberRow('b')]);
    adapters.db.fabFileChunks.findChunkTextSample.mockImplementation(async (fabFileId: string) => {
      if (fabFileId === 'bad') throw new Error('chunk read failed');
      return ['text'];
    });

    const result = await detectLakeInconsistenciesModel(lake, adapters as never);

    expect(result.memberCount).toBe(2);
    expect(adapters.logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not read chunk text'));
  });

  it('maps a model contradiction into a narrative-contradiction finding with a normalized subject', async () => {
    evaluateMock.mockResolvedValueOnce([
      {
        subject: '  Refund WINDOW  ',
        documents: [
          { fabFileId: 'a', excerpt: 'Refunds are available for 30 days.' },
          { fabFileId: 'b', excerpt: 'Refunds are final; no window applies.' },
        ],
      },
    ]);
    const adapters = makeAdapters([memberRow('a'), memberRow('b')]);

    const result = await detectLakeInconsistenciesModel(lake, adapters as never);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      kind: 'narrative-contradiction',
      subject: 'refund window',
      documentCount: 2,
    });
    expect(result.findings[0].evidence.map(e => e.fabFileId).sort()).toEqual(['a', 'b']);
    // fileName is resolved from the batch, not carried by the model.
    expect(result.findings[0].evidence.find(e => e.fabFileId === 'a')?.fileName).toBe('a.pdf');
  });

  it('splits documents across batches and calls the reader once per batch', async () => {
    const memberCount = MODEL_INCONSISTENCY_BATCH_SIZE + 1;
    const members = Array.from({ length: memberCount }, (_, i) => memberRow(`d${i}`));
    const adapters = makeAdapters(members);

    const result = await detectLakeInconsistenciesModel(lake, adapters as never);

    expect(evaluateMock).toHaveBeenCalledTimes(2);
    expect(evaluateMock.mock.calls[0][0].documents).toHaveLength(MODEL_INCONSISTENCY_BATCH_SIZE);
    expect(evaluateMock.mock.calls[1][0].documents).toHaveLength(1);
    expect(result.batchesRun).toBe(2);
  });

  it('isolates a failed batch (reader returns null) rather than failing the run', async () => {
    evaluateMock.mockResolvedValueOnce(null).mockResolvedValueOnce([
      {
        subject: 'x',
        documents: [
          { fabFileId: 'c', excerpt: 'e1' },
          { fabFileId: 'd', excerpt: 'e2' },
        ],
      },
    ]);
    const members = Array.from({ length: MODEL_INCONSISTENCY_BATCH_SIZE + 2 }, (_, i) => memberRow(`d${i}`));
    const adapters = makeAdapters(members);

    const result = await detectLakeInconsistenciesModel(lake, adapters as never);

    expect(result.batchesRun).toBe(2);
    expect(result.batchesFailed).toBe(1);
    expect(result.findings).toHaveLength(1);
  });

  it('aborts after consecutive batch failures rather than burning the whole run', async () => {
    evaluateMock.mockResolvedValue(null);
    const memberCount = MODEL_INCONSISTENCY_BATCH_SIZE * (MODEL_INCONSISTENCY_MAX_BATCH_FAILURES + 2);
    const members = Array.from({ length: memberCount }, (_, i) => memberRow(`d${i}`));
    const adapters = makeAdapters(members);

    const result = await detectLakeInconsistenciesModel(lake, adapters as never);

    expect(result.batchesRun).toBe(MODEL_INCONSISTENCY_MAX_BATCH_FAILURES);
    expect(result.batchesFailed).toBe(MODEL_INCONSISTENCY_MAX_BATCH_FAILURES);
    expect(adapters.logger.error).toHaveBeenCalledWith(expect.stringContaining('aborting the run'));
  });

  it('caps findings per run and reports truncation', async () => {
    // Member/batch counts stay within their own bounds; the cap is exercised by having a single batch
    // report more DISTINCT contradictions than fit in the budget, not by inflating the member count
    // past what the pass will ever read. Distinct matters: duplicates merge rather than accumulate,
    // so a batch of repeated subjects would never reach the cap at all.
    const perBatch = Array.from({ length: MODEL_INCONSISTENCY_FINDINGS_CAP + 1 }, (_, i) => ({
      subject: `subject ${i}`,
      documents: [
        { fabFileId: 'a', excerpt: 'e1' },
        { fabFileId: 'b', excerpt: 'e2' },
      ],
    }));
    evaluateMock.mockResolvedValue(perBatch);
    const members = Array.from({ length: MODEL_INCONSISTENCY_MEMBER_SAMPLE }, (_, i) => memberRow(`d${i}`));
    const adapters = makeAdapters(members);

    const result = await detectLakeInconsistenciesModel(lake, adapters as never);

    expect(result.findings.length).toBe(MODEL_INCONSISTENCY_FINDINGS_CAP);
    expect(result.truncated).toBe(true);
  });

  it('caps what is WRITTEN, not just what is returned', async () => {
    // The cap has to bind the durable path. `onBatchFindings` fires per batch, before any end-of-run
    // slice could run, so a cap applied only to the returned array would let several chatty batches
    // persist far more rows than the constant claims - and the response would still report exactly
    // MODEL_INCONSISTENCY_FINDINGS_CAP, hiding it.
    let nextSubject = 0;
    evaluateMock.mockImplementation(async () =>
      Array.from({ length: MODEL_INCONSISTENCY_FINDINGS_CAP }, () => ({
        subject: `subject ${nextSubject++}`,
        documents: [
          { fabFileId: 'a', excerpt: 'e1' },
          { fabFileId: 'b', excerpt: 'e2' },
        ],
      }))
    );
    const members = Array.from({ length: MODEL_INCONSISTENCY_BATCH_SIZE * 3 }, (_, i) => memberRow(`d${i}`));
    const adapters = makeAdapters(members);
    const persisted: unknown[] = [];
    const onBatchFindings = vi.fn(async (findings: unknown[]) => {
      persisted.push(...findings);
    });

    const result = await detectLakeInconsistenciesModel(lake, { ...adapters, onBatchFindings } as never);

    expect(result.batchesRun).toBe(3);
    expect(result.truncated).toBe(true);
    expect(persisted).toHaveLength(MODEL_INCONSISTENCY_FINDINGS_CAP);
    expect(result.findings).toHaveLength(MODEL_INCONSISTENCY_FINDINGS_CAP);
  });
  it('drops a contradiction whose subject normalizes to empty rather than collapsing them onto one row', async () => {
    // `subject` is part of the unique key recordLakeFindings upserts on, so every finding that
    // normalized to '' would share a SINGLE durable row per lake, each run overwriting the last.
    // A subject in a non-Latin script empties out under normalizeSubject's [a-z0-9\s%.-] filter.
    evaluateMock.mockResolvedValue([
      {
        subject: '\u4ed8\u6b3e\u671f\u9650',
        documents: [
          { fabFileId: 'a', excerpt: 'e1' },
          { fabFileId: 'b', excerpt: 'e2' },
        ],
      },
      {
        subject: 'refund window',
        documents: [
          { fabFileId: 'a', excerpt: 'e1' },
          { fabFileId: 'b', excerpt: 'e2' },
        ],
      },
    ]);
    const adapters = makeAdapters([memberRow('a'), memberRow('b')]);

    const result = await detectLakeInconsistenciesModel(lake, adapters as never);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].subject).toBe('refund window');
    expect(result.subjectsDropped).toBe(1);
  });

  it('persists each batch as it completes, so a run killed part-way keeps what it paid for', async () => {
    evaluateMock.mockResolvedValue([
      {
        subject: 'refund window',
        documents: [
          { fabFileId: 'a', excerpt: 'e1' },
          { fabFileId: 'b', excerpt: 'e2' },
        ],
      },
    ]);
    const members = Array.from({ length: MODEL_INCONSISTENCY_BATCH_SIZE * 2 }, (_, i) => memberRow(`d${i}`));
    const adapters = makeAdapters(members);
    const onBatchFindings = vi.fn(async () => {});

    await detectLakeInconsistenciesModel(lake, { ...adapters, onBatchFindings } as never);

    expect(onBatchFindings).toHaveBeenCalledTimes(2);
    expect(onBatchFindings.mock.calls[0][0]).toHaveLength(1);
  });

  it('counts a failed persist and keeps running rather than losing the remaining batches too', async () => {
    // Distinct subjects per batch on purpose: same-subject findings MERGE, so a fixture that repeated
    // one would return a single finding and say nothing about the second batch having run at all.
    let batch = 0;
    evaluateMock.mockImplementation(async () => [
      {
        subject: `refund window ${batch++}`,
        documents: [
          { fabFileId: 'a', excerpt: 'e1' },
          { fabFileId: 'b', excerpt: 'e2' },
        ],
      },
    ]);
    const members = Array.from({ length: MODEL_INCONSISTENCY_BATCH_SIZE * 2 }, (_, i) => memberRow(`d${i}`));
    const adapters = makeAdapters(members);
    const onBatchFindings = vi.fn().mockRejectedValueOnce(new Error('write failed')).mockResolvedValue(undefined);

    const result = await detectLakeInconsistenciesModel(lake, { ...adapters, onBatchFindings } as never);

    expect(result.batchesRun).toBe(2);
    expect(result.batchesUnpersisted).toBe(1);
    // Still returned, so the caller can see what the failed write would have stored.
    expect(result.findings).toHaveLength(2);
  });

  it('merges two contradictions that normalize to one subject instead of minting two rows', async () => {
    // `subject` is part of the unique key recordLakeFindings upserts on, and that upsert $sets
    // sources - so two findings sharing a normalized subject are one row, and pushing both would have
    // the second silently replace the first's evidence. Free model text collides far more often than
    // the lexical pass's bounded vocabulary, which is what makes this reachable.
    evaluateMock.mockResolvedValue([
      {
        subject: 'Refund Window',
        documents: [
          { fabFileId: 'a', excerpt: 'thirty days' },
          { fabFileId: 'b', excerpt: 'sixty days' },
        ],
      },
      {
        subject: 'refund window',
        documents: [
          { fabFileId: 'b', excerpt: 'sixty days' },
          { fabFileId: 'c', excerpt: 'ninety days' },
        ],
      },
    ]);
    const adapters = makeAdapters([memberRow('a'), memberRow('b'), memberRow('c')]);

    const result = await detectLakeInconsistenciesModel(lake, adapters as never);

    expect(result.findings).toHaveLength(1);
    expect(result.subjectsMerged).toBe(1);
    // Evidence is the UNION, not the second citation overwriting the first.
    expect(result.findings[0].evidence.map(e => e.fabFileId)).toEqual(['a', 'b', 'c']);
    // documentCount counts DISTINCT documents - b was cited by both and must not be counted twice.
    expect(result.findings[0].documentCount).toBe(3);
  });

  it('suppresses a contradiction a curator has already dismissed', async () => {
    // Re-detection cannot reopen a dismissed row (recordDetected writes status under $setOnInsert
    // only). What suppression protects is the curator's ruling being re-reported, and the cap slot
    // the re-derived finding would otherwise take from a genuinely new one.
    evaluateMock.mockResolvedValue([
      {
        subject: 'refund window',
        documents: [
          { fabFileId: 'a', excerpt: 'e1' },
          { fabFileId: 'b', excerpt: 'e2' },
        ],
      },
      {
        subject: 'support hours',
        documents: [
          { fabFileId: 'a', excerpt: 'e3' },
          { fabFileId: 'b', excerpt: 'e4' },
        ],
      },
    ]);
    const adapters = makeAdapters([memberRow('a'), memberRow('b')], {}, [
      { kind: 'narrative-contradiction', subject: 'refund window' },
    ]);

    const result = await detectLakeInconsistenciesModel(lake, adapters as never);

    expect(adapters.db.dataLakeFindings.listDismissedKeys).toHaveBeenCalledWith('lake1', 'model');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].subject).toBe('support hours');
    expect(result.dismissedSuppressed).toBe(1);
  });

  it('runs without suppression rather than failing when the dismissal read throws', async () => {
    // Tolerated, not required: this read is not worth losing a run that would otherwise succeed.
    evaluateMock.mockResolvedValue([
      {
        subject: 'refund window',
        documents: [
          { fabFileId: 'a', excerpt: 'e1' },
          { fabFileId: 'b', excerpt: 'e2' },
        ],
      },
    ]);
    const adapters = makeAdapters([memberRow('a'), memberRow('b')]);
    adapters.db.dataLakeFindings.listDismissedKeys = vi.fn(async () => {
      throw new Error('mongo blip');
    });

    const result = await detectLakeInconsistenciesModel(lake, adapters as never);

    expect(result.findings).toHaveLength(1);
    expect(result.dismissedSuppressed).toBe(0);
    expect(adapters.logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not read dismissed findings'));
  });

  it('resets the consecutive-failure counter after a success, so alternating failures never abort', async () => {
    // The positive control for the reset. Without it, three non-consecutive failures trip the
    // systemic-failure abort and the run stops with batches it had every reason to run. A fixture
    // that fails every batch, or one that never fails twice, leaves the reset untested.
    // fail, fail, SUCCESS, fail, fail over a full member sample. Without the reset the counter reads
    // 1, 2, 2, 3 and the run aborts on the FOURTH batch; with it, the success zeroes the counter and
    // all five run. The two outcomes differ in batchesRun, so this is an exact pin rather than a
    // fixture that would pass either way.
    const contradiction = [
      {
        subject: 'refund window',
        documents: [
          { fabFileId: 'a', excerpt: 'e1' },
          { fabFileId: 'b', excerpt: 'e2' },
        ],
      },
    ];
    evaluateMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(contradiction)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const batchesInAFullRun = Math.ceil(MODEL_INCONSISTENCY_MEMBER_SAMPLE / MODEL_INCONSISTENCY_BATCH_SIZE);
    const members = Array.from({ length: MODEL_INCONSISTENCY_MEMBER_SAMPLE }, (_, i) => memberRow(`d${i}`));
    const adapters = makeAdapters(members);

    const result = await detectLakeInconsistenciesModel(lake, adapters as never);

    expect(result.batchesRun).toBe(batchesInAFullRun);
    expect(result.batchesFailed).toBe(4);
    expect(adapters.logger.error).not.toHaveBeenCalled();
  });

  it('stops between batches when the wall clock cannot fit another one', async () => {
    // Stopping here is the point: starting a batch that cannot finish bills the LLM call and then
    // throws its findings away when the Lambda is killed mid-call.
    evaluateMock.mockResolvedValue([]);
    const members = Array.from({ length: MODEL_INCONSISTENCY_BATCH_SIZE * 3 }, (_, i) => memberRow(`d${i}`));
    const adapters = makeAdapters(members);
    let remaining = MODEL_INCONSISTENCY_BATCH_BUDGET_MS * 2;
    const getRemainingTimeInMillis = () => {
      const now = remaining;
      remaining -= MODEL_INCONSISTENCY_BATCH_BUDGET_MS;
      return now;
    };

    const result = await detectLakeInconsistenciesModel(lake, { ...adapters, getRemainingTimeInMillis } as never);

    expect(result.deadlineReached).toBe(true);
    // Exact, not an inequality: the fixture hands out BUDGET*2 then BUDGET then 0, so two batches
    // fit and the third does not. `toBeLessThan(3)` also passes when `<` loosens to `<=` at the
    // deadline check, which silently throws away a batch the run had budget for.
    expect(result.batchesRun).toBe(2);
    expect(adapters.logger.warn).toHaveBeenCalledWith(expect.stringContaining('not enough wall clock'));
  });

  it('reads chunk text with bounded concurrency rather than one member at a time', async () => {
    // The lexical pass fans out 8 at a time for the same collection; this pass reads 2.4x the chunks
    // per member, so serializing it would put up to MODEL_INCONSISTENCY_MEMBER_SAMPLE round trips
    // ahead of the first LLM call.
    const members = Array.from({ length: 16 }, (_, i) => memberRow(`d${i}`));
    let inFlight = 0;
    let peak = 0;
    const adapters = makeAdapters(members);
    adapters.db.fabFileChunks.findChunkTextSample = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setImmediate(resolve));
      inFlight -= 1;
      return ['text'];
    });

    await detectLakeInconsistenciesModel(lake, adapters as never);

    expect(peak).toBeGreaterThan(1);
  });
});
