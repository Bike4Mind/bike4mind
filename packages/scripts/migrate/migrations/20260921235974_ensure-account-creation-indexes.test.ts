import { expect, it, vi } from 'vitest';

const indexes = vi.hoisted(() => ({ user: vi.fn(), key: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  User: { collection: { createIndex: indexes.user } },
  UserApiKey: { collection: { createIndex: indexes.key } },
}));
import migration from './20260921235974_ensure-account-creation-indexes';

it('builds only the two census timestamp indexes', async () => {
  await migration.up();
  expect(indexes.user).toHaveBeenCalledExactlyOnceWith({ createdAt: 1 });
  expect(indexes.key).toHaveBeenCalledExactlyOnceWith({ createdAt: 1 });
});
