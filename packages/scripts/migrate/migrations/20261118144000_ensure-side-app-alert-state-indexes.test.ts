import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createIndex: vi.fn(),
  indexes: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  SideAppAlertState: { collection: { createIndex: mocks.createIndex }, schema: { indexes: mocks.indexes } },
}));
import migration from './20261118144000_ensure-side-app-alert-state-indexes';

describe('side app alert state indexes migration', () => {
  beforeEach(() => vi.resetAllMocks());

  it('creates each declared index on that collection only', async () => {
    const open: [Record<string, unknown>, Record<string, unknown>] = [
      { scope: 1, rule: 1 },
      { unique: true, partialFilterExpression: { open: true } },
    ];
    const ttl: [Record<string, unknown>, Record<string, unknown>] = [
      { resolvedAt: 1 },
      { expireAfterSeconds: 7776000 },
    ];
    mocks.indexes.mockReturnValue([open, ttl]);
    await migration.up();
    expect(mocks.createIndex.mock.calls).toEqual([open, ttl]);
  });

  it('fails loudly when the schema declares nothing', async () => {
    mocks.indexes.mockReturnValue([]);
    await expect(migration.up()).rejects.toThrow(/declares no indexes/);
  });

  it('does nothing on down', async () => {
    await migration.down();
    expect(mocks.createIndex).not.toHaveBeenCalled();
  });
});
