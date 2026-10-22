import { describe, expect, it, vi } from 'vitest';
import { adjustOwnerStorage } from './ownerStorage';

const makeCounters = () => ({
  users: { incrementCurrentStorage: vi.fn().mockResolvedValue(undefined) },
  organizations: { incrementCurrentStorage: vi.fn().mockResolvedValue(undefined) },
});

describe('adjustOwnerStorage', () => {
  it('moves the org counter for an org owner and leaves the uploader alone', async () => {
    const counters = makeCounters();
    await adjustOwnerStorage(counters, { type: 'org', id: 'org-1' }, -42);
    expect(counters.organizations.incrementCurrentStorage).toHaveBeenCalledWith('org-1', -42);
    expect(counters.users.incrementCurrentStorage).not.toHaveBeenCalled();
  });

  it('moves the user counter for a personal owner', async () => {
    const counters = makeCounters();
    await adjustOwnerStorage(counters, { type: 'user', id: 'user-1' }, 42);
    expect(counters.users.incrementCurrentStorage).toHaveBeenCalledWith('user-1', 42);
    expect(counters.organizations.incrementCurrentStorage).not.toHaveBeenCalled();
  });

  it('writes nothing for a zero delta', async () => {
    const counters = makeCounters();
    await adjustOwnerStorage(counters, { type: 'org', id: 'org-1' }, 0);
    expect(counters.organizations.incrementCurrentStorage).not.toHaveBeenCalled();
    expect(counters.users.incrementCurrentStorage).not.toHaveBeenCalled();
  });
});
