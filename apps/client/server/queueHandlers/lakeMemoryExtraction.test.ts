/**
 * The `EnableLakeMemory` kill-switch has to stop the WRITE side too, not only injection.
 *
 * The enqueue gate (`enqueueLakeMemoryExtractionIfWanted`) runs when a batch finalizes, but the message
 * then sits in a queue with a 12-minute visibility window and up to two retries. Without a re-check in
 * the handler, an operator turning the flag off would still get beliefs written for every extraction
 * already in flight. Injection is gated independently, so those beliefs would be inert - but "complete
 * kill-switch" should mean the writes stop as well.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context, SQSEvent } from 'aws-lambda';
import { LAKE_MEMORY_MAX_CONTINUATION_SLICES } from '@server/dataLakes/lakeMemoryRateLimit';

const getSettingsValueMock = vi.fn();
const findByIdMock = vi.fn();
const extractMock = vi.fn();
const sendToQueueMock = vi.fn();
const setLakeMemoryCursorMock = vi.fn();

// Pass the inner handler straight through so the test drives it directly, skipping connectDB and the
// warmer-invocation shortcut that the real wrapper performs.
vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger:
    (handler: (e: SQSEvent, c: Context, l: unknown) => Promise<unknown>) => (e: SQSEvent, c: Context) =>
      handler(e, c, { warn: vi.fn(), info: vi.fn(), error: vi.fn(), log: vi.fn(), updateMetadata: vi.fn() }),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: (...a: unknown[]) => getSettingsValueMock(...a) },
  dataLakeRepository: {
    findById: (...a: unknown[]) => findByIdMock(...a),
    setLakeMemoryCursor: (...a: unknown[]) => setLakeMemoryCursorMock(...a),
  },
}));
vi.mock('@server/dataLakes/extractLakeMemory', () => ({
  extractLakeMemoryForBatch: (...a: unknown[]) => extractMock(...a),
}));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: (...a: unknown[]) => sendToQueueMock(...a) }));
vi.mock('sst', () => ({ Resource: { lakeMemoryQueue: { url: 'https://sqs.example/lake-memory' } } }));

const { dispatch } = await import('./lakeMemoryExtraction');

const event = (body: unknown) => ({ Records: [{ body: JSON.stringify(body) }] }) as unknown as SQSEvent;
const context = (remainingMs = 600_000) => ({ getRemainingTimeInMillis: () => remainingMs }) as unknown as Context;
const PAYLOAD = { batchId: 'batch-1', dataLakeId: 'lake-1', userId: 'user-1' };

describe('lakeMemoryExtraction handler (#1440)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extractMock.mockResolvedValue({ docsProcessed: 1, factsWritten: 1, hasMore: false });
    findByIdMock.mockResolvedValue({ lakeMemoryEnabled: true });
    setLakeMemoryCursorMock.mockResolvedValue(undefined);
  });

  it('extracts when EnableLakeMemory is on', async () => {
    getSettingsValueMock.mockResolvedValue(true);

    await dispatch(event(PAYLOAD), context());

    expect(getSettingsValueMock).toHaveBeenCalledWith('EnableLakeMemory');
    expect(extractMock).toHaveBeenCalledTimes(1);
    // Fully covered (hasMore:false) -> no continuation enqueued.
    expect(sendToQueueMock).not.toHaveBeenCalled();
  });

  it('re-enqueues a continuation run when the lake was not fully covered', async () => {
    getSettingsValueMock.mockResolvedValue(true);
    extractMock.mockResolvedValue({ docsProcessed: 100, factsWritten: 250, hasMore: true });

    await dispatch(event(PAYLOAD), context());

    // Same payload re-queued with the next slice; the next invocation resumes from the persisted cursor.
    expect(sendToQueueMock).toHaveBeenCalledWith('https://sqs.example/lake-memory', { ...PAYLOAD, slice: 1 });
  });

  it('stops the continuation chain at the slice ceiling instead of re-enqueuing unbounded', async () => {
    // A pathologically large lake keeps returning hasMore. The chain must not grow without limit: once
    // the slice count reaches LAKE_MEMORY_MAX_CONTINUATION_SLICES the handler stops re-enqueuing and logs,
    // leaving the persisted cursor for the next finalize to resume from.
    getSettingsValueMock.mockResolvedValue(true);
    extractMock.mockResolvedValue({ docsProcessed: 100, factsWritten: 250, hasMore: true });

    await dispatch(event({ ...PAYLOAD, slice: LAKE_MEMORY_MAX_CONTINUATION_SLICES - 1 }), context());

    expect(extractMock).toHaveBeenCalledTimes(1);
    expect(sendToQueueMock).not.toHaveBeenCalled();
  });

  it('does not re-enqueue a continuation when the flag was turned off after enqueue', async () => {
    getSettingsValueMock.mockResolvedValue(false);

    await dispatch(event(PAYLOAD), context());

    expect(extractMock).not.toHaveBeenCalled();
    expect(sendToQueueMock).not.toHaveBeenCalled();
  });

  // A chain that stops here never runs again, so any cursor an earlier slice parked is nobody's to
  // clear - and the health state reads `building` from a non-null cursor, so leaving it behind pins the
  // lake in a state nothing will move. Each intentional drop below therefore owes a cursor clear.
  it('clears a parked continuation cursor when the platform flag drops the chain', async () => {
    getSettingsValueMock.mockResolvedValue(false);

    await dispatch(event({ ...PAYLOAD, slice: 3 }), context());

    expect(extractMock).not.toHaveBeenCalled();
    expect(setLakeMemoryCursorMock).toHaveBeenCalledWith('lake-1', null);
  });

  it.each([
    ['false', false],
    ['null', null],
    ['absent', undefined],
  ])('drops the chain and clears the cursor when the lake opted out (lakeMemoryEnabled: %s)', async (_l, value) => {
    // All three spellings of "not opted in" have to behave identically. `false` is the explicit
    // opt-out, `null` and absent are what a lake written before the field existed carries - and only
    // an exact `=== true` treats the trio the same way.
    getSettingsValueMock.mockResolvedValue(true);
    findByIdMock.mockResolvedValue({ lakeMemoryEnabled: value });

    await dispatch(event({ ...PAYLOAD, slice: 2 }), context());

    expect(extractMock).not.toHaveBeenCalled();
    expect(sendToQueueMock).not.toHaveBeenCalled();
    expect(setLakeMemoryCursorMock).toHaveBeenCalledWith('lake-1', null);
  });

  it('drops a chain whose lake no longer exists, without writing to the missing document', async () => {
    // Reported separately from an opt-out: a deleted lake is not a manager's choice, and collapsing
    // the two sent an operator hunting for a setting nobody had changed. There is also nothing to
    // clear - the document is gone, so a cursor write would be pointless.
    getSettingsValueMock.mockResolvedValue(true);
    findByIdMock.mockResolvedValue(null);

    await dispatch(event(PAYLOAD), context());

    expect(extractMock).not.toHaveBeenCalled();
    expect(setLakeMemoryCursorMock).not.toHaveBeenCalled();
  });

  it('does not clear the cursor at the slice ceiling, which resumes on the next finalize', async () => {
    // The one drop that KEEPS its cursor, deliberately: the chain stopped only because it was long,
    // not because the lake stopped wanting it, and the next batch finalize resumes from there.
    getSettingsValueMock.mockResolvedValue(true);
    extractMock.mockResolvedValue({ docsProcessed: 100, factsWritten: 250, hasMore: true });

    await dispatch(event({ ...PAYLOAD, slice: LAKE_MEMORY_MAX_CONTINUATION_SLICES - 1 }), context());

    expect(setLakeMemoryCursorMock).not.toHaveBeenCalled();
  });

  it('still drops the chain when the cursor clear itself fails', async () => {
    // Best-effort by design: the clear runs AFTER the drop decision, so a failed write must not
    // resurrect work the flag just stopped, and must not DLQ a message that was correctly dropped.
    getSettingsValueMock.mockResolvedValue(true);
    findByIdMock.mockResolvedValue({ lakeMemoryEnabled: false });
    setLakeMemoryCursorMock.mockRejectedValue(new Error('mongo down'));

    await expect(dispatch(event(PAYLOAD), context())).resolves.toBeUndefined();
    expect(extractMock).not.toHaveBeenCalled();
  });

  it('rethrows when the flag lookup rejects, so SQS retries instead of the work being dropped', async () => {
    // Fails closed for this attempt (nothing extracts) WITHOUT discarding the message. Collapsing an
    // indeterminate lookup into a definitive off would silently delete the extraction over a transient
    // blip - the same failed-lookup-vs-resolved-false distinction the memento gate resolver draws.
    getSettingsValueMock.mockRejectedValue(new Error('mongo down'));

    await expect(dispatch(event(PAYLOAD), context())).rejects.toThrow('mongo down');
    expect(extractMock).not.toHaveBeenCalled();
  });

  it('hands the extractor the real Lambda clock so its deadline guard is accurate', async () => {
    getSettingsValueMock.mockResolvedValue(true);

    await dispatch(event(PAYLOAD), context(123_456));

    const passed = extractMock.mock.calls[0][0] as { getRemainingTimeInMillis?: () => number };
    expect(passed.getRemainingTimeInMillis?.()).toBe(123_456);
  });

  it('swallows a malformed payload instead of DLQing it', async () => {
    getSettingsValueMock.mockResolvedValue(true);

    await expect(dispatch(event({ nope: true }), context())).resolves.toBeUndefined();
    expect(extractMock).not.toHaveBeenCalled();
  });

  it('rethrows a real extraction failure so SQS retries', async () => {
    getSettingsValueMock.mockResolvedValue(true);
    extractMock.mockRejectedValue(new Error('LLM provider 503'));

    await expect(dispatch(event(PAYLOAD), context())).rejects.toThrow('LLM provider 503');
  });
});
