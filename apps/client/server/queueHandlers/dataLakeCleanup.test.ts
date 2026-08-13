import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestError } from '@bike4mind/utils';

// Passthrough the wrapper so we drive the raw handler directly.
vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  cleanup: vi.fn(),
  openSearchRetrievalIndex: vi.fn(() => ({ removeForDataLake: vi.fn() })),
  selfHostOpenSearchEnabled: vi.fn(() => false),
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeBatchRepository: {},
  fabFileRepository: {},
  fabFileChunkRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { cleanupDeletedDataLake: h.cleanup, openSearchRetrievalIndex: h.openSearchRetrievalIndex },
}));
vi.mock('@bike4mind/fab-pipeline', () => ({ FabFileChunkSearchIndex: {} }));
vi.mock('@bike4mind/db-core', () => ({ selfHostOpenSearchEnabled: h.selfHostOpenSearchEnabled }));

import { dispatch } from './dataLakeCleanup';

const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn(), info: vi.fn(), updateMetadata: vi.fn() } as never;
const makeEvent = (body: unknown) => ({ Records: [{ body: JSON.stringify(body) }] }) as never;
const payload = { dataLakeId: 'lake1', actor: { userId: 'u1', isAdmin: false } };

describe('dataLakeCleanup consumer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses the message and runs the cleanup service with the four repos + logger', async () => {
    h.cleanup.mockResolvedValue(undefined);
    await dispatch(makeEvent(payload), {} as never, logger);
    expect(h.cleanup).toHaveBeenCalledWith(
      { userId: 'u1', isAdmin: false },
      'lake1',
      expect.objectContaining({
        db: expect.objectContaining({ dataLakes: expect.anything(), fabFileChunks: expect.anything() }),
        logger,
      })
    );
  });

  // Only self-host OpenSearch needs this port wired (see ports.ts) - Atlas's vector index lives
  // on the FabFileChunk collection itself, so the chunk sweep already removes it there.
  it('passes retrievalIndex: undefined when self-host OpenSearch is off', async () => {
    h.selfHostOpenSearchEnabled.mockReturnValue(false);
    h.cleanup.mockResolvedValue(undefined);
    await dispatch(makeEvent(payload), {} as never, logger);
    expect(h.openSearchRetrievalIndex).not.toHaveBeenCalled();
    expect(h.cleanup).toHaveBeenCalledWith(
      expect.anything(),
      'lake1',
      expect.objectContaining({ retrievalIndex: undefined })
    );
  });

  it('wires a real retrievalIndex when self-host OpenSearch is on', async () => {
    h.selfHostOpenSearchEnabled.mockReturnValue(true);
    h.cleanup.mockResolvedValue(undefined);
    await dispatch(makeEvent(payload), {} as never, logger);
    expect(h.openSearchRetrievalIndex).toHaveBeenCalled();
    expect(h.cleanup).toHaveBeenCalledWith(
      expect.anything(),
      'lake1',
      expect.objectContaining({ retrievalIndex: expect.objectContaining({ removeForDataLake: expect.anything() }) })
    );
  });

  it('swallows a BadRequestError (permanently-invalid message) instead of retrying to the DLQ', async () => {
    h.cleanup.mockRejectedValue(new BadRequestError('must be soft-deleted'));
    await expect(dispatch(makeEvent(payload), {} as never, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('rethrows an unexpected error so SQS retries then DLQs', async () => {
    h.cleanup.mockRejectedValue(new Error('mongo down'));
    await expect(dispatch(makeEvent(payload), {} as never, logger)).rejects.toThrow('mongo down');
  });

  it('swallows a malformed message (bad shape) instead of retrying it to the DLQ', async () => {
    // Parse happens inside the try, so a permanently-invalid payload is swallowed, not rethrown.
    await expect(dispatch(makeEvent({ actor: { userId: 'u1' } }), {} as never, logger)).resolves.toBeUndefined();
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
