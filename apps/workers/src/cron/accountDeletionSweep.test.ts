import { beforeEach, describe, expect, it, vi } from 'vitest';

type FakeUser = { id: string; deletionRequestedAt: Date | null };

// An in-memory users collection: the sweep's scan and purgeExpiredAccount's re-check both read it, and
// the hard delete removes from it, so a second run sees what a real one would.
const store = vi.hoisted(() => new Map<string, FakeUser>());
const mocks = vi.hoisted(() => ({ hardDeleteUser: vi.fn(), deleteOrganizationCascade: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
  realtimeConnectionRepository: {},
  organizationRepository: { find: vi.fn().mockResolvedValue([]) },
  userRepository: {
    findById: async (id: string) => store.get(id) ?? null,
    findDeletionDueUserIds: async (cutoff: Date, limit: number) =>
      [...store.values()]
        .filter(user => user.deletionRequestedAt && user.deletionRequestedAt <= cutoff)
        .sort((a, b) => a.deletionRequestedAt!.getTime() - b.deletionRequestedAt!.getTime())
        .slice(0, limit)
        .map(user => user.id),
  },
}));
vi.mock('@bike4mind/services', () => ({ userService: { deleteUserAccount: vi.fn() } }));
vi.mock('@server/services/hardDeleteUser', () => ({ hardDeleteUser: mocks.hardDeleteUser }));
vi.mock('@server/organizations/deleteOrganizationCascade', () => ({
  deleteOrganizationCascade: mocks.deleteOrganizationCascade,
}));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://host/%STAGE%' } }));

import { runAccountDeletionSweep } from './accountDeletionSweep';

const NOW = new Date('2026-03-31T00:00:00.000Z');
const PAST_GRACE = '665f1c2e8b3a4d0000000001';
const EXACTLY_DUE = '665f1c2e8b3a4d0000000002';
const IN_GRACE = '665f1c2e8b3a4d0000000003';
const NOT_PENDING = '665f1c2e8b3a4d0000000004';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() };
const sweep = () => runAccountDeletionSweep({ logger: logger as never, now: NOW });

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  for (const user of [
    { id: PAST_GRACE, deletionRequestedAt: new Date('2026-02-01T00:00:00.000Z') },
    { id: EXACTLY_DUE, deletionRequestedAt: new Date('2026-03-01T00:00:00.000Z') },
    { id: IN_GRACE, deletionRequestedAt: new Date('2026-03-01T00:00:00.001Z') },
    { id: NOT_PENDING, deletionRequestedAt: null },
  ]) {
    store.set(user.id, user);
  }
  mocks.hardDeleteUser.mockImplementation(async (id: string) => {
    store.delete(id);
  });
});

describe('runAccountDeletionSweep', () => {
  it('deletes only the accounts whose 30-day grace period has passed', async () => {
    const result = await sweep();

    expect(result).toMatchObject({ deleted: 2, not_due: 0, org_has_members: 0, failed: 0 });
    expect(mocks.hardDeleteUser.mock.calls.map(([id]) => id)).toEqual([PAST_GRACE, EXACTLY_DUE]);
    expect([...store.keys()].sort()).toEqual([IN_GRACE, NOT_PENDING]);
  });

  it('is idempotent: a second run deletes nothing more', async () => {
    await sweep();
    mocks.hardDeleteUser.mockClear();

    const second = await sweep();

    expect(second).toMatchObject({ deleted: 0, failed: 0 });
    expect(mocks.hardDeleteUser).not.toHaveBeenCalled();
  });

  it('keeps going past a failed account and reports it', async () => {
    mocks.hardDeleteUser.mockImplementation(async (id: string) => {
      if (id === PAST_GRACE) throw new Error('db down');
      store.delete(id);
    });

    const result = await sweep();

    expect(result).toMatchObject({ deleted: 1, failed: 1 });
    expect(store.has(PAST_GRACE)).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(PAST_GRACE), expect.any(Error));
  });

  it('rejects a nonsensical batch size', async () => {
    await expect(runAccountDeletionSweep({ batchSize: 0 })).rejects.toThrow('Invalid account deletion batch size');
  });
});
