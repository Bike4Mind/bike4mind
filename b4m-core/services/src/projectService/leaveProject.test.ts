import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { NotFoundError, UnauthorizedError } from '@bike4mind/utils';
import { Permission, IUserDocument } from '@bike4mind/common';
import { leaveProject } from './leaveProject';

/**
 * Two authorization arms and one shared post-condition. Only the project owner may remove another
 * member, only a non-owner may leave, and both arms run revokeFromProject and have to ASSIGN what
 * it returns - that function stopped writing the pruned id lists back onto the project it is
 * handed, so a caller that drops the return silently leaves the departing member's own files and
 * notebooks attached to the project.
 */
describe('projectService - leaveProject', () => {
  const ownerId = 'owner-123';
  const memberId = 'member-456';
  const coMemberId = 'co-member-789';
  const projectId = 'project-1';

  const asUser = (id: string) => ({ id, groups: [] }) as unknown as IUserDocument;

  let adapters: {
    db: {
      projects: { shareable: { findAccessibleById: Mock }; update: Mock; updateGuarded: Mock };
      sessions: { shareable: { findAccessibleById: Mock }; findAllByIds: Mock; updateGuarded: Mock };
      fabFiles: { shareable: { findAccessibleById: Mock }; findAllByIds: Mock; updateGuarded: Mock };
      users: { findById: Mock };
    };
  };

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
        projects: { shareable: { findAccessibleById: vi.fn() }, update: vi.fn(), updateGuarded: vi.fn() },
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
        users: { findById: vi.fn(async () => ({ id: memberId })) },
      },
    };
  });

  const run = (actor: string, userIdToRemove?: string) =>
    leaveProject(asUser(actor), { id: projectId, userIdToRemove }, adapters as never);

  it('lets the owner remove a member and leaves every co-member in place', async () => {
    const project = aProject();
    adapters.db.projects.shareable.findAccessibleById.mockResolvedValue(project);

    const result = await run(ownerId, memberId);

    expect(result.users).toEqual([{ userId: coMemberId, permissions: [Permission.read] }]);
    expect(adapters.db.projects.update).toHaveBeenCalledWith(project);
  });

  it('lets a member leave voluntarily', async () => {
    const project = aProject();
    adapters.db.projects.shareable.findAccessibleById.mockResolvedValue(project);

    const result = await run(memberId);

    expect(result.users).toEqual([{ userId: coMemberId, permissions: [Permission.read] }]);
    expect(adapters.db.projects.update).toHaveBeenCalledWith(project);
  });

  it('refuses a non-owner trying to remove somebody else', async () => {
    adapters.db.projects.shareable.findAccessibleById.mockResolvedValue(aProject());

    await expect(run(coMemberId, memberId)).rejects.toThrow(UnauthorizedError);
    expect(adapters.db.projects.update).not.toHaveBeenCalled();
  });

  it('refuses the owner leaving their own project', async () => {
    adapters.db.projects.shareable.findAccessibleById.mockResolvedValue(aProject());

    await expect(run(ownerId)).rejects.toThrow(UnauthorizedError);
    expect(adapters.db.projects.update).not.toHaveBeenCalled();
  });

  it('refuses to remove someone who is not a member, and writes nothing', async () => {
    adapters.db.projects.shareable.findAccessibleById.mockResolvedValue(aProject());

    await expect(run(ownerId, 'stranger')).rejects.toThrow(NotFoundError);
    expect(adapters.db.projects.update).not.toHaveBeenCalled();
  });

  it('404s on a project the caller cannot reach', async () => {
    adapters.db.projects.shareable.findAccessibleById.mockResolvedValue(null);

    await expect(run(ownerId, memberId)).rejects.toThrow(NotFoundError);
  });

  it('persists the id lists the cascade pruned when the owner removes a member', async () => {
    const memberFile = { id: 'file-member', userId: memberId, users: [] };
    const memberSession = { id: 'session-member', userId: memberId, users: [] };
    const project = aProject({ fileIds: ['file-member'], sessionIds: ['session-member'] });
    adapters.db.projects.shareable.findAccessibleById.mockResolvedValue(project);
    adapters.db.fabFiles.findAllByIds.mockResolvedValue([memberFile]);
    adapters.db.sessions.findAllByIds.mockResolvedValue([memberSession]);
    // The cascade re-enters revoke for each remaining member on the departing member's documents.
    adapters.db.fabFiles.shareable.findAccessibleById.mockResolvedValue({
      id: 'file-member',
      userId: memberId,
      users: [{ userId: coMemberId, permissions: [Permission.read], projectId }],
    });
    adapters.db.sessions.shareable.findAccessibleById.mockResolvedValue({
      id: 'session-member',
      userId: memberId,
      users: [{ userId: coMemberId, permissions: [Permission.read], projectId }],
    });
    adapters.db.users.findById.mockResolvedValue({ id: coMemberId });

    const result = await run(ownerId, memberId);

    expect(result.fileIds).toEqual([]);
    expect(result.sessionIds).toEqual([]);
  });

  it('persists the pruned id lists on a voluntary leave too', async () => {
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

    const result = await run(memberId);

    expect(result.fileIds).toEqual([]);
  });
});
