import { describe, it, expect, vi } from 'vitest';
import { IUserDocument, NotFoundError, Permission } from '@bike4mind/common';
import { toggleSystemPrompt } from './toggleSystemPrompt';
import { createShareableFake } from '../__tests__/utils/shareableFake';

describe('toggleSystemPrompt authorization', () => {
  const SHAREE = 'user-sharee';

  const setup = (permissions: Permission[]) => {
    const project = {
      id: 'project-1',
      userId: 'user-owner',
      systemPrompts: [{ fileId: 'file-1', enabled: true }],
      users: [{ userId: SHAREE, permissions }],
      groups: [],
    };
    const projectUpdate = vi.fn().mockResolvedValue({});
    return {
      project,
      projectUpdate,
      adapters: {
        db: { projects: { shareable: createShareableFake([project as never]), updateWithUpdateAccess: projectUpdate } },
      },
    };
  };

  it('refuses a read-only project member with a 404 and writes nothing', async () => {
    const { adapters, project, projectUpdate } = setup([Permission.read]);

    await expect(
      toggleSystemPrompt({ id: SHAREE } as IUserDocument, { projectId: 'project-1', fileId: 'file-1' }, adapters as any)
    ).rejects.toThrow(NotFoundError);

    expect(project.systemPrompts[0].enabled).toBe(true);
    expect(projectUpdate).not.toHaveBeenCalled();
  });

  it('toggles for a member holding update, through the gated write', async () => {
    const { adapters, projectUpdate } = setup([Permission.read, Permission.update]);

    await toggleSystemPrompt(
      { id: SHAREE } as IUserDocument,
      { projectId: 'project-1', fileId: 'file-1' },
      adapters as any
    );

    expect(projectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: SHAREE }),
      expect.objectContaining({ id: 'project-1', systemPrompts: [{ fileId: 'file-1', enabled: false }] })
    );
  });

  it('answers 404 when the gated write matches nothing', async () => {
    const { adapters, projectUpdate } = setup([Permission.read, Permission.update]);
    projectUpdate.mockResolvedValue(null);

    await expect(
      toggleSystemPrompt({ id: SHAREE } as IUserDocument, { projectId: 'project-1', fileId: 'file-1' }, adapters as any)
    ).rejects.toThrow(NotFoundError);
  });
});
