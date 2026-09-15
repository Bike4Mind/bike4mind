import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cancelEmailChange, CancelEmailChangeParameters } from './cancelEmailChange';
import { NotFoundError } from '@bike4mind/utils';

const baseParams: CancelEmailChangeParameters = {
  userId: 'userId123',
};

describe('cancelEmailChange', () => {
  let mockAdapters: any;
  let mockUser: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = {
      id: baseParams.userId,
      email: 'current@example.com',
      username: 'testuser',
      pendingEmail: 'pending@example.com',
      pendingEmailToken: 'token-123',
      pendingEmailSentAt: new Date(Date.now() - 60000),
      pendingEmailExpires: new Date(Date.now() + 60000),
    };
    mockAdapters = {
      db: {
        users: {
          findById: vi.fn().mockResolvedValue(mockUser),
          update: vi.fn().mockResolvedValue(undefined),
        },
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should cancel email change by clearing pending fields', async () => {
    await cancelEmailChange(baseParams, mockAdapters);

    expect(mockAdapters.db.users.findById).toHaveBeenCalledWith(baseParams.userId);
    expect(mockAdapters.db.users.update).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingEmail: null,
        pendingEmailToken: null,
        pendingEmailSentAt: null,
        pendingEmailExpires: null,
      })
    );
  });

  it('should throw NotFoundError if user is not found', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(null);
    await expect(cancelEmailChange(baseParams, mockAdapters)).rejects.toThrow(NotFoundError);
    await expect(cancelEmailChange(baseParams, mockAdapters)).rejects.toThrow('User not found');
  });

  it('should work even if user has no pending email change', async () => {
    mockUser.pendingEmail = null;
    mockUser.pendingEmailToken = null;
    mockUser.pendingEmailSentAt = null;
    mockUser.pendingEmailExpires = null;

    await expect(cancelEmailChange(baseParams, mockAdapters)).resolves.not.toThrow();
    expect(mockAdapters.db.users.update).toHaveBeenCalled();
  });

  it('should clear all pending email fields', async () => {
    await cancelEmailChange(baseParams, mockAdapters);

    const updatedUser = mockAdapters.db.users.update.mock.calls[0][0];
    expect(updatedUser.pendingEmail).toBeNull();
    expect(updatedUser.pendingEmailToken).toBeNull();
    expect(updatedUser.pendingEmailSentAt).toBeNull();
    expect(updatedUser.pendingEmailExpires).toBeNull();
  });

  it('should not modify current email address', async () => {
    const originalEmail = mockUser.email;
    await cancelEmailChange(baseParams, mockAdapters);

    const updatedUser = mockAdapters.db.users.update.mock.calls[0][0];
    expect(updatedUser.email).toBe(originalEmail);
  });
});
