import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AccessContext, IDataLakeDocument } from '@bike4mind/common';
import { assertLakeAccess } from './assertLakeAccess';

// A private DB lake (not a DATA_LAKES fallback id): reachable only by owner/admin under the legacy
// gate. A reader-grant holder is denied by legacy and admitted only once the cutover is enforced.
const privateLake = {
  id: '507f1f77bcf86cd799439011',
  createdByUserId: 'owner',
  organizationId: undefined,
  requiredUserTag: undefined,
  requiredEntitlement: undefined,
  isPublic: false,
} as unknown as IDataLakeDocument;

const readerCtx: AccessContext = { userId: 'reader1', isAdmin: false, userTags: [], organizationIds: [] };

const readerGrantRow = {
  dataLakeId: privateLake.id,
  principalType: 'user' as const,
  principalId: 'reader1',
  role: 'reader' as const,
};

const makeAdapters = (enforce: boolean | Error) => {
  const logger = { info: vi.fn(), warn: vi.fn() };
  const getSettingsValue =
    enforce instanceof Error ? vi.fn().mockRejectedValue(enforce) : vi.fn().mockResolvedValue(enforce);
  return {
    logger,
    getSettingsValue,
    adapters: {
      db: {
        dataLakes: {
          findById: vi.fn().mockResolvedValue(privateLake),
          findBySlug: vi.fn().mockResolvedValue(null),
        },
        dataLakeAccessGrants: { listByLake: vi.fn().mockResolvedValue([readerGrantRow]) },
        settings: { getSettingsValue },
      },
      logger,
    },
  };
};

describe('assertLakeAccess - read-time grant cutover wiring (#1673)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('report-only: denies the reader (legacy) BUT emits the divergence diff line', async () => {
    const { adapters, logger } = makeAdapters(false);
    await expect(assertLakeAccess(privateLake.id, readerCtx, adapters as never)).rejects.toThrow(/not found/i);
    expect(logger.info).toHaveBeenCalledWith(
      '[lakeReadGrantCutover] read grant would change access (report-only)',
      expect.objectContaining({ lakeId: privateLake.id, userId: 'reader1', legacyArm: 'private-deny' })
    );
  });

  it('enforce: admits the reader AND stays silent (no per-access divergence noise post-flip)', async () => {
    const { adapters, logger } = makeAdapters(true);
    const lake = await assertLakeAccess(privateLake.id, readerCtx, adapters as never);
    expect(lake.id).toBe(privateLake.id);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('a FAILED flag read degrades to report-only (denies) rather than silently enforcing', async () => {
    const { adapters, logger } = makeAdapters(new Error('settings down'));
    await expect(assertLakeAccess(privateLake.id, readerCtx, adapters as never)).rejects.toThrow(/not found/i);
    // The enforce-flag read warned (distinguishes "off" from "read failed"), and the report-only
    // diff still logged - a failed read must never widen access.
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it('no divergence line when the caller already passes the legacy gate (owner)', async () => {
    const { adapters, logger } = makeAdapters(false);
    const ownerCtx: AccessContext = { ...readerCtx, userId: 'owner' };
    const lake = await assertLakeAccess(privateLake.id, ownerCtx, adapters as never);
    expect(lake.id).toBe(privateLake.id);
    expect(logger.info).not.toHaveBeenCalled();
  });
});
