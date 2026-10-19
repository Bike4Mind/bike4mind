import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreateIndexes = vi.fn<() => Promise<string[]>>();

vi.mock('@bike4mind/database', () => ({
  AdminAuditLogModel: { createIndexes: () => mockCreateIndexes() },
}));

import migration from './20260921235940_ensure-adminauditlog-indexes';

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateIndexes.mockResolvedValue([]);
});

describe('ensure-adminauditlog-indexes', () => {
  it('builds the AdminAuditLog indexes once', async () => {
    await migration.up();

    expect(mockCreateIndexes).toHaveBeenCalledTimes(1);
  });

  it('propagates an index build failure', async () => {
    mockCreateIndexes.mockRejectedValue(new Error('index build failed'));

    await expect(migration.up()).rejects.toThrow('index build failed');
  });

  it('has a no-op down', async () => {
    await migration.down();

    expect(mockCreateIndexes).not.toHaveBeenCalled();
  });
});
