import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { UnauthorizedError, NotFoundError } from '@bike4mind/utils';
import { Permission } from '@bike4mind/common';
import { revoke } from './revoke';
import { pushShareable } from './accept';

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

/**
 * The project-scoped arm must strip only the target user's project-derived grant. It used to
 * drop every entry carrying that projectId, so revoking one member (or a member leaving)
 * deleted every other member's access to the same file.
 */
describe('sharingService - revoke (project-scoped grants)', () => {
  const ownerId = 'owner-123';
  const leavingId = 'leaving-456';
  const coMemberId = 'co-member-789';
  const fileId = 'file-001';
  const projectId = 'project-001';

  let mockAdapters: any;

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

  it('removes only the target member, leaving co-members on the same project', async () => {
    const document = {
      id: fileId,
      userId: ownerId,
      users: [
        { userId: leavingId, permissions: ['read'], projectId },
        { userId: coMemberId, permissions: ['read'], projectId },
      ],
    };
    mockAdapters.db.users.findById.mockResolvedValue({ id: leavingId });
    mockAdapters.db.fabFiles.shareable.findAccessibleById.mockResolvedValue(document);

    await revoke(leavingId, { id: fileId, type: 'files', userId: leavingId, projectId }, mockAdapters);

    expect(mockAdapters.db.fabFiles.update).toHaveBeenCalledWith(
      expect.objectContaining({ users: [{ userId: coMemberId, permissions: ['read'], projectId }] })
    );
  });

  it('leaves the target own direct share intact when revoking the project-derived one', async () => {
    const document = {
      id: fileId,
      userId: ownerId,
      users: [
        { userId: leavingId, permissions: ['read'], projectId },
        { userId: leavingId, permissions: ['read', 'update'] },
      ],
    };
    mockAdapters.db.users.findById.mockResolvedValue({ id: leavingId });
    mockAdapters.db.fabFiles.shareable.findAccessibleById.mockResolvedValue(document);

    await revoke(ownerId, { id: fileId, type: 'files', userId: leavingId, projectId }, mockAdapters);

    expect(mockAdapters.db.fabFiles.update).toHaveBeenCalledWith(
      expect.objectContaining({ users: [{ userId: leavingId, permissions: ['read', 'update'] }] })
    );
  });

  it('does not touch a grant another project materialized for the same user', async () => {
    const document = {
      id: fileId,
      userId: ownerId,
      users: [
        { userId: leavingId, permissions: ['read'], projectId },
        { userId: leavingId, permissions: ['read'], projectId: 'project-other' },
      ],
    };
    mockAdapters.db.users.findById.mockResolvedValue({ id: leavingId });
    mockAdapters.db.fabFiles.shareable.findAccessibleById.mockResolvedValue(document);

    await revoke(ownerId, { id: fileId, type: 'files', userId: leavingId, projectId }, mockAdapters);

    expect(mockAdapters.db.fabFiles.update).toHaveBeenCalledWith(
      expect.objectContaining({ users: [{ userId: leavingId, permissions: ['read'], projectId: 'project-other' }] })
    );
  });
});

/**
 * accept.ts's Session arm pushes a plain (non-project) grant onto every file in
 * session.knowledgeIds when the invite is accepted. Revoking the session share must mirror
 * that and strip the same file grants, without touching a grant a different project materialized.
 */
describe('sharingService - revoke (session knowledgeIds cascade)', () => {
  const ownerId = 'owner-123';
  const sharedUserId = 'shared-456';
  const sessionId = 'session-001';
  const plainFileId = 'file-plain';
  const projectFileId = 'file-project';

  let mockAdapters: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapters = {
      db: {
        sessions: { shareable: { findAccessibleById: vi.fn() }, update: vi.fn() },
        fabFiles: { shareable: { findAccessibleById: vi.fn() }, update: vi.fn(), findAllByIds: vi.fn() },
        projects: { shareable: { findAccessibleById: vi.fn() }, update: vi.fn() },
        users: { findById: vi.fn() },
      },
    };
  });

  it('strips the session-materialized grant from the sessions knowledgeIds files', async () => {
    const session = {
      id: sessionId,
      userId: ownerId,
      knowledgeIds: [plainFileId, projectFileId],
      users: [{ userId: sharedUserId, permissions: ['read'] }],
    };
    const plainFile = {
      id: plainFileId,
      userId: ownerId,
      users: [{ userId: sharedUserId, permissions: ['read'] }],
    };
    const projectScopedFile = {
      id: projectFileId,
      userId: ownerId,
      users: [{ userId: sharedUserId, permissions: ['read'], projectId: 'some-other-project' }],
    };

    mockAdapters.db.users.findById.mockResolvedValue({ id: sharedUserId });
    mockAdapters.db.sessions.shareable.findAccessibleById.mockResolvedValue(session);
    mockAdapters.db.fabFiles.findAllByIds.mockResolvedValue([plainFile, projectScopedFile]);

    await revoke(ownerId, { id: sessionId, type: 'sessions', userId: sharedUserId }, mockAdapters);

    expect(mockAdapters.db.sessions.update).toHaveBeenCalledWith(expect.objectContaining({ users: [] }));
    // The plain grant materialized by session acceptance is stripped.
    expect(mockAdapters.db.fabFiles.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: plainFileId, users: [] })
    );
    // A grant tied to a different project is left untouched, and the file is never even written.
    expect(mockAdapters.db.fabFiles.update).not.toHaveBeenCalledWith(expect.objectContaining({ id: projectFileId }));
  });
});

/**
 * pushShareable keys users[] entries on (userId, projectId), so a file reached through two
 * projects carries one entry per project and revoke's projectId-keyed filter lines up with them.
 * These cover the cross-project case that previously collapsed to a single last-write-wins entry.
 */
describe('sharingService - revoke (cross-project grants)', () => {
  const ownerId = 'owner-123';
  const sharedUserId = 'shared-456';
  const fileId = 'file-001';
  const projectAId = 'project-A';
  const projectBId = 'project-B';

  let mockAdapters: any;

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

  const materializeTwoProjectGrants = () => {
    const file = {
      id: fileId,
      userId: ownerId,
      users: [] as { userId: string; permissions: Permission[]; projectId?: string }[],
    };
    // Mirrors acceptProject's per-project pushShareable call for this file, in the order
    // project A then project B were accepted.
    pushShareable(file, { userId: sharedUserId, permissions: [Permission.read], projectId: projectAId });
    pushShareable(file, { userId: sharedUserId, permissions: [Permission.read], projectId: projectBId });
    return file;
  };

  it('records one entry per project rather than collapsing them onto the last one', () => {
    expect(materializeTwoProjectGrants().users).toEqual([
      { userId: sharedUserId, permissions: [Permission.read], projectId: projectAId },
      { userId: sharedUserId, permissions: [Permission.read], projectId: projectBId },
    ]);
  });

  it('keeps a direct share separate from a project-derived one', () => {
    const file = { id: fileId, userId: ownerId, users: [] as any[] };
    pushShareable(file, { userId: sharedUserId, permissions: [Permission.read], projectId: projectAId });
    pushShareable(file, { userId: sharedUserId, permissions: [Permission.read] });
    expect(file.users).toEqual([
      { userId: sharedUserId, permissions: [Permission.read], projectId: projectAId },
      { userId: sharedUserId, permissions: [Permission.read], projectId: undefined },
    ]);
  });

  it('still merges permissions into the existing entry when the same project grants again', () => {
    const file = { id: fileId, userId: ownerId, users: [] as any[] };
    pushShareable(file, { userId: sharedUserId, permissions: [Permission.read], projectId: projectAId });
    pushShareable(file, { userId: sharedUserId, permissions: [Permission.update], projectId: projectAId });
    expect(file.users).toEqual([
      { userId: sharedUserId, permissions: [Permission.read, Permission.update], projectId: projectAId },
    ]);
  });

  it('revoking project A drops only A, leaving project B access live', async () => {
    const file = materializeTwoProjectGrants();
    mockAdapters.db.users.findById.mockResolvedValue({ id: sharedUserId });
    mockAdapters.db.fabFiles.shareable.findAccessibleById.mockResolvedValue(file);

    await revoke(ownerId, { id: fileId, type: 'files', userId: sharedUserId, projectId: projectAId }, mockAdapters);

    expect(mockAdapters.db.fabFiles.update).toHaveBeenCalledWith(
      expect.objectContaining({
        users: [{ userId: sharedUserId, permissions: [Permission.read], projectId: projectBId }],
      })
    );
  });

  it('revoking project B drops only B, leaving project A access live', async () => {
    const file = materializeTwoProjectGrants();
    mockAdapters.db.users.findById.mockResolvedValue({ id: sharedUserId });
    mockAdapters.db.fabFiles.shareable.findAccessibleById.mockResolvedValue(file);

    await revoke(ownerId, { id: fileId, type: 'files', userId: sharedUserId, projectId: projectBId }, mockAdapters);

    expect(mockAdapters.db.fabFiles.update).toHaveBeenCalledWith(
      expect.objectContaining({
        users: [{ userId: sharedUserId, permissions: [Permission.read], projectId: projectAId }],
      })
    );
  });

  it('revoking without a project scope clears every entry the user holds', async () => {
    const file = materializeTwoProjectGrants();
    mockAdapters.db.users.findById.mockResolvedValue({ id: sharedUserId });
    mockAdapters.db.fabFiles.shareable.findAccessibleById.mockResolvedValue(file);

    await revoke(ownerId, { id: fileId, type: 'files', userId: sharedUserId }, mockAdapters);

    expect(mockAdapters.db.fabFiles.update).toHaveBeenCalledWith(expect.objectContaining({ users: [] }));
  });

  it('reports a scoped revoke that matches no grant instead of silently removing nothing', async () => {
    const file = materializeTwoProjectGrants();
    mockAdapters.db.users.findById.mockResolvedValue({ id: sharedUserId });
    mockAdapters.db.fabFiles.shareable.findAccessibleById.mockResolvedValue(file);

    await expect(
      revoke(ownerId, { id: fileId, type: 'files', userId: sharedUserId, projectId: 'project-C' }, mockAdapters)
    ).rejects.toThrow(NotFoundError);
    expect(mockAdapters.db.fabFiles.update).not.toHaveBeenCalled();
  });
});
