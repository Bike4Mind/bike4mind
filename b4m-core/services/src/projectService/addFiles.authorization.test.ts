import { describe, it, expect, vi } from 'vitest';
import { IUserDocument, NotFoundError, Permission } from '@bike4mind/common';
import { addFiles } from './addFiles';
import { createShareableFake } from '../__tests__/utils/shareableFake';

describe('addFiles authorization', () => {
  const OWNER = 'user-owner';
  const SHAREE = 'user-sharee';

  const setup = (permissions: Permission[]) => {
    const project = {
      id: 'project-1',
      userId: OWNER,
      fileIds: [] as string[],
      systemPrompts: [],
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

  it('refuses a read-only project member, leaving fileIds and grants untouched', async () => {
    const { adapters, project, projectUpdate, fabFileUpdate } = setup([Permission.read]);

    await expect(
      addFiles({ id: SHAREE } as IUserDocument, { projectId: 'project-1', fileIds: ['file-1'] }, adapters as any)
    ).rejects.toThrow(NotFoundError);

    expect(project.fileIds).toEqual([]);
    expect(projectUpdate).not.toHaveBeenCalled();
    expect(fabFileUpdate).not.toHaveBeenCalled();
  });

  it('still allows a project member holding update to add a file', async () => {
    const { adapters, projectUpdate, fabFileUpdate } = setup([Permission.read, Permission.update]);

    const result = await addFiles(
      { id: SHAREE } as IUserDocument,
      { projectId: 'project-1', fileIds: ['file-1'] },
      adapters as any
    );

    expect(result.fileIds).toEqual(['file-1']);
    expect(projectUpdate).toHaveBeenCalled();
    expect(fabFileUpdate).toHaveBeenCalled();
  });

  it('answers 404 and pushes no grant when the gated project write matches nothing', async () => {
    // A revoke or delete landing between the update-access read and the write.
    const { adapters, projectUpdate, fabFileUpdate } = setup([Permission.read, Permission.update]);
    projectUpdate.mockResolvedValue(null);

    await expect(
      addFiles({ id: SHAREE } as IUserDocument, { projectId: 'project-1', fileIds: ['file-1'] }, adapters as any)
    ).rejects.toThrow(NotFoundError);

    expect(fabFileUpdate).not.toHaveBeenCalled();
  });
});

describe('addFiles grant cap', () => {
  const OWNER = 'user-owner';
  const ADDER = 'user-adder';
  const MEMBER = 'user-member';

  const run = async (
    adderId: string,
    file: { id: string; userId: string; users: never[] | object[]; groups?: object[] },
    adderGroups: string[] = []
  ) => {
    const project = {
      id: 'project-1',
      userId: OWNER,
      fileIds: [] as string[],
      systemPrompts: [],
      users: [
        { userId: ADDER, permissions: [Permission.read, Permission.update] },
        { userId: MEMBER, permissions: [Permission.read, Permission.update] },
      ],
      groups: [],
    };
    const adapters = {
      db: {
        projects: {
          shareable: createShareableFake([project as never]),
          updateWithUpdateAccess: vi.fn(async () => ({})),
        },
        fabFiles: { shareable: createShareableFake([{ groups: [], ...file } as never]), update: vi.fn() },
      },
    };
    await addFiles(
      { id: adderId, groups: adderGroups } as unknown as IUserDocument,
      {
        projectId: 'project-1',
        fileIds: [file.id],
      },
      adapters as any
    );
    const grantsFor = (userId: string) =>
      (file.users as { userId: string; permissions: Permission[]; projectId?: string }[]).find(
        u => u.userId === userId && u.projectId === 'project-1'
      )?.permissions;
    return grantsFor;
  };

  it('lets a read-only adder pass on only read, to the owner and to every member', async () => {
    const file = { id: 'file-1', userId: 'someone-else', users: [{ userId: ADDER, permissions: [Permission.read] }] };

    const grantsFor = await run(ADDER, file);

    expect(grantsFor(MEMBER)).toEqual([Permission.read]);
    expect(grantsFor(OWNER)).toEqual([Permission.read]);
    // The adder is a project member too: the fan-out must not hand them update on their own file row.
    expect(grantsFor(ADDER)).toEqual([Permission.read]);
  });

  it('still passes update through when the adder owns the file', async () => {
    const file = { id: 'file-1', userId: ADDER, users: [] };

    const grantsFor = await run(ADDER, file);

    expect(grantsFor(MEMBER)).toEqual([Permission.read, Permission.update]);
    expect(grantsFor(OWNER)).toEqual([Permission.read, Permission.update]);
  });

  it('counts an update grant the adder holds through a group', async () => {
    const file = {
      id: 'file-1',
      userId: 'someone-else',
      users: [],
      groups: [{ groupId: 'group-1', permissions: [Permission.read, Permission.update] }],
    };

    const grantsFor = await run(ADDER, file, ['group-1']);

    expect(grantsFor(MEMBER)).toEqual([Permission.read, Permission.update]);
  });
});
