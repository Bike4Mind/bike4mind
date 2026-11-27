import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InviteType, IUserDocument, Permission } from '@bike4mind/common';
import { BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/utils';
import { createInvite } from './create';

describe('sharingService - createInvite (Space arm)', () => {
  const SPACE_ID = 'space-1';
  const asUser = (id: string) => ({ id, username: id }) as IUserDocument;

  let space: Record<string, unknown> | null;
  let db: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- partial repository mocks

  beforeEach(() => {
    space = {
      id: SPACE_ID,
      name: 'Team',
      ownerUserId: 'owner',
      members: [
        { userId: 'admin', role: 'admin' },
        { userId: 'plain', role: 'member' },
      ],
    };
    db = {
      invites: { create: vi.fn(async (build: unknown) => ({ id: 'invite-1', ...(build as object) })) },
      users: {
        findAllByEmailsOrUsernames: vi.fn(async () => [{ id: 'u9', email: 'x@y.com', username: 'x' }]),
        findByIds: vi.fn(async () => []),
      },
      fabFiles: { shareable: { findShareAccessById: vi.fn() } },
      sessions: { shareable: { findShareAccessById: vi.fn() } },
      projects: { shareable: { findShareAccessById: vi.fn() } },
      organizations: { findById: vi.fn() },
      groups: { findById: vi.fn() },
      spaces: { findLiveById: vi.fn(async () => space) },
    };
  });

  const link = (user: IUserDocument, extra: Record<string, unknown> = {}) =>
    createInvite(
      user,
      {
        id: SPACE_ID,
        type: InviteType.Space,
        permissions: [Permission.read, Permission.update],
        recipients: [],
        link: true,
        available: 5,
        ...extra,
      } as never,
      { db }
    );

  it('stores allowedDomains on a Space link and forces viewer permissions', async () => {
    await link(asUser('owner'), { allowedDomains: ['Example.com', 'example.com'] });
    const built = db.invites.create.mock.calls[0][0];
    expect(built.allowedDomains).toEqual(['example.com']);
    expect(built.isLinkOnly).toBe(true);
    expect(built.permissions).not.toContain(Permission.update);
  });

  it('lets an admin mint a link', async () => {
    await expect(link(asUser('admin'))).resolves.toBeTruthy();
  });

  it('refuses a link for a type that is neither Organization nor Space', async () => {
    await expect(
      createInvite(
        asUser('owner'),
        { id: 'g1', type: InviteType.Group, permissions: [Permission.read], recipients: [], link: true } as never,
        { db }
      )
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('refuses a named Space invite from a plain member', async () => {
    await expect(
      createInvite(
        asUser('plain'),
        { id: SPACE_ID, type: InviteType.Space, permissions: [Permission.read], recipients: ['x@y.com'] } as never,
        { db }
      )
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.invites.create).not.toHaveBeenCalled();
  });

  it('answers a non-member like a missing Space', async () => {
    await expect(link(asUser('stranger'))).rejects.toBeInstanceOf(NotFoundError);
    space = null;
    await expect(link(asUser('owner'))).rejects.toBeInstanceOf(NotFoundError);
  });
});
