import { describe, it, expect, vi } from 'vitest';
import { IUserDocument, NotFoundError, Permission } from '@bike4mind/common';
import { listInvites } from './listInvites';
import { createShareableFake } from '../__tests__/utils/shareableFake';

/**
 * listInvites resolved the project through a read-level predicate, so any project
 * member (even one with only `read`) could list its invites -- harvesting link-invite
 * ids and pending invitees' email addresses. It must require share authority instead,
 * matching sharingService/create.ts's Project arm.
 */
describe('projectService - listInvites authorization', () => {
  const OWNER = 'user-owner';
  const SHAREE = 'user-sharee';

  const setup = (permissions: Permission[]) => {
    const project = {
      id: 'project-1',
      userId: OWNER,
      users: [{ userId: SHAREE, permissions }],
      groups: [],
    };
    const searchInvites = vi.fn().mockResolvedValue({ data: [], meta: { currentPage: 1, totalPages: 0, total: 0 } });

    return {
      searchInvites,
      adapters: {
        db: {
          projects: { shareable: createShareableFake([project as never]) },
          invites: { searchInvites },
        },
        ability: {},
      },
    };
  };

  it('refuses a read-only project member', async () => {
    const { adapters, searchInvites } = setup([Permission.read]);

    await expect(
      listInvites({ id: SHAREE } as IUserDocument, { id: 'project-1' } as never, adapters as never)
    ).rejects.toThrow(NotFoundError);
    expect(searchInvites).not.toHaveBeenCalled();
  });

  it('allows a project member holding share', async () => {
    const { adapters, searchInvites } = setup([Permission.share]);

    await listInvites({ id: SHAREE } as IUserDocument, { id: 'project-1' } as never, adapters as never);

    expect(searchInvites).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'project-1' }),
      expect.any(Number),
      expect.any(Number)
    );
  });

  it('allows the project owner', async () => {
    const { adapters, searchInvites } = setup([Permission.read]);

    await listInvites({ id: OWNER } as IUserDocument, { id: 'project-1' } as never, adapters as never);

    expect(searchInvites).toHaveBeenCalled();
  });
});
