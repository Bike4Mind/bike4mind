import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AccessContext } from '@bike4mind/common';
import type { Request } from 'express';

const { assertLakeResearchManage, undoLakeConfigChange, touchIfStable } = vi.hoisted(() => ({
  assertLakeResearchManage: vi.fn(),
  undoLakeConfigChange: vi.fn(),
  touchIfStable: vi.fn(),
}));

vi.mock('@server/dataLakes/assertLakeResearchManage', () => ({ assertLakeResearchManage }));
vi.mock('@bike4mind/server-utils/dataLakes/lakeConfigAuditDb', () => ({ lakeConfigAuditDb: {} }));
vi.mock('@bike4mind/server-utils/dataLakes/lakeMembershipAuditDb', () => ({ lakeMembershipAuditDb: {} }));
vi.mock('@bike4mind/server-utils/files/storageOwnerTransferDb', () => ({ storageOwnerTransferDb: {} }));
vi.mock('@bike4mind/services', () => ({
  dataLakeResearchService: {},
  dataLakeService: { undoLakeConfigChange },
}));
vi.mock('@bike4mind/database', () => ({
  withTransaction: (fn: () => Promise<unknown>) => fn(),
  dataLakeProposalRepository: {},
  dataLakeResearchConfigRepository: {},
  dataLakeRepository: { touchIfStable },
  dataLakeAccessGrantRepository: {},
  fabFileRepository: {},
  lakeConfigChangeEventRepository: {},
  lakeConfigSnapshotRepository: {},
  lakeConfigUndoClaimRepository: {},
  lakeMembershipChangeEventRepository: {},
  lakeMembershipRemovalRepository: {},
  scopedSettingsRepository: {},
}));

import { undoLakeConfigChangeHandler } from './undoHandler';

const req = { logger: {} } as unknown as Request;
const ctx = {} as AccessContext;

describe('undoLakeConfigChangeHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('checks the manage gate for the lake, then runs the undo', async () => {
    assertLakeResearchManage.mockResolvedValue({ lake: { id: 'lake-1' }, actor: {}, grants: [] });
    undoLakeConfigChange.mockResolvedValue({ entry: null, notes: [] });

    await undoLakeConfigChangeHandler(req, 'lake-1', 'evt-1', ctx);

    expect(assertLakeResearchManage).toHaveBeenCalledWith(req, 'lake-1', ctx);
    expect(undoLakeConfigChange).toHaveBeenCalledWith('evt-1', { id: 'lake-1' }, expect.anything());
    expect(touchIfStable).toHaveBeenCalledWith('lake-1');
  });

  it('stops before the service when the manage gate rejects', async () => {
    assertLakeResearchManage.mockRejectedValue(new Error('forbidden'));

    await expect(undoLakeConfigChangeHandler(req, 'lake-1', 'evt-1', ctx)).rejects.toThrow('forbidden');
    expect(undoLakeConfigChange).not.toHaveBeenCalled();
    expect(touchIfStable).not.toHaveBeenCalled();
  });
});
