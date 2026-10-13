import { beforeEach, describe, expect, it, vi } from 'vitest';

const { collection, createIndexes, listCollections } = vi.hoisted(() => ({
  collection: { collectionName: 'sessions', indexes: vi.fn(), dropIndex: vi.fn() },
  createIndexes: vi.fn(),
  listCollections: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  Session: { db: { db: { listCollections } }, collection, createIndexes },
}));

import migration, { OPEN_VOICE_HOLD_INDEX_NAME } from './20260921235993_ensure-stale-voice-hold-index';

beforeEach(() => {
  vi.clearAllMocks();
  listCollections.mockReturnValue({ toArray: async () => [{ name: 'sessions' }] });
});

describe('ensure stale voice hold index migration', () => {
  it('drops the superseded voiceSessionStartedAt index, keeps the new one, then builds declared indexes', async () => {
    collection.indexes.mockResolvedValue([
      { name: '_id_', key: { _id: 1 } },
      { name: 'userId_1_voiceSessionStartedAt_1', key: { userId: 1, voiceSessionStartedAt: 1 } },
      { name: 'voiceSessionStartedAt_1', key: { voiceSessionStartedAt: 1 } },
      { name: OPEN_VOICE_HOLD_INDEX_NAME, key: { voiceSessionStartedAt: 1 } },
    ]);

    await migration.up();

    expect(collection.dropIndex).toHaveBeenCalledExactlyOnceWith('voiceSessionStartedAt_1');
    expect(createIndexes).toHaveBeenCalledOnce();
    expect(collection.dropIndex.mock.invocationCallOrder[0]).toBeLessThan(createIndexes.mock.invocationCallOrder[0]);
  });

  it('is a no-op drop when the old index is already gone', async () => {
    collection.indexes.mockResolvedValue([{ name: OPEN_VOICE_HOLD_INDEX_NAME, key: { voiceSessionStartedAt: 1 } }]);

    await migration.up();

    expect(collection.dropIndex).not.toHaveBeenCalled();
    expect(createIndexes).toHaveBeenCalledOnce();
  });

  it('skips the index scan on a fresh database without a sessions collection', async () => {
    listCollections.mockReturnValue({ toArray: async () => [] });

    await migration.up();

    expect(collection.indexes).not.toHaveBeenCalled();
    expect(createIndexes).toHaveBeenCalledOnce();
  });
});
