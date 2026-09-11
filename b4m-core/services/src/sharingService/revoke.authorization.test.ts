import { describe, it, expect, beforeEach, vi } from 'vitest';
import { revoke } from './revoke';

/**
 * The session cascade writes to fabFile documents but is authorized against the SESSION, and
 * session.knowledgeIds is client-writable with only shape validation. Without a per-file owner
 * check, anyone could point their own session at a stranger's file and strip a third party's
 * grant on it.
 */
describe('sharingService - revoke (session knowledge-file cascade authority)', () => {
  const sessionOwnerId = 'session-owner';
  const strangerId = 'stranger';
  const targetId = 'target-user';
  const sessionId = 'session-1';

  let adapters: any;

  const setup = (files: unknown[]) => {
    const session = {
      id: sessionId,
      userId: sessionOwnerId,
      knowledgeIds: (files as { id: string }[]).map(f => f.id),
      users: [{ userId: targetId, permissions: ['read'] }],
    };
    adapters = {
      db: {
        sessions: { shareable: { findAccessibleById: vi.fn(async () => session) }, update: vi.fn() },
        fabFiles: { findAllByIds: vi.fn(async () => files), update: vi.fn() },
        projects: { shareable: { findAccessibleById: vi.fn() }, update: vi.fn() },
        // Id-aware: revoke resolves both the revokee and the session owner, and the cascade
        // reads the owner's groups to decide whether they could share the file.
        users: {
          findById: vi.fn(async (id: string) =>
            id === sessionOwnerId ? { id: sessionOwnerId, groups: [] } : { id: targetId, groups: [] }
          ),
        },
      },
    };
    return session;
  };

  beforeEach(() => vi.clearAllMocks());

  it('does not touch a file the session owner does not own', async () => {
    const foreignFile = {
      id: 'file-foreign',
      userId: strangerId,
      users: [{ userId: targetId, permissions: ['read'] }],
    };
    setup([foreignFile]);

    await revoke(sessionOwnerId, { id: sessionId, type: 'sessions', userId: targetId }, adapters);

    expect(adapters.db.fabFiles.update).not.toHaveBeenCalled();
    expect(foreignFile.users).toEqual([{ userId: targetId, permissions: ['read'] }]);
  });

  it('still revokes on a file the session owner does own', async () => {
    const ownedFile = {
      id: 'file-owned',
      userId: sessionOwnerId,
      users: [{ userId: targetId, permissions: ['read'] }],
    };
    setup([ownedFile]);

    await revoke(sessionOwnerId, { id: sessionId, type: 'sessions', userId: targetId }, adapters);

    expect(adapters.db.fabFiles.update).toHaveBeenCalledTimes(1);
    expect(ownedFile.users).toEqual([]);
  });

  it('leaves a projectId-tagged grant alone even on an owned file', async () => {
    const ownedFile = {
      id: 'file-owned',
      userId: sessionOwnerId,
      users: [{ userId: targetId, permissions: ['read'], projectId: 'project-9' }],
    };
    setup([ownedFile]);

    await revoke(sessionOwnerId, { id: sessionId, type: 'sessions', userId: targetId }, adapters);

    expect(adapters.db.fabFiles.update).not.toHaveBeenCalled();
    expect(ownedFile.users).toHaveLength(1);
  });
});
