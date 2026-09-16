import { describe, it, expect, vi } from 'vitest';
import { IUserDocument, NotFoundError, Permission } from '@bike4mind/common';
import { removeSystemPrompts } from './removeSystemPrompts';
import { createShareableFake } from '../__tests__/utils/shareableFake';

describe('removeSystemPrompts authorization', () => {
  const OWNER = 'user-owner';
  const SHAREE = 'user-sharee';

  const setup = (permissions: Permission[]) => {
    const project = {
      id: 'project-1',
      userId: OWNER,
      fileIds: [],
      systemPrompts: [{ fileId: 'file-1', enabled: true }],
      users: [{ userId: SHAREE, permissions }],
      groups: [],
    };

    const projectUpdate = vi.fn().mockResolvedValue(undefined);

    return {
      project,
      projectUpdate,
      adapters: {
        db: {
          projects: { shareable: createShareableFake([project as never]), update: projectUpdate },
          fabFiles: { shareable: createShareableFake([]), update: vi.fn() },
        },
      },
    };
  };

  it('refuses a read-only project member, leaving systemPrompts untouched', async () => {
    const { adapters, project, projectUpdate } = setup([Permission.read]);

    await expect(
      removeSystemPrompts(
        { id: SHAREE } as IUserDocument,
        { projectId: 'project-1', fileIds: ['file-1'] },
        adapters as any
      )
    ).rejects.toThrow(NotFoundError);

    expect(project.systemPrompts).toEqual([{ fileId: 'file-1', enabled: true }]);
    expect(projectUpdate).not.toHaveBeenCalled();
  });

  it('still allows a project member holding update to remove a system prompt', async () => {
    const { adapters, projectUpdate } = setup([Permission.read, Permission.update]);

    const result = await removeSystemPrompts(
      { id: SHAREE } as IUserDocument,
      { projectId: 'project-1', fileIds: ['file-1'] },
      adapters as any
    );

    expect(result.systemPrompts).toEqual([]);
    expect(projectUpdate).toHaveBeenCalledTimes(1);
  });
});
