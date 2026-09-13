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

    const projectUpdate = vi.fn().mockResolvedValue(undefined);
    const sessionUpdate = vi.fn().mockResolvedValue(undefined);

    return {
      project,
      projectUpdate,
      sessionUpdate,
      adapters: {
        db: {
          projects: { shareable: createShareableFake([project as never]), update: projectUpdate },
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
});
