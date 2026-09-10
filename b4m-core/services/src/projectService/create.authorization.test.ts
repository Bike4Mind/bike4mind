import { describe, it, expect, vi } from 'vitest';
import { BadRequestError } from '@bike4mind/common';
import { createProject } from './create';
import { createShareableFake } from '../__tests__/utils/shareableFake';

describe('createProject authorization', () => {
  const CALLER = 'user-caller';
  const STRANGER = 'user-stranger';

  const setup = () => {
    // Owned by someone else, with no share grant to CALLER at all.
    const foreignFile = { id: 'file-1', userId: STRANGER, users: [], groups: [] };
    const foreignSession = { id: 'session-1', userId: STRANGER, users: [], groups: [] };

    const projectCreate = vi.fn().mockResolvedValue(undefined);

    return {
      projectCreate,
      adapters: {
        db: {
          projects: { create: projectCreate },
          fabFiles: { shareable: createShareableFake([foreignFile]) },
          sessions: { shareable: createShareableFake([foreignSession]) },
        },
      },
    };
  };

  it('refuses a fileId the caller cannot reach, creating nothing', async () => {
    const { adapters, projectCreate } = setup();

    await expect(
      createProject({ id: CALLER }, { name: 'n', description: 'd', fileIds: ['file-1'] }, adapters)
    ).rejects.toThrow(BadRequestError);

    expect(projectCreate).not.toHaveBeenCalled();
  });

  it('refuses a sessionId the caller cannot reach, creating nothing', async () => {
    const { adapters, projectCreate } = setup();

    await expect(
      createProject({ id: CALLER }, { name: 'n', description: 'd', sessionIds: ['session-1'] }, adapters)
    ).rejects.toThrow(BadRequestError);

    expect(projectCreate).not.toHaveBeenCalled();
  });

  it('still creates the project with a fileId the caller can reach', async () => {
    const { adapters, projectCreate } = setup();
    // Reuse the fake's foreign-file fixture set, adding one the caller owns.
    adapters.db.fabFiles = {
      shareable: createShareableFake([{ id: 'file-2', userId: CALLER, users: [], groups: [] }]),
    };

    await createProject({ id: CALLER }, { name: 'n', description: 'd', fileIds: ['file-2'] }, adapters);

    expect(projectCreate).toHaveBeenCalledWith(expect.objectContaining({ fileIds: ['file-2'] }));
  });
});
