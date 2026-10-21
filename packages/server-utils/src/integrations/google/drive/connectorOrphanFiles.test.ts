import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  deleteFabFile: vi.fn(),
  userIncrement: vi.fn(async () => {}),
  orgIncrement: vi.fn(async () => {}),
}));

vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  fabFileChunkRepository: {},
  fabFileRepository: {},
  sessionRepository: {},
  userRepository: { incrementCurrentStorage: h.userIncrement },
  organizationRepository: { incrementCurrentStorage: h.orgIncrement },
}));
// Partial: the refund path (groupStorageDeltaByOwner + bestEffortAdjustOwnerStorage) stays real.
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<{
    dataLakeService: Record<string, unknown>;
    fabFilesService: Record<string, unknown>;
  }>();
  return { ...actual, fabFilesService: { ...actual.fabFilesService, deleteFabFile: h.deleteFabFile } };
});
vi.mock('@bike4mind/fab-pipeline', () => ({ FabFileChunkSearchIndex: {} }));
vi.mock('@bike4mind/db-core', () => ({ selfHostOpenSearchEnabled: () => false }));
vi.mock('../../../utils/storage/index', () => ({ getFilesStorage: () => ({}) }));
vi.mock('./connectorCopyGate', () => ({
  evaluateConnectorCopyDeletion: vi.fn(),
}));

import type { IFabFileDocument } from '@bike4mind/common';
import { deleteDriveOrphans } from './connectorOrphanFiles';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const orphan = (id: string) => ({ id }) as IFabFileDocument;

type DeleteComplete = (fabFile: { id: string; organizationId?: string }, sizeToDeduct: number) => Promise<void>;

describe('deleteDriveOrphans - storage refund', () => {
  beforeEach(() => vi.clearAllMocks());

  it("refunds an org-stamped orphan to the org counter and a personal one to its owner's", async () => {
    const rows: Record<string, { organizationId?: string; size: number }> = {
      orgRow: { organizationId: 'org-1', size: 30 },
      personalRow: { size: 7 },
    };
    h.deleteFabFile.mockImplementation(
      async (_ownerId: string, { id }: { id: string }, deps: { onDeleteComplete: DeleteComplete }) => {
        await deps.onDeleteComplete({ id, organizationId: rows[id].organizationId }, rows[id].size);
        return { action: 'deleted' };
      }
    );

    await deleteDriveOrphans(
      [
        { orphan: orphan('orgRow'), ownerId: 'user-1' },
        { orphan: orphan('personalRow'), ownerId: 'user-1' },
      ],
      logger
    );

    expect(h.orgIncrement).toHaveBeenCalledTimes(1);
    expect(h.orgIncrement).toHaveBeenCalledWith('org-1', -30);
    expect(h.userIncrement).toHaveBeenCalledTimes(1);
    expect(h.userIncrement).toHaveBeenCalledWith('user-1', -7);
  });
});
