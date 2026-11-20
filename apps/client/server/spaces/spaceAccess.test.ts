import { describe, it, expect, vi } from 'vitest';

vi.mock('@bike4mind/database', () => ({ spaceRepository: {}, userRepository: {} }));
vi.mock('@bike4mind/services', () => ({ spaceService: {} }));
vi.mock('@server/managers/createDocumentInvite', () => ({
  generateInviteLink: (invite: { id: string; token?: string }) => `https://app.test/share/${invite.token ?? invite.id}`,
}));

import { toSpaceInviteLinkView, toSpaceView } from './spaceAccess';

const space = {
  id: 'space1',
  name: 'Team',
  description: null,
  ownerUserId: 'owner',
  parentOrganizationId: null,
  members: [
    { userId: 'admin', role: 'admin', joinedVia: 'invite', joinedAt: new Date('2026-01-01') },
    { userId: 'member', role: 'member', joinedVia: 'link', joinedAt: new Date('2026-01-02') },
  ],
};
const users = [
  { id: 'owner', email: 'owner@x.com', username: 'owner', photoUrl: 'o.png' },
  { id: 'admin', email: 'admin@x.com', username: 'admin', photoUrl: null },
  { id: 'member', email: 'member@x.com', username: 'member', photoUrl: null },
];

const view = (viewerId: string) => toSpaceView({ id: viewerId } as never, { space, users } as never);
const emails = (v: ReturnType<typeof view>) => [v.owner, ...v.members].map(p => p.email);

describe('toSpaceView email visibility', () => {
  it('shows every email to the owner and to an admin', () => {
    expect(emails(view('owner'))).toEqual(['owner@x.com', 'admin@x.com', 'member@x.com']);
    expect(emails(view('admin'))).toEqual(['owner@x.com', 'admin@x.com', 'member@x.com']);
  });

  it('shows a plain member no email at all, their own included', () => {
    const v = view('member');
    expect(emails(v)).toEqual([undefined, undefined, undefined]);
    expect(JSON.stringify(v)).not.toContain('@x.com');
  });

  it('reports the viewer role and counts the owner as a member', () => {
    expect(view('owner')).toMatchObject({ viewerRole: 'owner', memberCount: 3 });
    expect(view('admin').viewerRole).toBe('admin');
    expect(view('member').viewerRole).toBe('member');
  });
});

describe('toSpaceInviteLinkView', () => {
  it('carries the redeemable URL and the limits', () => {
    expect(
      toSpaceInviteLinkView({
        id: 'l1',
        token: 't1',
        remaining: 4,
        recipients: { accepted: ['a@x.com'] },
        allowedDomains: ['x.com'],
      } as never)
    ).toMatchObject({
      id: 'l1',
      link: 'https://app.test/share/t1',
      remaining: 4,
      accepted: 1,
      allowedDomains: ['x.com'],
    });
  });
});
