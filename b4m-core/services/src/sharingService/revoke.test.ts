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
      sessions: { shareable: { findAccessibleById: Mock }; updateGuarded: Mock };
      fabFiles: { shareable: { findAccessibleById: Mock }; updateGuarded: Mock };
      projects: { shareable: { findAccessibleById: Mock }; updateGuarded: Mock };
      users: { findById: Mock };
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapters = {
      db: {
        sessions: { shareable: { findAccessibleById: vi.fn() }, updateGuarded: vi.fn() },
        fabFiles: { shareable: { findAccessibleById: vi.fn() }, updateGuarded: vi.fn() },
        projects: { shareable: { findAccessibleById: vi.fn() }, updateGuarded: vi.fn() },
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

    expect(mockAdapters.db.fabFiles.updateGuarded).toHaveBeenCalledWith(expect.objectContaining({ users: [] }));
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

    expect(mockAdapters.db.fabFiles.updateGuarded).toHaveBeenCalledWith(expect.objectContaining({ users: [] }));
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

    expect(mockAdapters.db.fabFiles.updateGuarded).not.toHaveBeenCalled();
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
        sessions: { shareable: { findAccessibleById: vi.fn() }, update: vi.fn(), updateGuarded: vi.fn() },
        fabFiles: { shareable: { findAccessibleById: vi.fn() }, update: vi.fn(), updateGuarded: vi.fn() },
        projects: { shareable: { findAccessibleById: vi.fn() }, update: vi.fn(), updateGuarded: vi.fn() },
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

    expect(mockAdapters.db.fabFiles.updateGuarded).toHaveBeenCalledWith(
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

    expect(mockAdapters.db.fabFiles.updateGuarded).toHaveBeenCalledWith(
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

    expect(mockAdapters.db.fabFiles.updateGuarded).toHaveBeenCalledWith(
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
        sessions: { shareable: { findAccessibleById: vi.fn() }, update: vi.fn(), updateGuarded: vi.fn() },
        fabFiles: {
          shareable: { findAccessibleById: vi.fn() },
          update: vi.fn(),
          updateGuarded: vi.fn(),
          findAllByIds: vi.fn(),
        },
        projects: { shareable: { findAccessibleById: vi.fn() }, update: vi.fn(), updateGuarded: vi.fn() },
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
      users: [{ userId: sharedUserId, permissions: ['read'], sessionId }],
    };
    const projectScopedFile = {
      id: projectFileId,
      userId: ownerId,
      users: [{ userId: sharedUserId, permissions: ['read'], projectId: 'some-other-project' }],
    };

    mockAdapters.db.users.findById.mockImplementation(async (id: string) =>
      id === ownerId ? { id: ownerId, groups: [] } : { id: sharedUserId, groups: [] }
    );
    mockAdapters.db.sessions.shareable.findAccessibleById.mockResolvedValue(session);
    mockAdapters.db.fabFiles.findAllByIds.mockResolvedValue([plainFile, projectScopedFile]);

    await revoke(ownerId, { id: sessionId, type: 'sessions', userId: sharedUserId }, mockAdapters);

    expect(mockAdapters.db.sessions.updateGuarded).toHaveBeenCalledWith(expect.objectContaining({ users: [] }));
    // The grant this session materialized is stripped.
    expect(mockAdapters.db.fabFiles.updateGuarded).toHaveBeenCalledWith(
      expect.objectContaining({ id: plainFileId, users: [] })
    );
    // A grant tied to a different project is left untouched, and the file is never even written.
    expect(mockAdapters.db.fabFiles.updateGuarded).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: projectFileId })
    );
  });

  // The destruction the sessionId tag exists to stop, in the shape a reviewer walked it: Alice owns
  // F and shares it directly with Carol; Bob holds share on F and attaches it to his own session,
  // which he also shares with Carol. Bob unsharing his session must not take Alice's grant with it,
  // and note that a direct revokeSharing on F would have refused Bob outright - he owns neither F
  // nor the grant. While the two rows shared a key they merged, and this path deleted both.
  it('leaves a direct share intact when the same user also holds a session-derived grant', async () => {
    const carolId = 'carol';
    const session = {
      id: sessionId,
      userId: ownerId,
      knowledgeIds: [plainFileId],
      users: [{ userId: carolId, permissions: ['read'] }],
    };
    const alicesDirectShare = { userId: carolId, permissions: ['read'] };
    const file = {
      id: plainFileId,
      userId: 'alice',
      users: [alicesDirectShare, { userId: carolId, permissions: ['read'], sessionId }],
    };

    mockAdapters.db.users.findById.mockImplementation(async (id: string) => ({ id, groups: [] }));
    mockAdapters.db.sessions.shareable.findAccessibleById.mockResolvedValue(session);
    mockAdapters.db.fabFiles.findAllByIds.mockResolvedValue([file]);

    await revoke(ownerId, { id: sessionId, type: 'sessions', userId: carolId }, mockAdapters);

    expect(mockAdapters.db.fabFiles.updateGuarded).toHaveBeenCalledWith(
      expect.objectContaining({ id: plainFileId, users: [alicesDirectShare] })
    );
  });

  // accept.ts propagates a grant whenever the INVITER can share the file, which need not be the
  // session owner at all. The tag records that the mint was authorized, so revocation no longer has
  // to re-derive authority from a principal it might have guessed wrong.
  it('revokes on a file the session owner can share but does not own', async () => {
    const foreignFileId = 'file-foreign';
    const session = {
      id: sessionId,
      userId: ownerId,
      knowledgeIds: [foreignFileId],
      users: [{ userId: sharedUserId, permissions: ['read'] }],
    };
    const sharedWithOwner = {
      id: foreignFileId,
      userId: 'someone-else',
      users: [
        { userId: ownerId, permissions: ['read', 'share'] },
        { userId: sharedUserId, permissions: ['read'], sessionId },
      ],
    };

    mockAdapters.db.users.findById.mockImplementation(async (id: string) =>
      id === ownerId ? { id: ownerId, groups: [] } : { id: sharedUserId, groups: [] }
    );
    mockAdapters.db.sessions.shareable.findAccessibleById.mockResolvedValue(session);
    mockAdapters.db.fabFiles.findAllByIds.mockResolvedValue([sharedWithOwner]);

    await revoke(ownerId, { id: sessionId, type: 'sessions', userId: sharedUserId }, mockAdapters);

    expect(mockAdapters.db.fabFiles.updateGuarded).toHaveBeenCalledWith(
      expect.objectContaining({ id: foreignFileId, users: [{ userId: ownerId, permissions: ['read', 'share'] }] })
    );
  });

  // Was a test of the old owner-holds-share gate; the rows here are untagged, which is now the
  // reason nothing is written.
  it('leaves a stranger file alone when nothing on it is tagged with this session', async () => {
    const foreignFileId = 'file-foreign';
    const session = {
      id: sessionId,
      userId: ownerId,
      knowledgeIds: [foreignFileId],
      users: [{ userId: sharedUserId, permissions: ['read'] }],
    };
    const readOnlyToOwner = {
      id: foreignFileId,
      userId: 'someone-else',
      users: [
        { userId: ownerId, permissions: ['read'] },
        { userId: sharedUserId, permissions: ['read'] },
      ],
    };

    mockAdapters.db.users.findById.mockImplementation(async (id: string) =>
      id === ownerId ? { id: ownerId, groups: [] } : { id: sharedUserId, groups: [] }
    );
    mockAdapters.db.sessions.shareable.findAccessibleById.mockResolvedValue(session);
    mockAdapters.db.fabFiles.findAllByIds.mockResolvedValue([readOnlyToOwner]);

    await revoke(ownerId, { id: sessionId, type: 'sessions', userId: sharedUserId }, mockAdapters);

    expect(mockAdapters.db.fabFiles.updateGuarded).not.toHaveBeenCalled();
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
        sessions: { shareable: { findAccessibleById: vi.fn() }, update: vi.fn(), updateGuarded: vi.fn() },
        fabFiles: { shareable: { findAccessibleById: vi.fn() }, update: vi.fn(), updateGuarded: vi.fn() },
        projects: { shareable: { findAccessibleById: vi.fn() }, update: vi.fn(), updateGuarded: vi.fn() },
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

    expect(mockAdapters.db.fabFiles.updateGuarded).toHaveBeenCalledWith(
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

    expect(mockAdapters.db.fabFiles.updateGuarded).toHaveBeenCalledWith(
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

    expect(mockAdapters.db.fabFiles.updateGuarded).toHaveBeenCalledWith(expect.objectContaining({ users: [] }));
  });

  it('reports a scoped revoke that matches no grant instead of silently removing nothing', async () => {
    const file = materializeTwoProjectGrants();
    mockAdapters.db.users.findById.mockResolvedValue({ id: sharedUserId });
    mockAdapters.db.fabFiles.shareable.findAccessibleById.mockResolvedValue(file);

    await expect(
      revoke(ownerId, { id: fileId, type: 'files', userId: sharedUserId, projectId: 'project-C' }, mockAdapters)
    ).rejects.toThrow(NotFoundError);
    expect(mockAdapters.db.fabFiles.updateGuarded).not.toHaveBeenCalled();
  });
});

/**
 * The `type: 'projects'` arm, which the Members panel drives through
 * POST /api/projects/<id>/revokeSharing. Two things are specific to it: the predicate is
 * deliberately unscoped even when a projectId is supplied (rows on a project document are never
 * themselves projectId-tagged, so scoping by one would match nothing), and it runs the
 * revokeFromProject cascade and has to assign the pruned id lists back onto the document, since
 * that function stopped mutating the caller's project.
 */
describe('sharingService - revoke on a project', () => {
  const ownerId = 'owner-123';
  const memberId = 'member-456';
  const coMemberId = 'co-member-789';
  const projectId = 'project-1';

  let adapters: any;

  const aProject = (overrides: Record<string, unknown> = {}) => ({
    id: projectId,
    userId: ownerId,
    users: [
      { userId: memberId, permissions: [Permission.read] },
      { userId: coMemberId, permissions: [Permission.read] },
    ],
    fileIds: [],
    sessionIds: [],
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    adapters = {
      db: {
        sessions: {
          shareable: { findAccessibleById: vi.fn() },
          findAllByIds: vi.fn(async () => []),
          updateGuarded: vi.fn(),
        },
        fabFiles: {
          shareable: { findAccessibleById: vi.fn() },
          findAllByIds: vi.fn(async () => []),
          updateGuarded: vi.fn(),
        },
        projects: { shareable: { findAccessibleById: vi.fn() }, updateGuarded: vi.fn() },
        users: { findById: vi.fn(async () => ({ id: memberId })) },
      },
    };
  });

  it('removes only the target member, even when co-member rows carry the project id', async () => {
    // The tag on a co-member row is what the old project-scoped filter matched on, which is how
    // removing one member stripped the whole project's access. The projects arm has to key on the
    // user alone.
    const project = aProject({
      users: [
        { userId: memberId, permissions: [Permission.read] },
        { userId: coMemberId, permissions: [Permission.read], projectId },
      ],
    });
    adapters.db.projects.shareable.findAccessibleById.mockResolvedValue(project);

    await revoke(ownerId, { id: projectId, type: 'projects', userId: memberId }, adapters);

    expect(adapters.db.projects.updateGuarded).toHaveBeenCalledWith(
      expect.objectContaining({
        users: [{ userId: coMemberId, permissions: [Permission.read], projectId }],
      })
    );
  });

  it('stays unscoped when a projectId is supplied, rather than matching nothing', async () => {
    const project = aProject();
    adapters.db.projects.shareable.findAccessibleById.mockResolvedValue(project);

    // A project document's own rows carry no projectId tag, so a scoped predicate would find no
    // match here and raise NotFoundError instead of revoking.
    await revoke(ownerId, { id: projectId, type: 'projects', userId: memberId, projectId }, adapters);

    expect(adapters.db.projects.updateGuarded).toHaveBeenCalledWith(
      expect.objectContaining({ users: [{ userId: coMemberId, permissions: [Permission.read] }] })
    );
  });

  it('persists the id lists revokeFromProject pruned rather than the originals', async () => {
    // revokeFromProject returns the pruned lists instead of writing them onto the project it was
    // handed; the arm has to assign them or the member's own file stays on the project.
    const memberFile = { id: 'file-member', userId: memberId, users: [] };
    const project = aProject({ fileIds: ['file-member'], sessionIds: [] });
    adapters.db.projects.shareable.findAccessibleById.mockResolvedValue(project);
    adapters.db.fabFiles.findAllByIds.mockResolvedValue([memberFile]);
    adapters.db.fabFiles.shareable.findAccessibleById.mockResolvedValue({
      id: 'file-member',
      userId: memberId,
      users: [{ userId: coMemberId, permissions: [Permission.read], projectId }],
    });
    adapters.db.users.findById.mockResolvedValue({ id: coMemberId });

    await revoke(ownerId, { id: projectId, type: 'projects', userId: memberId }, adapters);

    expect(adapters.db.projects.updateGuarded).toHaveBeenCalledWith(
      expect.objectContaining({ fileIds: [], users: [{ userId: coMemberId, permissions: [Permission.read] }] })
    );
  });

  it('still refuses a caller who is neither the project owner nor the target', async () => {
    const project = aProject();
    adapters.db.projects.shareable.findAccessibleById.mockResolvedValue(project);

    await expect(revoke(coMemberId, { id: projectId, type: 'projects', userId: memberId }, adapters)).rejects.toThrow(
      UnauthorizedError
    );
    expect(adapters.db.projects.updateGuarded).not.toHaveBeenCalled();
  });
});
