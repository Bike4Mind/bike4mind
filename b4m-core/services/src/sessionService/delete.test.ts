import { describe, it, expect, beforeEach, Mock } from 'vitest';
import { deleteSession } from './delete';
import {
  createMockSessionRepository,
  createMockProjectRepository,
  createMockFabFileRepository,
} from '../__tests__/utils/testUtils';
import { IFabFileRepository, IProjectRepository, ISessionRepository } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';

describe('sessionService - delete', () => {
  const ownerId = 'owner-123';
  const otherUserId = 'other-456';
  const sessionId = 'session-001';

  let mockSessionRepo: ISessionRepository;
  let mockProjectRepo: IProjectRepository;
  let mockFabFileRepo: IFabFileRepository;
  let adapters: {
    db: {
      sessions: ISessionRepository;
      projects: IProjectRepository;
      fabFiles: IFabFileRepository;
    };
  };

  beforeEach(() => {
    mockSessionRepo = createMockSessionRepository();
    mockProjectRepo = createMockProjectRepository();
    mockFabFileRepo = createMockFabFileRepository();
    adapters = {
      db: {
        sessions: mockSessionRepo,
        projects: mockProjectRepo,
        fabFiles: mockFabFileRepo,
      },
    };
  });

  it('throws NotFoundError when the session does not exist for this user', async () => {
    (mockSessionRepo.findByIdAndUserId as Mock).mockResolvedValue(null);

    await expect(deleteSession(ownerId, { id: sessionId }, adapters)).rejects.toThrow(NotFoundError);
    expect(mockFabFileRepo.deleteManyInIds).not.toHaveBeenCalled();
  });

  it('hard-deletes a file the session owner actually owns', async () => {
    const session = { id: sessionId, userId: ownerId, deletedAt: null };
    const ownedFile = { id: 'file-owned', userId: ownerId, users: [] };

    (mockSessionRepo.findByIdAndUserId as Mock).mockResolvedValue(session);
    (mockFabFileRepo.find as Mock).mockResolvedValue([ownedFile]);
    (mockSessionRepo.findRecentlyUpdatedByUserId as Mock).mockResolvedValue(null);

    await deleteSession(ownerId, { id: sessionId }, adapters);

    expect(mockFabFileRepo.deleteManyInIds).toHaveBeenCalledWith(['file-owned']);
    expect(mockFabFileRepo.update).not.toHaveBeenCalled();
  });

  it('does not hard-delete a file attached to the session but owned by someone else', async () => {
    const session = { id: sessionId, userId: ownerId, deletedAt: null };
    const sharedInFile = {
      id: 'file-shared-in',
      userId: otherUserId,
      users: [{ userId: ownerId, permissions: ['read'] }],
    };

    (mockSessionRepo.findByIdAndUserId as Mock).mockResolvedValue(session);
    (mockFabFileRepo.find as Mock).mockResolvedValue([sharedInFile]);
    (mockSessionRepo.findRecentlyUpdatedByUserId as Mock).mockResolvedValue(null);

    await deleteSession(ownerId, { id: sessionId }, adapters);

    // The other user's file must never be hard-deleted...
    expect(mockFabFileRepo.deleteManyInIds).toHaveBeenCalledWith([]);
    // ...only the session owner's derived grant on it is dropped.
    expect(mockFabFileRepo.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'file-shared-in', users: [] }));
  });
});
