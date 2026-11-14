import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    user: null as Record<string, unknown> | null,
    space: null as Record<string, unknown> | null,
    invite: null as Record<string, unknown> | null,
  };
  return {
    state,
    userUpdate: vi.fn(),
    orgAddMember: vi.fn(),
    addMember: vi.fn(),
    acceptRecipient: vi.fn(),
  };
});

vi.mock('@server/utils/inviteAcceptLimits', () => ({ reserveInviteAccept: vi.fn() }));
vi.mock('@server/credits/orgInviteBonus', () => ({ payOrgInviteBonus: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToClient: vi.fn() }));
vi.mock('sst', () => ({ Resource: {} }));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: vi.fn(async () => ({})),
  getSettingsValue: () => 25,
}));
vi.mock('@bike4mind/database', () => ({
  inviteRepository: {
    findByToken: vi.fn(async () => h.state.invite),
    findById: vi.fn(async () => h.state.invite),
    acceptRecipient: h.acceptRecipient,
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

import { acceptInviteForUser } from './inviteResponses';

describe('acceptInviteForUser (Space link)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
