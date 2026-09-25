import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { deleteSession } from './delete';
import {
  createMockSessionRepository,
  createMockProjectRepository,
  createMockFabFileRepository,
  createMockSessionAgentConfigRepository,
  createMockUserRepository,
} from '../__tests__/utils/testUtils';
import {
  IFabFileRepository,
  IProjectRepository,
  ISessionRepository,
  ISessionAgentConfigRepository,
  IUserRepository,
} from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';

describe('sessionService - delete', () => {
  const ownerId = 'owner-123';
  const otherUserId = 'other-456';
  const sessionId = 'session-001';

  let mockSessionRepo: ISessionRepository;
  let mockProjectRepo: IProjectRepository;
  let mockFabFileRepo: IFabFileRepository;
  let mockSessionAgentConfigRepo: ISessionAgentConfigRepository;
  let mockUserRepo: IUserRepository;
  let adapters: {
    db: {
      sessions: ISessionRepository;
      projects: IProjectRepository;
      fabFiles: IFabFileRepository;
      users: IUserRepository;
      sessionAgentConfigs: ISessionAgentConfigRepository;
    };
  };

  beforeEach(() => {
    mockSessionRepo = createMockSessionRepository();
    mockProjectRepo = createMockProjectRepository();
    mockFabFileRepo = createMockFabFileRepository();
    mockSessionAgentConfigRepo = createMockSessionAgentConfigRepository();
    mockUserRepo = createMockUserRepository();
    // The cascade now also reaches session.knowledgeIds, since a grant this session minted can sit
    // on a file uploaded somewhere else entirely.
    (mockFabFileRepo.findAllByIds as Mock).mockResolvedValue([]);
    adapters = {
      db: {
        sessions: mockSessionRepo,
        projects: mockProjectRepo,
        fabFiles: mockFabFileRepo,
        users: mockUserRepo,
        sessionAgentConfigs: mockSessionAgentConfigRepo,
      },
    };
  });

  it('throws NotFoundError when the session does not exist for this user', async () => {
    (mockSessionRepo.findByIdAndUserId as Mock).mockResolvedValue(null);

    await expect(deleteSession(ownerId, { id: sessionId }, adapters)).rejects.toThrow(NotFoundError);
    expect(mockFabFileRepo.deleteManyInIds).not.toHaveBeenCalled();
  });

  it('deletes a file the session owner actually owns', async () => {
    const session = { id: sessionId, userId: ownerId, deletedAt: null };
    const ownedFile = { id: 'file-owned', userId: ownerId, fileSize: 100, users: [] };

    (mockSessionRepo.findByIdAndUserId as Mock).mockResolvedValue(session);
    (mockFabFileRepo.find as Mock).mockResolvedValue([ownedFile]);
    (mockSessionRepo.findRecentlyUpdatedByUserId as Mock).mockResolvedValue(null);

    await deleteSession(ownerId, { id: sessionId }, adapters);

    expect(mockFabFileRepo.deleteManyInIds).toHaveBeenCalledWith(['file-owned']);
    expect(mockFabFileRepo.updateGuarded).not.toHaveBeenCalled();
  });

  // Otherwise the owner's storage stays counted for files that no longer exist until an admin
  // recalculates it.
  it('debits the owner storage for each owned file deleted', async () => {
    const session = { id: sessionId, userId: ownerId, deletedAt: null };
    const ownedFiles = [
      { id: 'file-owned-1', userId: ownerId, fileSize: 100, users: [] },
      { id: 'file-owned-2', userId: ownerId, fileSize: 50, users: [] },
    ];

    (mockSessionRepo.findByIdAndUserId as Mock).mockResolvedValue(session);
    (mockFabFileRepo.find as Mock).mockResolvedValue(ownedFiles);
    (mockSessionRepo.findRecentlyUpdatedByUserId as Mock).mockResolvedValue(null);

    await deleteSession(ownerId, { id: sessionId }, adapters);

    expect(mockUserRepo.incrementCurrentStorage).toHaveBeenCalledTimes(1);
    expect(mockUserRepo.incrementCurrentStorage).toHaveBeenCalledWith(ownerId, -150);
  });

  it('does not debit storage when the session has no owned files', async () => {
    const session = { id: sessionId, userId: ownerId, deletedAt: null };

    (mockSessionRepo.findByIdAndUserId as Mock).mockResolvedValue(session);
    (mockFabFileRepo.find as Mock).mockResolvedValue([]);
    (mockSessionRepo.findRecentlyUpdatedByUserId as Mock).mockResolvedValue(null);

    await deleteSession(ownerId, { id: sessionId }, adapters);

    expect(mockUserRepo.incrementCurrentStorage).not.toHaveBeenCalled();
  });

  // Best-effort: a quota-accounting hiccup must not fail a delete that already tombstoned the
  // files - the admin recalculate-storage endpoint is the backstop for the drift.
  it('still completes the delete when the storage debit fails', async () => {
    const session = { id: sessionId, userId: ownerId, deletedAt: null };
    const ownedFile = { id: 'file-owned', userId: ownerId, fileSize: 100, users: [] };
    const logger = { warn: vi.fn() };

    (mockSessionRepo.findByIdAndUserId as Mock).mockResolvedValue(session);
    (mockFabFileRepo.find as Mock).mockResolvedValue([ownedFile]);
    (mockSessionRepo.findRecentlyUpdatedByUserId as Mock).mockResolvedValue(null);
    (mockUserRepo.incrementCurrentStorage as Mock).mockRejectedValue(new Error('storage write failed'));

    await expect(deleteSession(ownerId, { id: sessionId }, { ...adapters, logger })).resolves.toBeNull();

    expect(mockFabFileRepo.deleteManyInIds).toHaveBeenCalledWith(['file-owned']);
    expect(mockSessionAgentConfigRepo.deleteBySessionId).toHaveBeenCalledWith(sessionId);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  // Otherwise an enabled row survives its session forever - the worker's own deletedAt guard
  // stops it firing, but the cron's eligibility scan re-checks it on every pass with nothing
  // left to stop clearing it.
  it('deletes the session-agent-configs for a deleted session', async () => {
    const session = { id: sessionId, userId: ownerId, deletedAt: null };

    (mockSessionRepo.findByIdAndUserId as Mock).mockResolvedValue(session);
    (mockFabFileRepo.find as Mock).mockResolvedValue([]);
    (mockSessionRepo.findRecentlyUpdatedByUserId as Mock).mockResolvedValue(null);

    await deleteSession(ownerId, { id: sessionId }, adapters);

    expect(mockSessionAgentConfigRepo.deleteBySessionId).toHaveBeenCalledWith(sessionId);
  });

  // sessionAgentConfigs is optional on the published adapters shape (a patch-released signature,
  // re-exported as @bike4mind/services) so an existing caller built against the pre-cleanup shape
  // keeps compiling and running - the cleanup is just skipped for that caller.
  it('completes without sessionAgentConfigs on the adapters', async () => {
    const session = { id: sessionId, userId: ownerId, deletedAt: null };
    const { sessionAgentConfigs: _omitted, ...dbWithoutConfigs } = adapters.db;

    (mockSessionRepo.findByIdAndUserId as Mock).mockResolvedValue(session);
    (mockFabFileRepo.find as Mock).mockResolvedValue([]);
    (mockSessionRepo.findRecentlyUpdatedByUserId as Mock).mockResolvedValue(null);

    await expect(deleteSession(ownerId, { id: sessionId }, { db: dbWithoutConfigs })).resolves.not.toThrow();

    expect(mockSessionAgentConfigRepo.deleteBySessionId).not.toHaveBeenCalled();
  });

  // A grant row records its source. Deleting a session may drop only the rows tagged with that
  // session; a projectId-tagged row is governed by its project and an untagged row is a direct
  // share nobody here has any say over. Matches sharingService/revoke.ts's cascade.
  it('drops only the rows tagged with this session, whoever holds them', async () => {
    const session = { id: sessionId, userId: ownerId, deletedAt: null };
    const sharedInFile = {
      id: 'file-shared-in',
      userId: otherUserId,
      users: [
        { userId: ownerId, permissions: ['read'], projectId: 'project-a' },
        { userId: ownerId, permissions: ['read'], sessionId },
        { userId: 'third-party', permissions: ['read'], sessionId },
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

  // The destruction the sessionId tag exists to stop. pushShareable merged a direct share and a
  // session-derived grant into one untagged row while they shared a key, so deleting the session
  // took the direct share with it - a grant the file's owner made and the session owner had no
  // authority over. Separate rows now, and only the tagged one goes.
  it('leaves a direct share intact when the same user also holds a session-derived grant', async () => {
    const session = { id: sessionId, userId: ownerId, deletedAt: null };
    const carolsDirectShare = { userId: 'carol', permissions: ['read'] };
    const sharedInFile = {
      id: 'file-shared-in',
      userId: otherUserId,
      users: [carolsDirectShare, { userId: 'carol', permissions: ['read'], sessionId }],
    };

    (mockSessionRepo.findByIdAndUserId as Mock).mockResolvedValue(session);
    (mockFabFileRepo.find as Mock).mockResolvedValue([sharedInFile]);
    (mockSessionRepo.findRecentlyUpdatedByUserId as Mock).mockResolvedValue(null);

    await deleteSession(ownerId, { id: sessionId }, adapters);

    expect(mockFabFileRepo.updateGuarded).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'file-shared-in', users: [carolsDirectShare] })
    );
  });

  // The guarded write can conflict and abort the whole delete, which is not a trade worth making
  // for a document that is deleted three lines later anyway. `deleteManyInIds` is the plugin's
  // tombstone path, not a hard delete, so the skipped rows survive on the tombstone - see the
  // comment at the skip in sessionService/delete.ts for why no read path reaches them.
  it('does not take a guarded grant write on a file it is about to delete', async () => {
    const session = { id: sessionId, userId: ownerId, deletedAt: null };
    const ownedFile = {
      id: 'file-owned',
      userId: ownerId,
      users: [{ userId: 'carol', permissions: ['read'], sessionId }],
    };

    (mockSessionRepo.findByIdAndUserId as Mock).mockResolvedValue(session);
    (mockFabFileRepo.find as Mock).mockResolvedValue([ownedFile]);
    (mockSessionRepo.findRecentlyUpdatedByUserId as Mock).mockResolvedValue(null);

    await deleteSession(ownerId, { id: sessionId }, adapters);

    expect(mockFabFileRepo.updateGuarded).not.toHaveBeenCalled();
    expect(mockFabFileRepo.deleteManyInIds).toHaveBeenCalledWith(['file-owned']);
  });

  // knowledgeIds, not just files uploaded into the session: accept.ts propagates onto whatever the
  // session attaches, which can be a file that lives somewhere else entirely.
  it('reaches a grant it minted on a knowledge file uploaded outside this session', async () => {
    const session = { id: sessionId, userId: ownerId, deletedAt: null, knowledgeIds: ['file-elsewhere'] };
    const knowledgeFile = {
      id: 'file-elsewhere',
      userId: otherUserId,
      users: [{ userId: 'carol', permissions: ['read'], sessionId }],
    };

    (mockSessionRepo.findByIdAndUserId as Mock).mockResolvedValue(session);
    (mockFabFileRepo.find as Mock).mockResolvedValue([]);
    (mockFabFileRepo.findAllByIds as Mock).mockResolvedValue([knowledgeFile]);
    (mockSessionRepo.findRecentlyUpdatedByUserId as Mock).mockResolvedValue(null);

    await deleteSession(ownerId, { id: sessionId }, adapters);

    expect(mockFabFileRepo.updateGuarded).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'file-elsewhere', users: [] })
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
      users: [{ userId: ownerId, permissions: ['read'], sessionId }],
    };

    (mockSessionRepo.findByIdAndUserId as Mock).mockResolvedValue(session);
    (mockFabFileRepo.find as Mock).mockResolvedValue([sharedInFile]);
    (mockFabFileRepo.updateGuarded as Mock).mockRejectedValue(new Error('write failed'));

    await expect(deleteSession(ownerId, { id: sessionId }, adapters)).rejects.toThrow('write failed');

    expect(mockSessionRepo.update).not.toHaveBeenCalled();
    expect(session.deletedAt).toBeNull();
    expect(mockFabFileRepo.deleteManyInIds).not.toHaveBeenCalled();
    expect(mockSessionAgentConfigRepo.deleteBySessionId).not.toHaveBeenCalled();
  });

  it('does not delete a file attached to the session but owned by someone else', async () => {
    const session = { id: sessionId, userId: ownerId, deletedAt: null };
    const sharedInFile = {
      id: 'file-shared-in',
      userId: otherUserId,
      users: [{ userId: ownerId, permissions: ['read'], sessionId }],
    };

    (mockSessionRepo.findByIdAndUserId as Mock).mockResolvedValue(session);
    (mockFabFileRepo.find as Mock).mockResolvedValue([sharedInFile]);
    (mockSessionRepo.findRecentlyUpdatedByUserId as Mock).mockResolvedValue(null);

    await deleteSession(ownerId, { id: sessionId }, adapters);

    // The other user's file must never be deleted...
    expect(mockFabFileRepo.deleteManyInIds).toHaveBeenCalledWith([]);
    // ...only the grant this session minted on it is dropped.
    expect(mockFabFileRepo.updateGuarded).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'file-shared-in', users: [] })
    );
  });
});
