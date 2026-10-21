import { describe, it, expect, vi } from 'vitest';

const mockCreateIndexes = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

vi.mock('@bike4mind/database', () => ({
  UserApiKeyAuditLog: { createIndexes: () => mockCreateIndexes() },
}));

import migration from './20260921235944_ensure-userapikeyauditlog-actor-index';

describe('ensure-userapikeyauditlog-actor-index', () => {
  it('builds the schema indexes', async () => {
    await migration.up();
    expect(mockCreateIndexes).toHaveBeenCalledTimes(1);
  });

  it('sorts below the fail-closed OAuth backfill', () => {
    expect(migration.id).toBeLessThan(20260922000001);
  });
});
