import { describe, it, expect, vi } from 'vitest';
import { IUserDocument, Permission } from '@bike4mind/common';
import { addSystemPrompts } from './addSystemPrompts';
import { createShareableFake } from '../__tests__/utils/shareableFake';

describe('addSystemPrompts authorization', () => {
  const OWNER = 'user-owner';
  const SHAREE = 'user-sharee';

  const setup = (permissions: Permission[]) => {
    const project = {
      id: 'project-1',
      userId: OWNER,
      systemPrompts: [] as { fileId: string; enabled: boolean }[],
      users: [{ userId: SHAREE, permissions }],
      groups: [],
    };
    // Owned by the sharee, so only the project gate decides the outcome.
    const file = { id: 'file-1', userId: SHAREE, users: [], groups: [] };

    const projectUpdate = vi.fn().mockResolvedValue(undefined);
    const fabFileUpdate = vi.fn().mockResolvedValue(undefined);

    return {
      project,
      projectUpdate,
      fabFileUpdate,
      adapters: {
        db: {
          projects: { shareable: createShareableFake([project as never]), update: projectUpdate },
          fabFiles: { shareable: createShareableFake([file as never]), update: fabFileUpdate },
        },
      },
    };
  };

  it('refuses a read-only project member, leaving systemPrompts and grants untouched', async () => {
    const { adapters, project, projectUpdate, fabFileUpdate } = setup([Permission.read]);

    await expect(
      addSystemPrompts(
        { id: SHAREE } as IUserDocument,
        { projectId: 'project-1', fileIds: ['file-1'] },
        adapters as any
      )
    ).rejects.toThrow();

    expect(project.systemPrompts).toEqual([]);
    expect(projectUpdate).not.toHaveBeenCalled();
    expect(fabFileUpdate).not.toHaveBeenCalled();
  });

  it('still allows a project member holding update to add a system prompt', async () => {
    const { adapters, project, projectUpdate } = setup([Permission.read, Permission.update]);

    await addSystemPrompts(
      { id: SHAREE } as IUserDocument,
      { projectId: 'project-1', fileIds: ['file-1'] },
      adapters as any
    );

    expect(project.systemPrompts).toEqual([{ fileId: 'file-1', enabled: true }]);
    expect(projectUpdate).toHaveBeenCalled();
  });
});
