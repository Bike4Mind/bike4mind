import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ clearDeletionRequested: vi.fn(), findById: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { clearDeletionRequested: mocks.clearDeletionRequested, findById: mocks.findById },
}));

import { restoreAccountDeletion } from './restoreAccountDeletion';

const USER_ID = '665f1c2e8b3a4d0012345678';

beforeEach(() => vi.clearAllMocks());

describe('restoreAccountDeletion', () => {
  it('clears a pending deletion', async () => {
    mocks.clearDeletionRequested.mockResolvedValue(true);
    await expect(restoreAccountDeletion(USER_ID)).resolves.toEqual({ restored: true });
    expect(mocks.clearDeletionRequested).toHaveBeenCalledWith(USER_ID);
  });

  it('is a no-op for an account that is not pending', async () => {
    mocks.clearDeletionRequested.mockResolvedValue(false);
    mocks.findById.mockResolvedValue({ id: USER_ID });
    await expect(restoreAccountDeletion(USER_ID)).resolves.toEqual({ restored: false });
  });

  it('404s for a missing user', async () => {
    mocks.clearDeletionRequested.mockResolvedValue(false);
    mocks.findById.mockResolvedValue(null);
    await expect(restoreAccountDeletion(USER_ID)).rejects.toThrow('User not found');
  });
});
