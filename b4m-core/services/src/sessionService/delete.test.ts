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
    expect(mockFabFileRepo.updateGuarded).not.toHaveBeenCalled();
  });

  // The grant rows this PR re-keyed are (userId, projectId) pairs. Deleting a session may only
  // drop the untagged row the session itself materialized; a projectId-tagged row is governed by
  // that project and outlives the session, matching sharingService/revoke.ts's cascade.
  it('leaves a projectId-tagged grant alone and drops only the session-derived one', async () => {
    const session = { id: sessionId, userId: ownerId, deletedAt: null };
    const sharedInFile = {
      id: 'file-shared-in',
      userId: otherUserId,
      users: [
        { userId: ownerId, permissions: ['read'], projectId: 'project-a' },
        { userId: ownerId, permissions: ['read'] },
        { userId: 'third-party', permissions: ['read'] },
      ],
    };

    (mockSessionRepo.findByIdAndUserId as Mock).mockResolvedValue(session);
    (mockFabFileRepo.find as Mock).mockResolvedValue([sharedInFile]);
    (mockSessionRepo.findRecentlyUpdatedByUserId as Mock).mockResolvedValue(null);

    await deleteSession(ownerId, { id: sessionId }, adapters);

    expect(mockFabFileRepo.updateGuarded).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'file-shared-in',
        users: [
          { userId: ownerId, permissions: ['read'], projectId: 'project-a' },
          { userId: 'third-party', permissions: ['read'] },
        ],
      })
    );
  });

  // softDeletePlugin puts `deletedAt: null` on every findOne and findByIdAndUserId is a bare
  // findOne, so a session tombstoned before the cascade is unreachable on a retry: the guard at
  // the top throws and any grant the loop had not reached stays live with nothing left to clear
  // it. Nothing here is transactional, so the ordering IS the recovery story.
  it('does not tombstone the session when the grant cascade fails', async () => {
    const session = { id: sessionId, userId: ownerId, deletedAt: null };
    const sharedInFile = {
      id: 'file-shared-in',
      userId: otherUserId,
      users: [{ userId: ownerId, permissions: ['read'] }],
    };

    (mockSessionRepo.findByIdAndUserId as Mock).mockResolvedValue(session);
    (mockFabFileRepo.find as Mock).mockResolvedValue([sharedInFile]);
    (mockFabFileRepo.updateGuarded as Mock).mockRejectedValue(new Error('write failed'));

    await expect(deleteSession(ownerId, { id: sessionId }, adapters)).rejects.toThrow('write failed');

    expect(mockSessionRepo.update).not.toHaveBeenCalled();
    expect(session.deletedAt).toBeNull();
    expect(mockFabFileRepo.deleteManyInIds).not.toHaveBeenCalled();
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
    expect(mockFabFileRepo.updateGuarded).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'file-shared-in', users: [] })
    );
  });
});
