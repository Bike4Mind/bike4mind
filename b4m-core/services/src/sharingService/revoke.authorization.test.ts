import { describe, it, expect, beforeEach, vi } from 'vitest';
import { revoke } from './revoke';

/**
 * The session cascade writes to fabFile documents but is authorized against the SESSION, and
 * session.knowledgeIds is client-writable with only shape validation. The defence is provenance:
 * every row the cascade may touch carries this session's id, written by accept.ts's propagation,
 * which already required the inviter to hold share on the file. Pointing your own session at a
 * stranger's file therefore reaches nothing, because no row on it carries your session id.
 *
 * That replaced a per-file "can the session owner share this" check, which asked about the wrong
 * principal - the mint reads the inviter, who need not be the session owner - and so stranded
 * grants un-revokable through the path that created them.
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
        sessions: {
          shareable: { findAccessibleById: vi.fn(async () => session) },
          update: vi.fn(),
          updateGuarded: vi.fn(),
        },
        fabFiles: { findAllByIds: vi.fn(async () => files), update: vi.fn(), updateGuarded: vi.fn() },
        projects: { shareable: { findAccessibleById: vi.fn() }, update: vi.fn(), updateGuarded: vi.fn() },
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

  // Attaching a stranger's file to your own session is the attack the old owner check existed for.
  // The rows on it are not this session's, so there is nothing here to match.
  it('does not touch an untagged row on a file attached from elsewhere', async () => {
    const foreignFile = {
      id: 'file-foreign',
      userId: strangerId,
      users: [{ userId: targetId, permissions: ['read'] }],
    };
    setup([foreignFile]);

    await revoke(sessionOwnerId, { id: sessionId, type: 'sessions', userId: targetId }, adapters);

    expect(adapters.db.fabFiles.updateGuarded).not.toHaveBeenCalled();
    expect(foreignFile.users).toEqual([{ userId: targetId, permissions: ['read'] }]);
  });

  // Ownership is not the question any more. A grant this session minted on a file the session owner
  // merely holds share on was un-revokable while the gate read the owner's present authority.
  it('revokes a row tagged with this session even on a file the owner does not own', async () => {
    const foreignFile = {
      id: 'file-foreign',
      userId: strangerId,
      users: [{ userId: targetId, permissions: ['read'], sessionId }],
    };
    setup([foreignFile]);

    await revoke(sessionOwnerId, { id: sessionId, type: 'sessions', userId: targetId }, adapters);

    expect(adapters.db.fabFiles.updateGuarded).toHaveBeenCalledTimes(1);
    expect(foreignFile.users).toEqual([]);
  });

  it('leaves a projectId-tagged grant alone even on an owned file', async () => {
    const ownedFile = {
      id: 'file-owned',
      userId: sessionOwnerId,
      users: [{ userId: targetId, permissions: ['read'], projectId: 'project-9' }],
    };
    setup([ownedFile]);

    await revoke(sessionOwnerId, { id: sessionId, type: 'sessions', userId: targetId }, adapters);

    expect(adapters.db.fabFiles.updateGuarded).not.toHaveBeenCalled();
    expect(ownedFile.users).toHaveLength(1);
  });

  // Two sessions can each propagate the same file to the same person. Each grant is its own row and
  // revoking one session must not take the other's with it.
  it('leaves a row tagged with a different session alone', async () => {
    const ownedFile = {
      id: 'file-owned',
      userId: sessionOwnerId,
      users: [{ userId: targetId, permissions: ['read'], sessionId: 'session-2' }],
    };
    setup([ownedFile]);

    await revoke(sessionOwnerId, { id: sessionId, type: 'sessions', userId: targetId }, adapters);

    expect(adapters.db.fabFiles.updateGuarded).not.toHaveBeenCalled();
    expect(ownedFile.users).toHaveLength(1);
  });
});
