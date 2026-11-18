import { beforeEach, describe, expect, it, vi } from 'vitest';

const models = vi.hoisted(() => ({
  creditTransaction: vi.fn(),
  apiKeyUsageLog: vi.fn(),
  quest: vi.fn(),
  agentExecution: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  CreditTransaction: { createIndexes: models.creditTransaction },
  ApiKeyUsageLog: { createIndexes: models.apiKeyUsageLog },
  Quest: { createIndexes: models.quest },
  AgentExecutionModel: { createIndexes: models.agentExecution },
}));
import migration from './20261115120000_ensure-side-app-attribution-indexes';

describe('side app attribution indexes migration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('builds the indexes of all four collections', async () => {
    await migration.up();
    for (const build of Object.values(models)) expect(build).toHaveBeenCalledExactlyOnceWith();
  });

  it('propagates an index build failure so the migration remains retryable', async () => {
    models.quest.mockRejectedValueOnce(new Error('index build failed'));
    await expect(migration.up()).rejects.toThrow('index build failed');
  });

  it('does not drop indexes on rollback', async () => {
    await migration.down();
    for (const build of Object.values(models)) expect(build).not.toHaveBeenCalled();
  });
});
