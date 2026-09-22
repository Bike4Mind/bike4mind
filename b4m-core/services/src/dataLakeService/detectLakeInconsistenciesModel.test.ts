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

const makeAdapters = (members: MemberRow[], textsById: Record<string, string[]> = {}) => {
  const findChunkTextSample = vi.fn(async (fabFileId: string) => textsById[fabFileId] ?? ['text']);
  return {
    db: {
      fabFiles: { findDataLakeMembershipMembers: vi.fn(async () => members) },
      fabFileChunks: { findChunkTextSample },
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
    // Member/batch counts stay within their own bounds (60 members / 15 per batch = 4 batches); the
    // cap is exercised by having a single batch report more contradictions than fit in the budget,
    // not by inflating the member count past what the pass will ever read.
    const perBatch = Array.from({ length: MODEL_INCONSISTENCY_FINDINGS_CAP }, (_, i) => ({
      subject: `dup ${i}`,
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
    const onBatchFindings = vi.fn().mockRejectedValueOnce(new Error('write failed')).mockResolvedValue(undefined);

    const result = await detectLakeInconsistenciesModel(lake, { ...adapters, onBatchFindings } as never);

    expect(result.batchesRun).toBe(2);
    expect(result.batchesUnpersisted).toBe(1);
    // Still returned, so the caller can see what the failed write would have stored.
    expect(result.findings).toHaveLength(2);
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
    expect(result.batchesRun).toBeLessThan(3);
    expect(adapters.logger.warn).toHaveBeenCalledWith(expect.stringContaining('not enough wall clock'));
  });

  it('reads chunk text with bounded concurrency rather than one member at a time', async () => {
    // The lexical pass fans out 8 at a time for the same collection; this pass reads 4x the chunks
    // per member, so serializing it would put up to 60 round trips ahead of the first LLM call.
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
