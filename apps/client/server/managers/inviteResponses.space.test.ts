import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    user: null as Record<string, unknown> | null,
    space: null as Record<string, unknown> | null,
    invite: null as Record<string, unknown> | null,
  };
  return {
    state,
    settings: { SpaceMaxMembers: 25, EnableSpaces: true } as Record<string, unknown>,
    userUpdate: vi.fn(),
    orgAddMember: vi.fn(),
    addMember: vi.fn(),
    acceptRecipient: vi.fn(),
    refusePending: vi.fn(),
  };
});

const reserveInviteAccept = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/inviteAcceptLimits', () => ({ reserveInviteAccept }));
vi.mock('@server/credits/orgInviteBonus', () => ({ payOrgInviteBonus: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToClient: vi.fn() }));
vi.mock('sst', () => ({ Resource: {} }));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: vi.fn(async () => ({})),
  getSettingsValue: (name: string) => h.settings[name],
}));
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({
  isFeatureEnabled: vi.fn(async (name: string) => h.settings[name] === true),
}));
vi.mock('@bike4mind/database', () => ({
  inviteRepository: {
    findByToken: vi.fn(async () => h.state.invite),
    findById: vi.fn(async () => h.state.invite),
    acceptRecipient: h.acceptRecipient,
    refusePendingRecipient: h.refusePending,
    findAllByDocumentId: vi.fn(async () => []),
    cancelPendingRecipient: vi.fn(),
  },
  organizationRepository: { addMemberIfUnderCeiling: h.orgAddMember, findById: vi.fn(async () => null) },
  sessionRepository: {},
  projectRepository: {},
  fabFileRepository: {},
  fileTagRepository: {},
  Project: {},
  Group: { findById: vi.fn() },
  userRepository: {
    findById: vi.fn(async (id: string) => (id === 'minter' ? { id: 'minter' } : h.state.user)),
    update: h.userUpdate,
  },
  spaceRepository: {
    findLiveById: vi.fn(async () => h.state.space),
    addMember: h.addMember,
  },
  adminSettingsRepository: {},
  withTransaction: async <T>(fn: () => Promise<T>) => fn(),
}));

import { acceptInviteForUser, refuseInviteForUser } from './inviteResponses';
import { isDisabledSpaceInviteKey, withoutDisabledSpaceInvites } from './inviteManager';

describe('acceptInviteForUser (Space link)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.settings.EnableSpaces = true;
    h.state.user = { id: 'joiner', email: 'joiner@example.com', emailVerified: true, organizationId: 'org-before' };
    h.state.space = {
      id: 'space1',
      ownerUserId: 'owner',
      members: [{ userId: 'minter', role: 'admin' }],
      removedUserIds: [],
    };
    h.state.invite = {
      id: 'link1',
      token: 'tok1',
      type: 'Space',
      documentId: 'space1',
      inviterId: 'minter',
      isLinkOnly: true,
      remaining: 3,
      recipients: { pending: [], accepted: [], refused: [] },
    };
    h.addMember.mockResolvedValue(h.state.space);
    h.acceptRecipient.mockImplementation(async () => h.state.invite);
  });

  it('adds the member with the configured cap and leaves the joiner organization untouched', async () => {
    const user = h.state.user!;
    const result = await acceptInviteForUser({ user, logger: undefined } as never, 'tok1');

    expect(result.outcome).toBe('accepted');
    expect(h.addMember).toHaveBeenCalledWith(
      'space1',
      expect.objectContaining({ userId: 'joiner', joinedVia: 'link' }),
      { cap: 25, clearRemoved: false }
    );
    expect(h.userUpdate).not.toHaveBeenCalled();
    expect(h.orgAddMember).not.toHaveBeenCalled();
    expect(user.organizationId).toBe('org-before');
  });

  it('refuses with the flag off and spends nothing', async () => {
    h.settings.EnableSpaces = false;
    await expect(acceptInviteForUser({ user: h.state.user, logger: undefined } as never, 'tok1')).rejects.toMatchObject(
      {
        statusCode: 404,
        message: 'Invite not found',
      }
    );
    expect(reserveInviteAccept).not.toHaveBeenCalled();
    expect(h.addMember).not.toHaveBeenCalled();
    expect(h.acceptRecipient).not.toHaveBeenCalled();
  });
});

describe('Space invites with EnableSpaces off', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.settings.EnableSpaces = true;
    h.state.user = { id: 'joiner', email: 'joiner@example.com', emailVerified: true };
    h.state.invite = {
      id: 'named1',
      type: 'Space',
      documentId: 'space1',
      inviterId: 'minter',
      remaining: 1,
      recipients: { pending: ['joiner@example.com'], accepted: [], refused: [] },
    };
    h.refusePending.mockResolvedValue(h.state.invite);
  });

  it('refuse answers not found and writes nothing', async () => {
    h.settings.EnableSpaces = false;
    await expect(
      refuseInviteForUser({ user: h.state.user, logger: undefined } as never, 'named1')
    ).rejects.toMatchObject({ statusCode: 404, message: 'Invite not found' });
    expect(h.refusePending).not.toHaveBeenCalled();
  });

  it('refuse is unchanged with the flag on', async () => {
    await refuseInviteForUser({ user: h.state.user, logger: undefined } as never, 'named1');
    expect(h.refusePending).toHaveBeenCalledWith('named1', 'joiner@example.com');
  });

  it('the key check is true only for a Space invite with the flag off', async () => {
    h.settings.EnableSpaces = false;
    expect(await isDisabledSpaceInviteKey('named1')).toBe(true);
    h.state.invite = { ...h.state.invite, type: 'Project' };
    expect(await isDisabledSpaceInviteKey('named1')).toBe(false);
  });

  it('the key check is false with the flag on', async () => {
    expect(await isDisabledSpaceInviteKey('named1')).toBe(false);
  });

  it('list filter drops Space invites with the flag off and keeps the rest', async () => {
    h.settings.EnableSpaces = false;
    const list = [
      { id: 'a', type: 'Space' },
      { id: 'b', type: 'Project' },
    ];
    expect(await withoutDisabledSpaceInvites(list)).toEqual([{ id: 'b', type: 'Project' }]);
  });

  it('list filter returns the list unchanged with the flag on', async () => {
    const list = [
      { id: 'a', type: 'Space' },
      { id: 'b', type: 'Project' },
    ];
    expect(await withoutDisabledSpaceInvites(list)).toEqual(list);
  });
});
