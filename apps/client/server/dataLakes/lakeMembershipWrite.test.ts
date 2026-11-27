import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    assertLakeAccessWithGrants: vi.fn(),
    isFallbackLake: vi.fn(),
    canManageLake: vi.fn(),
    addFileToDataLake: vi.fn(async () => {
      order.push('add');
      return { added: true };
    }),
    touchIfStable: vi.fn(async () => {
      order.push('touch');
    }),
    withTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccessWithGrants: mocks.assertLakeAccessWithGrants,
    isFallbackLake: mocks.isFallbackLake,
    canManageLake: mocks.canManageLake,
    addFileToDataLake: mocks.addFileToDataLake,
  },
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  dataLakeAccessGrantRepository: {},
  dataLakeRepository: { touchIfStable: mocks.touchIfStable },
  fabFileRepository: {},
  lakeMembershipRemovalRepository: {},
  scopedSettingsRepository: {},
  withTransaction: mocks.withTransaction,
}));
vi.mock('@bike4mind/server-utils/dataLakes/lakeConfigAuditDb', () => ({ lakeConfigAuditDb: {} }));
vi.mock('@bike4mind/server-utils/dataLakes/lakeMembershipAuditDb', () => ({ lakeMembershipAuditDb: {} }));
vi.mock('@bike4mind/server-utils/files/storageOwnerTransferDb', () => ({ storageOwnerTransferDb: {} }));

import type { AccessContext } from '@bike4mind/common';
import { addFileToWritableLake } from './lakeMembershipWrite';

const lake = { id: 'lake-1', name: 'Bills' };
const ctx = { userId: 'u1' } as unknown as AccessContext;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const write = (alsoInTransaction?: (l: typeof lake) => Promise<unknown>) =>
  addFileToWritableLake({
    lakeIdOrSlug: 'lake-1',
    ctx,
    actor: ctx as never,
    resolveFileId: () => 'file-1',
    logger,
    alsoInTransaction: alsoInTransaction as never,
  });

describe('addFileToWritableLake alsoInTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
    mocks.assertLakeAccessWithGrants.mockResolvedValue({ lake, grants: [] });
    mocks.isFallbackLake.mockReturnValue(false);
    mocks.canManageLake.mockReturnValue(true);
  });

  it('runs after the membership touch, inside the transaction, and returns its result as extra', async () => {
    const hook = vi.fn(async () => {
      mocks.order.push('hook');
      return 'saved';
    });
    const out = await write(hook);
    expect(mocks.order).toEqual(['add', 'touch', 'hook']);
    expect(hook).toHaveBeenCalledWith(lake);
    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ fileId: 'file-1', extra: 'saved' });
  });

  it('rejects the whole write when the hook throws', async () => {
    const boom = new Error('row write failed');
    await expect(write(async () => Promise.reject(boom))).rejects.toBe(boom);
  });

  it('never runs the hook when the gate refuses the lake', async () => {
    mocks.canManageLake.mockReturnValue(false);
    const hook = vi.fn();
    await expect(write(hook)).rejects.toMatchObject({ statusCode: 403 });
    expect(hook).not.toHaveBeenCalled();
    expect(mocks.addFileToDataLake).not.toHaveBeenCalled();
  });

  it('leaves extra undefined without a hook', async () => {
    expect((await write()).extra).toBeUndefined();
  });
});
