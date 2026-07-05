import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { UnauthorizedError, NotFoundError } from '@bike4mind/utils';
import { revoke } from './revoke';

describe('sharingService - revoke', () => {
  const ownerId = 'owner-123';
  const sharedUserId = 'shared-456';
  const attackerId = 'attacker-789';
  const documentId = 'doc-001';

  let mockAdapters: {
    db: {
      sessions: { shareable: { findAccessibleById: Mock }; update: Mock };
      fabFiles: { shareable: { findAccessibleById: Mock }; update: Mock };
      projects: { shareable: { findAccessibleById: Mock }; update: Mock };
      users: { findById: Mock };
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapters = {
      db: {
        sessions: { shareable: { findAccessibleById: vi.fn() }, update: vi.fn() },
        fabFiles: { shareable: { findAccessibleById: vi.fn() }, update: vi.fn() },
        projects: { shareable: { findAccessibleById: vi.fn() }, update: vi.fn() },
        users: { findById: vi.fn() },
      },
    };
  });

  it('should allow the document owner to revoke another user', async () => {
    const document = {
      id: documentId,
      userId: ownerId,
      users: [{ userId: sharedUserId, permissions: ['read'] }],
    };
    mockAdapters.db.users.findById.mockResolvedValue({ id: sharedUserId });
    mockAdapters.db.fabFiles.shareable.findAccessibleById.mockResolvedValue(document);

    await revoke(ownerId, { id: documentId, type: 'files', userId: sharedUserId }, mockAdapters as any);

    expect(mockAdapters.db.fabFiles.update).toHaveBeenCalledWith(expect.objectContaining({ users: [] }));
  });

  it('should allow a user to revoke their own sharing (self-removal)', async () => {
    const document = {
      id: documentId,
      userId: ownerId,
      users: [{ userId: sharedUserId, permissions: ['read'] }],
    };
    mockAdapters.db.users.findById.mockResolvedValue({ id: sharedUserId });
    mockAdapters.db.fabFiles.shareable.findAccessibleById.mockResolvedValue(document);

    await revoke(sharedUserId, { id: documentId, type: 'files', userId: sharedUserId }, mockAdapters as any);

    expect(mockAdapters.db.fabFiles.update).toHaveBeenCalledWith(expect.objectContaining({ users: [] }));
  });

  it('should reject when caller is neither owner nor the user being revoked', async () => {
    const document = {
      id: documentId,
      userId: ownerId,
      users: [{ userId: sharedUserId, permissions: ['read'] }],
    };
    mockAdapters.db.users.findById.mockResolvedValue({ id: sharedUserId });
    mockAdapters.db.fabFiles.shareable.findAccessibleById.mockResolvedValue(document);

    await expect(
      revoke(attackerId, { id: documentId, type: 'files', userId: sharedUserId }, mockAdapters as any)
    ).rejects.toThrow(UnauthorizedError);

    expect(mockAdapters.db.fabFiles.update).not.toHaveBeenCalled();
  });

  it('should throw NotFoundError when user to revoke is not found', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(null);

    await expect(
      revoke(ownerId, { id: documentId, type: 'files', userId: sharedUserId }, mockAdapters as any)
    ).rejects.toThrow(NotFoundError);
  });
});
