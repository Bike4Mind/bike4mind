import { describe, it, expect, vi } from 'vitest';
import { IUserDocument, NotFoundError, Permission } from '@bike4mind/common';
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

    const projectUpdate = vi.fn().mockResolvedValue({});
    const fabFileUpdate = vi.fn().mockResolvedValue(undefined);

    return {
      project,
      projectUpdate,
      fabFileUpdate,
      adapters: {
        db: {
          projects: { shareable: createShareableFake([project as never]), updateWithUpdateAccess: projectUpdate },
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
    ).rejects.toThrow(NotFoundError);

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

  it('answers 404 and pushes no grant when the gated project write matches nothing', async () => {
    // A revoke or delete landing between the update-access read and the write.
    const { adapters, projectUpdate, fabFileUpdate } = setup([Permission.read, Permission.update]);
    projectUpdate.mockResolvedValue(null);

    await expect(
      addSystemPrompts(
        { id: SHAREE } as IUserDocument,
        { projectId: 'project-1', fileIds: ['file-1'] },
        adapters as any
      )
    ).rejects.toThrow(NotFoundError);

    expect(fabFileUpdate).not.toHaveBeenCalled();
  });

  describe('when pushing the file grants fails', () => {
    const run = (adapters: unknown) =>
      addSystemPrompts(
        { id: SHAREE } as IUserDocument,
        { projectId: 'project-1', fileIds: ['file-1'] },
        adapters as any
      );

    it('removes the new prompts through the gated write and rethrows the original error', async () => {
      const { adapters, projectUpdate, fabFileUpdate } = setup([Permission.read, Permission.update]);
      fabFileUpdate.mockRejectedValue(new Error('grant failed'));

      await expect(run(adapters)).rejects.toThrow('grant failed');

      expect(projectUpdate).toHaveBeenCalledTimes(2);
      expect(projectUpdate).toHaveBeenLastCalledWith({ id: SHAREE }, { id: 'project-1', systemPrompts: [] });
    });

    it.each([
      ['matches nothing', (u: ReturnType<typeof vi.fn>) => u.mockResolvedValueOnce(null)],
      ['throws', (u: ReturnType<typeof vi.fn>) => u.mockRejectedValueOnce(new Error('cleanup failed'))],
    ])('still rethrows the original error when the cleanup write %s', async (_label, arrange) => {
      const { adapters, projectUpdate, fabFileUpdate } = setup([Permission.read, Permission.update]);
      fabFileUpdate.mockRejectedValue(new Error('grant failed'));
      projectUpdate.mockResolvedValueOnce({});
      arrange(projectUpdate);

      await expect(run(adapters)).rejects.toThrow('grant failed');
    });
  });

  it('lets a read-only adder pass on only read on the prompt file', async () => {
    const MEMBER = 'user-member';
    const { adapters, project } = setup([Permission.read, Permission.update]);
    project.users.push({ userId: MEMBER, permissions: [Permission.read, Permission.update] });
    const file = {
      id: 'file-2',
      userId: 'someone-else',
      users: [{ userId: SHAREE, permissions: [Permission.read] }] as {
        userId: string;
        permissions: Permission[];
        projectId?: string;
      }[],
      groups: [],
    };
    adapters.db.fabFiles.shareable = createShareableFake([file as never]);

    await addSystemPrompts(
      { id: SHAREE, groups: [] } as unknown as IUserDocument,
      { projectId: 'project-1', fileIds: ['file-2'] },
      adapters as any
    );

    const grantsFor = (userId: string) =>
      file.users.find(u => u.userId === userId && u.projectId === 'project-1')?.permissions;
    expect(grantsFor(MEMBER)).toEqual([Permission.read]);
    expect(grantsFor(OWNER)).toEqual([Permission.read]);
  });
});
