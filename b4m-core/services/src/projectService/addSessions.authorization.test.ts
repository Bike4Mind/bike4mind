import { describe, it, expect, vi } from 'vitest';
import { IUserDocument, NotFoundError, Permission } from '@bike4mind/common';
import { addSessions } from './addSessions';
import { createShareableFake } from '../__tests__/utils/shareableFake';

describe('addSessions authorization', () => {
  const OWNER = 'user-owner';
  const SHAREE = 'user-sharee';

  const setup = (permissions: Permission[]) => {
    const project = {
      id: 'project-1',
      userId: OWNER,
      sessionIds: [] as string[],
      fileIds: [] as string[],
      users: [{ userId: SHAREE, permissions }],
      groups: [],
    };
    // Owned by the sharee, so only the project gate decides the outcome.
    const session = { id: 'session-1', userId: SHAREE, users: [], groups: [] };

    const projectUpdate = vi.fn().mockResolvedValue({});
    const sessionUpdate = vi.fn().mockResolvedValue(undefined);

    return {
      project,
      projectUpdate,
      sessionUpdate,
      adapters: {
        db: {
          projects: { shareable: createShareableFake([project as never]), updateWithUpdateAccess: projectUpdate },
          sessions: { shareable: createShareableFake([session as never]), update: sessionUpdate },
          fabFiles: { findAllByIds: vi.fn().mockResolvedValue([]) },
        },
      },
    };
  };

  it('refuses a read-only project member, leaving sessionIds and grants untouched', async () => {
    const { adapters, project, projectUpdate, sessionUpdate } = setup([Permission.read]);

    await expect(
      addSessions(
        { id: SHAREE } as IUserDocument,
        { projectId: 'project-1', sessionIds: ['session-1'] },
        adapters as any
      )
    ).rejects.toThrow(NotFoundError);

    expect(project.sessionIds).toEqual([]);
    expect(projectUpdate).not.toHaveBeenCalled();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it('still allows a project member holding update to add a session', async () => {
    const { adapters, project, projectUpdate } = setup([Permission.read, Permission.update]);

    await addSessions(
      { id: SHAREE } as IUserDocument,
      { projectId: 'project-1', sessionIds: ['session-1'] },
      adapters as any
    );

    expect(project.sessionIds).toEqual(['session-1']);
    expect(projectUpdate).toHaveBeenCalled();
  });

  it('answers 404 and pushes no grant when the gated project write matches nothing', async () => {
    // A revoke or delete landing between the update-access read and the write.
    const { adapters, projectUpdate, sessionUpdate } = setup([Permission.read, Permission.update]);
    projectUpdate.mockResolvedValue(null);

    await expect(
      addSessions(
        { id: SHAREE } as IUserDocument,
        { projectId: 'project-1', sessionIds: ['session-1'] },
        adapters as any
      )
    ).rejects.toThrow(NotFoundError);

    expect(sessionUpdate).not.toHaveBeenCalled();
  });
});

describe('addSessions grant cap', () => {
  const OWNER = 'user-owner';
  const ADDER = 'user-adder';
  const MEMBER = 'user-member';

  type Grants = { userId: string; permissions: Permission[]; projectId?: string }[];

  const run = async (
    session: { id: string; userId: string; users: Grants; knowledgeIds?: string[] },
    file?: object
  ) => {
    const project = {
      id: 'project-1',
      userId: OWNER,
      sessionIds: [] as string[],
      fileIds: [] as string[],
      users: [
        { userId: ADDER, permissions: [Permission.read, Permission.update] },
        { userId: MEMBER, permissions: [Permission.read, Permission.update] },
      ],
      groups: [],
    };
    const fabFileUpdate = vi.fn();
    const adapters = {
      db: {
        projects: {
          shareable: createShareableFake([project as never]),
          updateWithUpdateAccess: vi.fn(async () => ({})),
        },
        sessions: { shareable: createShareableFake([{ groups: [], ...session } as never]), update: vi.fn() },
        fabFiles: {
          shareable: createShareableFake(file ? [{ groups: [], ...file } as never] : []),
          update: fabFileUpdate,
        },
      },
    };
    await addSessions(
      { id: ADDER, groups: [] } as unknown as IUserDocument,
      { projectId: 'project-1', sessionIds: [session.id] },
      adapters as any
    );
    return (doc: { users: Grants }, userId: string) =>
      doc.users.find(u => u.userId === userId && u.projectId === 'project-1')?.permissions;
  };

  it('lets a read-only adder pass on only read on the session and its knowledge files', async () => {
    const session = {
      id: 'session-1',
      userId: 'someone-else',
      users: [{ userId: ADDER, permissions: [Permission.read] }],
      knowledgeIds: ['file-1'],
    };
    const file = { id: 'file-1', userId: 'someone-else', users: [{ userId: ADDER, permissions: [Permission.read] }] };

    const grantsFor = await run(session, file);

    expect(grantsFor(session, MEMBER)).toEqual([Permission.read]);
    expect(grantsFor(session, OWNER)).toEqual([Permission.read]);
    expect(grantsFor(file as { users: Grants }, MEMBER)).toEqual([Permission.read]);
    expect(grantsFor(file as { users: Grants }, OWNER)).toEqual([Permission.read]);
  });

  it('still passes update through when the adder owns the session', async () => {
    const session = { id: 'session-1', userId: ADDER, users: [] as Grants };

    const grantsFor = await run(session);

    expect(grantsFor(session, MEMBER)).toEqual([Permission.read, Permission.update]);
    expect(grantsFor(session, OWNER)).toEqual([Permission.read, Permission.update]);
  });
});
