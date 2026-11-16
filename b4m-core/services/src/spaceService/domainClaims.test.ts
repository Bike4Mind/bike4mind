import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictError, ForbiddenError, ISpaceDocument, IUserDocument } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { joinViaDomain } from './joinViaDomain';
import { listDomainSuggestions } from './listDomainSuggestions';
import { recheckDomainMembers } from './recheckDomainMembers';
import { notifySpaceDomainReleased, renderSpaceDomainReleasedEmail } from './notifySpaceDomainReleased';

const user = (extra: Partial<IUserDocument> = {}) =>
  ({ id: 'u1', email: 'a@acme.com', emailVerified: true, ...extra }) as IUserDocument;

const space = (over: Partial<ISpaceDocument> = {}): ISpaceDocument =>
  ({
    id: 'space1',
    name: 'Team',
    ownerUserId: 'owner',
    members: [],
    removedUserIds: [],
    parentOrganizationId: null,
    ...over,
  }) as ISpaceDocument;

describe('joinViaDomain', () => {
  let current: ISpaceDocument | null;
  let joinable: boolean;
  const db = {
    spaces: { findLiveById: vi.fn(async () => current), addMember: vi.fn() },
  };
  const isDomainJoinable = vi.fn(async () => joinable);
  const run = (u: IUserDocument) =>
    joinViaDomain(u, { spaceId: 'space1' }, { db, limits: { spaceMaxMembers: 5 }, isDomainJoinable } as never);

  beforeEach(() => {
    vi.clearAllMocks();
    current = space();
    joinable = true;
    db.spaces.addMember.mockResolvedValue(space());
  });

  it('adds a plain member joined by domain, with the cap and without clearing removal', async () => {
    await run(user());
    expect(db.spaces.addMember).toHaveBeenCalledWith(
      'space1',
      expect.objectContaining({ userId: 'u1', role: 'member', joinedVia: 'domain' }),
      { cap: 5, clearRemoved: false }
    );
  });

  it('refuses an unverified email before reading the Space', async () => {
    await expect(run(user({ emailVerified: false }))).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.spaces.findLiveById).not.toHaveBeenCalled();
  });

  it('answers a missing Space and a non-joinable address alike', async () => {
    current = null;
    const missing = await run(user()).catch(e => e);
    current = space();
    joinable = false;
    const refused = await run(user()).catch(e => e);
    expect(missing).toBeInstanceOf(ForbiddenError);
    expect(refused).toBeInstanceOf(ForbiddenError);
    expect(missing.message).toBe(refused.message);
    expect(db.spaces.addMember).not.toHaveBeenCalled();
  });

  it('gives 409 to an existing member', async () => {
    current = space({ members: [{ userId: 'u1', role: 'member', joinedVia: 'invite', joinedAt: new Date() }] });
    await expect(run(user())).rejects.toBeInstanceOf(ConflictError);
    expect(db.spaces.addMember).not.toHaveBeenCalled();
  });

  it('refuses a removed user when the write is declined', async () => {
    db.spaces.addMember.mockResolvedValueOnce(null);
    db.spaces.findLiveById.mockResolvedValueOnce(space()).mockResolvedValueOnce(space({ removedUserIds: ['u1'] }));
    await expect(run(user())).rejects.toThrow(new ForbiddenError('You cannot join this space'));
  });

  it('refuses when the Space is full', async () => {
    db.spaces.addMember.mockResolvedValueOnce(null);
    db.spaces.findLiveById.mockResolvedValueOnce(space()).mockResolvedValueOnce(space());
    await expect(run(user())).rejects.toThrow(new ForbiddenError('This space is full'));
  });

  it('maps a lost race to not-found or conflict', async () => {
    db.spaces.addMember.mockResolvedValueOnce(null);
    db.spaces.findLiveById.mockResolvedValueOnce(space()).mockResolvedValueOnce(null);
    await expect(run(user())).rejects.toBeInstanceOf(NotFoundError);
    db.spaces.addMember.mockResolvedValueOnce(null);
    db.spaces.findLiveById
      .mockResolvedValueOnce(space())
      .mockResolvedValueOnce(
        space({ members: [{ userId: 'u1', role: 'member', joinedVia: 'domain', joinedAt: new Date() }] })
      );
    await expect(run(user())).rejects.toBeInstanceOf(ConflictError);
  });

  it('lets a voluntary leaver rejoin, because leaving never blocks', async () => {
    current = space({ removedUserIds: [] });
    await run(user());
    expect(db.spaces.addMember).toHaveBeenCalledTimes(1);
  });
});

describe('listDomainSuggestions', () => {
  const spaces: Record<string, ISpaceDocument | null> = {};
  const db = { spaces: { findLiveById: vi.fn(async (id: string) => spaces[id] ?? null) } };
  const joinableSpaceIdsForEmail = vi.fn(async () => ['s1', 's2', 's3', 's4']);

  beforeEach(() => {
    vi.clearAllMocks();
    spaces.s1 = space({ id: 's1', name: 'One' });
    spaces.s2 = space({
      id: 's2',
      members: [{ userId: 'u1', role: 'member', joinedVia: 'link', joinedAt: new Date() }],
    });
    spaces.s3 = space({ id: 's3', removedUserIds: ['u1'] });
    spaces.s4 = null;
  });

  it('lists ids and names, skipping joined, removed and deleted Spaces', async () => {
    const result = await listDomainSuggestions(user(), { db, joinableSpaceIdsForEmail } as never);
    expect(result).toEqual([{ spaceId: 's1', spaceName: 'One' }]);
  });

  it('returns nothing for an unverified email without consulting claims', async () => {
    const result = await listDomainSuggestions(user({ emailVerified: false }), {
      db,
      joinableSpaceIdsForEmail,
    } as never);
    expect(result).toEqual([]);
    expect(joinableSpaceIdsForEmail).not.toHaveBeenCalled();
  });
});

describe('recheckDomainMembers', () => {
  const db = { spaces: { listDomainJoinedForUser: vi.fn(), removeMember: vi.fn() } };
  const isDomainJoinable = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    db.spaces.listDomainJoinedForUser.mockResolvedValue([space({ id: 'a' }), space({ id: 'b' })]);
  });

  it('pulls only the Spaces the new address no longer qualifies for, without blocking', async () => {
    isDomainJoinable.mockImplementation(async (s: ISpaceDocument) => s.id === 'a');
    await recheckDomainMembers('u1', 'a@other.com', { db, isDomainJoinable } as never);
    expect(db.spaces.removeMember).toHaveBeenCalledTimes(1);
    expect(db.spaces.removeMember).toHaveBeenCalledWith('b', 'u1', { block: false });
  });

  it('keeps every membership when the new address is still joinable', async () => {
    isDomainJoinable.mockResolvedValue(true);
    await recheckDomainMembers('u1', 'a@acme.org', { db, isDomainJoinable } as never);
    expect(db.spaces.removeMember).not.toHaveBeenCalled();
  });
});

describe('notifySpaceDomainReleased', () => {
  const context = { ownerUserId: 'owner', spaceName: 'Team', domain: 'acme.com' };
  const deps = () => ({
    db: { users: { findActiveEmailsByIds: vi.fn(async () => [{ id: 'owner', email: 'o@x.com' }]) } },
    mailer: { sendEmail: vi.fn(async () => true) },
    logger: { warn: vi.fn() },
  });

  it('names the Space and domain and nothing about the claiming org', async () => {
    const d = deps();
    await notifySpaceDomainReleased(context, d as never);
    const [to, message] = d.mailer.sendEmail.mock.calls[0] as unknown as [string, { subject: string; html: string }];
    expect(to).toBe('o@x.com');
    expect(message.subject).toContain('Team');
    expect(message.subject).toContain('acme.com');
    expect(message.html.toLowerCase()).not.toContain('organization');
  });

  it('escapes the Space name and strips line breaks from the subject', () => {
    const { subject, html } = renderSpaceDomainReleasedEmail('<b>x</b>\r\nBcc: y', 'acme.com');
    expect(subject).not.toMatch(/[\r\n]/);
    expect(html).not.toContain('<b>x</b>');
  });

  it('never throws when the mailer or lookup fails', async () => {
    const d = deps();
    d.mailer.sendEmail.mockRejectedValueOnce(new Error('smtp'));
    await expect(notifySpaceDomainReleased(context, d as never)).resolves.toBeUndefined();
    d.db.users.findActiveEmailsByIds.mockResolvedValueOnce([]);
    await expect(notifySpaceDomainReleased(context, d as never)).resolves.toBeUndefined();
    expect(d.logger.warn).toHaveBeenCalledTimes(2);
  });
});
