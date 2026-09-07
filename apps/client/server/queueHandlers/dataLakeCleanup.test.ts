import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestError } from '@bike4mind/utils';

// Passthrough the wrapper so we drive the raw handler directly.
vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  cleanup: vi.fn(),
  releasePurgingToDeleted: vi.fn(),
  openSearchRetrievalIndex: vi.fn(() => ({ removeForDataLake: vi.fn() })),
  selfHostOpenSearchEnabled: vi.fn(() => false),
  releaseDriveConnectionForLake: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: { releasePurgingToDeleted: h.releasePurgingToDeleted },
  dataLakeBatchRepository: {},
  dataLakeAccessGrantRepository: {},
  dataLakeProposalRepository: {},
  lakeMembershipDecisionRepository: {},
  fabFileRepository: {},
  fabFileChunkRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { cleanupDeletedDataLake: h.cleanup, openSearchRetrievalIndex: h.openSearchRetrievalIndex },
}));
vi.mock('@bike4mind/fab-pipeline', () => ({ FabFileChunkSearchIndex: {} }));
vi.mock('@bike4mind/db-core', () => ({ selfHostOpenSearchEnabled: h.selfHostOpenSearchEnabled }));
vi.mock('@server/integrations/google/drive/common', () => ({
  releaseDriveConnectionForLake: h.releaseDriveConnectionForLake,
}));

import { dispatch } from './dataLakeCleanup';

const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn(), info: vi.fn(), updateMetadata: vi.fn() } as never;
const makeEvent = (body: unknown) => ({ Records: [{ body: JSON.stringify(body) }] }) as never;
const payload = { dataLakeId: 'lake1', actor: { userId: 'u1', isAdmin: false } };

describe('dataLakeCleanup consumer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses the message and runs the cleanup service with the lake repos + logger', async () => {
    h.cleanup.mockResolvedValue(undefined);
    await dispatch(makeEvent(payload), {} as never, logger);
    expect(h.cleanup).toHaveBeenCalledWith(
      { userId: 'u1', isAdmin: false },
      'lake1',
      expect.objectContaining({
        db: expect.objectContaining({
          dataLakes: expect.anything(),
          fabFileChunks: expect.anything(),
          // The acquisition queue is swept alongside the grants (#1671) - a proposal outliving its
          // lake is unreviewable, so an unwired repo here would leave orphans behind every purge.
          dataLakeProposals: expect.anything(),
          // Same reason, and asserted for a sharper one: the service reaches this port through `?.`,
          // so an unwired repo is a silent no-op that typechecks forever. This is the only place
          // that can tell "swept" from "never ran".
          lakeMembershipDecisions: expect.anything(),
        }),
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

  it('wires the Drive release port, so a purge frees the folder claim it was holding', async () => {
    // Unwired, the connection row outlives its lake and its globally-unique driveFolderId can never
    // be claimed again by anyone - there is no surface left that can reach the row to release it.
    h.cleanup.mockResolvedValue(undefined);
    h.releaseDriveConnectionForLake.mockResolvedValue(true);
    await dispatch(makeEvent(payload), {} as never, logger);
    const port = h.cleanup.mock.calls[0][2].releaseDriveConnection;
    await port({ dataLakeId: 'lake1' });
    expect(h.releaseDriveConnectionForLake).toHaveBeenCalledWith('lake1');
    // The claim "that folder is free again" is only checkable after the fact if it is logged.
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('folder claim'), { dataLakeId: 'lake1' });
  });

  it('stays quiet when the purged lake had no Drive connection', async () => {
    h.cleanup.mockResolvedValue(undefined);
    h.releaseDriveConnectionForLake.mockResolvedValue(false);
    await dispatch(makeEvent(payload), {} as never, logger);
    await h.cleanup.mock.calls[0][2].releaseDriveConnection({ dataLakeId: 'lake1' });
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('folder claim'), expect.anything());
  });

  it('releases an accepted purge its own guard refused, and says so at ERROR (#1744)', async () => {
    // Was a silent WARN, which is precisely how an accepted, irreversible purge could vanish with no
    // user-visible trace. The release puts the lake back in the deleted list where its owner can
    // see it and retry, so the purge either completes or comes back - never neither.
    h.cleanup.mockRejectedValue(new BadRequestError('must be soft-deleted'));
    await expect(dispatch(makeEvent(payload), {} as never, logger)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('releasing the accepted purge'),
      expect.objectContaining({ dataLakeId: 'lake1' })
    );
    expect(h.releasePurgingToDeleted).toHaveBeenCalledWith('lake1');
  });

  it('does NOT release on an unexpected error, since that sweep may be half-done', async () => {
    // The release advertises the lake as restorable. Only a guard failure is known to have
    // destroyed nothing; a DB/network failure can land mid-sweep, so that path retries to the DLQ
    // and is recovered by admin replay instead.
    h.cleanup.mockRejectedValue(new Error('mongo down'));
    await expect(dispatch(makeEvent(payload), {} as never, logger)).rejects.toThrow('mongo down');
    expect(h.releasePurgingToDeleted).not.toHaveBeenCalled();
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
    // Parsing the lake id is what failed, so there is no purge to release.
    expect(h.releasePurgingToDeleted).not.toHaveBeenCalled();
  });
});
