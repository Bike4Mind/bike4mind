import { describe, it, expect, vi, beforeEach } from 'vitest';

const callOrder: string[] = [];
const mockListIndexes = vi.fn<() => Promise<Array<{ name: string }>>>();
const mockDropIndex = vi.fn<(name: string) => Promise<unknown>>();
const mockCreateIndexes = vi.fn<() => Promise<string[]>>();

vi.mock('@bike4mind/database', () => ({
  SUPERSEDED_ADMIN_AUDIT_INDEX_NAMES: ['old_a', 'old_b', 'old_c'],
  AdminAuditLogModel: {
    collection: {
      listIndexes: () => ({ toArray: () => mockListIndexes() }),
      dropIndex: (name: string) => mockDropIndex(name),
    },
    createIndexes: () => mockCreateIndexes(),
  },
}));

import migration from './20260921235942_ensure-adminauditlog-read-indexes';

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  mockListIndexes.mockResolvedValue([{ name: '_id_' }]);
  mockDropIndex.mockImplementation(async name => {
    callOrder.push(`drop:${name}`);
  });
  mockCreateIndexes.mockImplementation(async () => {
    callOrder.push('create');
    return [];
  });
});

describe('ensure-adminauditlog-read-indexes', () => {
  it('drops each superseded index that exists, then builds the schema indexes', async () => {
    mockListIndexes.mockResolvedValue([{ name: '_id_' }, { name: 'old_a' }, { name: 'old_c' }, { name: 'keep' }]);

    await migration.up();

    expect(mockDropIndex).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual(['drop:old_a', 'drop:old_c', 'create']);
    expect(mockCreateIndexes).toHaveBeenCalledTimes(1);
  });

  it('skips drops when none exist', async () => {
    await migration.up();

    expect(mockDropIndex).not.toHaveBeenCalled();
    expect(mockCreateIndexes).toHaveBeenCalledTimes(1);
  });

  it('treats a missing collection as nothing to drop', async () => {
    mockListIndexes.mockRejectedValue(Object.assign(new Error('ns does not exist'), { code: 26 }));

    await migration.up();

    expect(mockDropIndex).not.toHaveBeenCalled();
    expect(mockCreateIndexes).toHaveBeenCalledTimes(1);
  });

  it('propagates other listIndexes failures without building', async () => {
    mockListIndexes.mockRejectedValue(Object.assign(new Error('boom'), { code: 13 }));

    await expect(migration.up()).rejects.toThrow('boom');
    expect(mockCreateIndexes).not.toHaveBeenCalled();
  });

  it('propagates a createIndexes failure', async () => {
    mockCreateIndexes.mockRejectedValue(new Error('index build failed'));

    await expect(migration.up()).rejects.toThrow('index build failed');
  });

  it('has a no-op down', async () => {
    await migration.down();

    expect(mockDropIndex).not.toHaveBeenCalled();
    expect(mockCreateIndexes).not.toHaveBeenCalled();
  });
});
