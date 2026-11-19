import type { Model } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Spec = [Record<string, unknown>, Record<string, unknown> | undefined];

const mocks = vi.hoisted(() => {
  const makeModel = (modelName: string) => ({
    modelName,
    createIndexes: vi.fn(),
    collection: { createIndex: vi.fn() },
    schema: { indexes: vi.fn() },
  });
  return {
    creditTransaction: makeModel('CreditTransaction'),
    apiKeyUsageLog: makeModel('ApiKeyUsageLog'),
    quest: makeModel('Quest'),
    agentExecution: makeModel('AgentExecution'),
  };
});
vi.mock('@bike4mind/database', () => ({
  CreditTransaction: mocks.creditTransaction,
  ApiKeyUsageLog: mocks.apiKeyUsageLog,
  Quest: mocks.quest,
  AgentExecutionModel: mocks.agentExecution,
}));
import migration, { ensureOauthClientIdIndexes } from './20261115120000_ensure-side-app-attribution-indexes';

const models = Object.values(mocks);

const oauthSpec = (name: string): Spec => [
  { oauthClientId: 1, createdAt: -1 },
  { name, partialFilterExpression: { oauthClientId: { $exists: true } }, background: true },
];
const otherSpec: Spec = [{ createdAt: 1 }, { expireAfterSeconds: 7776000 }];

describe('side app attribution indexes migration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    for (const model of models) {
      model.schema.indexes.mockReturnValue([otherSpec, oauthSpec(`${model.modelName}_oauth`), [{ userId: 1 }, {}]]);
    }
  });

  it('requests only the oauthClientId index of each model, with the schema options', async () => {
    await migration.up();
    for (const model of models) {
      expect(model.collection.createIndex).toHaveBeenCalledExactlyOnceWith(
        ...(oauthSpec(`${model.modelName}_oauth`) as [Record<string, unknown>, Record<string, unknown>])
      );
    }
  });

  it('never builds the models other declared indexes', async () => {
    await migration.up();
    for (const model of models) expect(model.createIndexes).not.toHaveBeenCalled();
  });

  it('throws when a model declares no oauthClientId index', async () => {
    mocks.quest.schema.indexes.mockReturnValue([otherSpec]);
    await expect(migration.up()).rejects.toThrow('Quest declares no oauthClientId index');
    await expect(ensureOauthClientIdIndexes(mocks.quest as unknown as Model<unknown>)).rejects.toThrow(
      'no longer matches its schema'
    );
  });

  it('propagates an index build failure so the migration remains retryable', async () => {
    mocks.quest.collection.createIndex.mockRejectedValueOnce(new Error('index build failed'));
    await expect(migration.up()).rejects.toThrow('index build failed');
  });

  it('does not drop indexes on rollback', async () => {
    await migration.down();
    for (const model of models) expect(model.collection.createIndex).not.toHaveBeenCalled();
  });
});
