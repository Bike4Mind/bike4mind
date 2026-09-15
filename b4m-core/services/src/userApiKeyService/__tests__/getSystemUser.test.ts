import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getOrCreateOverwatchSystemUser, _resetSystemUserCache } from '../getSystemUser';
import { OVERWATCH_SYSTEM_USER_EMAIL } from '@bike4mind/common';

function makeAdapters(
  overrides: Partial<{
    findByEmail: ReturnType<typeof vi.fn>;
    findOrCreateByEmail: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
  }> = {}
) {
  const systemDoc = { id: 'sys-1', _id: 'sys-1', email: OVERWATCH_SYSTEM_USER_EMAIL, isSystem: true };
  return {
    db: {
      users: {
        findByEmail: overrides.findByEmail ?? vi.fn().mockResolvedValue(null),
        findOrCreateByEmail: overrides.findOrCreateByEmail ?? vi.fn().mockResolvedValue(systemDoc),
        findById: overrides.findById ?? vi.fn().mockResolvedValue(systemDoc),
      },
    },
    _systemDoc: systemDoc,
  };
}

describe('getOrCreateOverwatchSystemUser', () => {
  beforeEach(() => {
    _resetSystemUserCache();
    vi.clearAllMocks();
  });

  it('calls findOrCreateByEmail on first invocation', async () => {
    const { db, _systemDoc } = makeAdapters();
    const result = await getOrCreateOverwatchSystemUser({ db });
    expect(db.users.findOrCreateByEmail).toHaveBeenCalledWith(
      OVERWATCH_SYSTEM_USER_EMAIL,
      expect.objectContaining({ isSystem: true })
    );
    expect(result).toBe(_systemDoc);
  });

  it('returns cached user on second call (no extra DB round-trip)', async () => {
    const findById = vi.fn().mockResolvedValue({ id: 'sys-1', email: OVERWATCH_SYSTEM_USER_EMAIL });
    const findOrCreate = vi.fn().mockResolvedValue({ id: 'sys-1', email: OVERWATCH_SYSTEM_USER_EMAIL });
    const adapters = makeAdapters({ findOrCreateByEmail: findOrCreate, findById });

    await getOrCreateOverwatchSystemUser(adapters);
    await getOrCreateOverwatchSystemUser(adapters);

    // findOrCreateByEmail called only once; second call uses cached id via findById
    expect(findOrCreate).toHaveBeenCalledTimes(1);
    expect(findById).toHaveBeenCalledTimes(1);
  });

  it('self-heals when cached user is deleted: evicts cache and re-upserts', async () => {
    // First getOrCreate: cache is empty, findOrCreateByEmail returns doc1, cache = 'sys-1'.
    // Second getOrCreate: cache has 'sys-1', findById returns null (user deleted),
    //   so evict cache, findOrCreateByEmail called again, returns doc2.
    const doc1 = { id: 'sys-1', email: OVERWATCH_SYSTEM_USER_EMAIL };
    const doc2 = { id: 'sys-2', email: OVERWATCH_SYSTEM_USER_EMAIL };

    const findById = vi.fn().mockResolvedValue(null); // always null = user was deleted

    const findOrCreate = vi.fn().mockResolvedValueOnce(doc1).mockResolvedValueOnce(doc2);

    const adapters = makeAdapters({ findOrCreateByEmail: findOrCreate, findById });

    await getOrCreateOverwatchSystemUser(adapters); // populates cache with sys-1
    const result = await getOrCreateOverwatchSystemUser(adapters); // findById null, re-upsert

    expect(findOrCreate).toHaveBeenCalledTimes(2);
    expect(result).toBe(doc2);
  });

  it('E11000 fallback: adapter handles duplicate-key race and returns existing doc', async () => {
    // Simulate the findOrCreateByEmail adapter catching E11000 and falling back to findOne
    const existingDoc = { id: 'sys-1', email: OVERWATCH_SYSTEM_USER_EMAIL, isSystem: true };
    // The adapter itself handles E11000; from the service perspective, findOrCreateByEmail always resolves
    const findOrCreate = vi.fn().mockResolvedValue(existingDoc);
    const adapters = makeAdapters({ findOrCreateByEmail: findOrCreate });

    const result = await getOrCreateOverwatchSystemUser(adapters);
    expect(result).toBe(existingDoc);
    expect(result.isSystem).toBe(true);
  });
});
