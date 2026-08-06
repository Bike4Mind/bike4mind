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

const getSettingsValueMock = vi.fn();
const extractMock = vi.fn();

// Pass the inner handler straight through so the test drives it directly, skipping connectDB and the
// warmer-invocation shortcut that the real wrapper performs.
vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger:
    (handler: (e: SQSEvent, c: Context, l: unknown) => Promise<unknown>) => (e: SQSEvent, c: Context) =>
      handler(e, c, { warn: vi.fn(), info: vi.fn(), error: vi.fn(), log: vi.fn(), updateMetadata: vi.fn() }),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: (...a: unknown[]) => getSettingsValueMock(...a) },
}));
vi.mock('@server/dataLakes/extractLakeMemory', () => ({
  extractLakeMemoryForBatch: (...a: unknown[]) => extractMock(...a),
}));

const { dispatch } = await import('./lakeMemoryExtraction');

const event = (body: unknown) => ({ Records: [{ body: JSON.stringify(body) }] }) as unknown as SQSEvent;
const context = (remainingMs = 600_000) => ({ getRemainingTimeInMillis: () => remainingMs }) as unknown as Context;
const PAYLOAD = { batchId: 'batch-1', dataLakeId: 'lake-1', userId: 'user-1' };

describe('lakeMemoryExtraction handler (#1440)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extractMock.mockResolvedValue({ docsProcessed: 1, factsWritten: 1 });
  });

  it('extracts when EnableLakeMemory is on', async () => {
    getSettingsValueMock.mockResolvedValue(true);

    await dispatch(event(PAYLOAD), context());

    expect(getSettingsValueMock).toHaveBeenCalledWith('EnableLakeMemory');
    expect(extractMock).toHaveBeenCalledTimes(1);
  });

  it('drops a queued extraction when the flag was turned off after enqueue', async () => {
    getSettingsValueMock.mockResolvedValue(false);

    await dispatch(event(PAYLOAD), context());

    expect(extractMock).not.toHaveBeenCalled();
  });

  it('fails closed when the flag lookup rejects - never writes on an unknown flag state', async () => {
    getSettingsValueMock.mockRejectedValue(new Error('mongo down'));

    await dispatch(event(PAYLOAD), context());

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
