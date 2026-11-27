import { beforeEach, describe, expect, it, vi } from 'vitest';

const quest = vi.hoisted(() => ({
  collection: { createIndex: vi.fn() },
  schema: { indexes: vi.fn() },
}));
vi.mock('@bike4mind/database', () => ({ Quest: quest }));

import migration from './20261120072518_ensure-quest-session-pending-action-index';

const pendingSpec = [
  { sessionId: 1, 'pendingAction.ts': -1 },
  { name: 'sessionId_pendingActionTs', partialFilterExpression: { 'pendingAction.ts': { $exists: true } } },
];

describe('ensure quest pending action index migration', () => {
  beforeEach(() => vi.resetAllMocks());

  it('builds only the sessionId_pendingActionTs index, with the schema options', async () => {
    quest.schema.indexes.mockReturnValue([[{ sessionId: 1 }, { name: 'other' }], [{ status: 1 }], pendingSpec]);

    await migration.up();

    expect(quest.collection.createIndex).toHaveBeenCalledExactlyOnceWith(...pendingSpec);
  });

  it('fails loudly when the schema no longer declares the index', async () => {
    quest.schema.indexes.mockReturnValue([[{ sessionId: 1 }, { name: 'other' }]]);

    await expect(migration.up()).rejects.toThrow(/no sessionId_pendingActionTs index/);
    expect(quest.collection.createIndex).not.toHaveBeenCalled();
  });

  it('down is a no-op', async () => {
    await expect(migration.down()).resolves.toBeUndefined();
  });
});
