import { describe, it, expect, vi, beforeEach } from 'vitest';

// inviteManager imports these at module load; stub them so the helpers load
// without pulling the real DB graph.
vi.mock('@bike4mind/database', () => ({
  FabFile: {},
  Group: {},
  Organization: {},
  Session: {},
  User: {},
  fabFileRepository: {},
  sessionRepository: {},
  projectRepository: {},
  organizationRepository: {},
}));

const { authorizeByInviteType } = vi.hoisted(() => ({ authorizeByInviteType: vi.fn() }));
vi.mock('@bike4mind/services', () => ({ sharingService: { authorizeByInviteType } }));

import { canViewInvite, filterInviteRecipientsToSelf, omitInviteToken } from './inviteManager';

const baseInvite = () => ({
  id: 'inv1',
  type: 'FabFile',
  recipients: { pending: ['A@x.com', 'b@x.com'], accepted: ['c@x.com'], refused: ['d@x.com'] },
});

describe('filterInviteRecipientsToSelf', () => {
  it('keeps only the caller entry (case-insensitive) and strips co-recipients', () => {
    const out = filterInviteRecipientsToSelf(baseInvite(), 'a@x.com') as any;
    expect(out.recipients).toEqual({ pending: ['A@x.com'], accepted: [], refused: [] });
    const json = JSON.stringify(out);
    expect(json).not.toContain('b@x.com');
    expect(json).not.toContain('c@x.com');
    expect(json).not.toContain('d@x.com');
  });

  it('normalizes a Mongoose-style doc via toJSON before filtering', () => {
    const doc = { toJSON: () => baseInvite() };
    const out = filterInviteRecipientsToSelf(doc, 'c@x.com') as any;
    expect(out.recipients.accepted).toEqual(['c@x.com']);
    expect(out.recipients.pending).toEqual([]);
  });

  it('returns empty recipient arrays when the caller has no email', () => {
    const out = filterInviteRecipientsToSelf(baseInvite(), null) as any;
    expect(out.recipients).toEqual({ pending: [], accepted: [], refused: [] });
  });

  it('leaves an invite without recipients untouched', () => {
    const out = filterInviteRecipientsToSelf({ id: 'i2', type: 'Session' }, 'a@x.com') as any;
    expect('recipients' in out).toBe(false);
    expect(out.id).toBe('i2');
  });

  // This serializer is the last thing between an invite row and an invitee-facing body, and the
  // token is a redeemable secret: anyone who legitimately reaches one of those routes addressed the
  // request with it already, so echoing it back only widens where it can leak from.
  const TOKEN = 'wVvJ0hEr1sKq7nQ9YpB2fL4dXz8TcMuGaSiN3ROZjkw';

  it('strips the bearer token, and the key survives nothing else about the invite', () => {
    const out = filterInviteRecipientsToSelf({ ...baseInvite(), token: TOKEN }, 'a@x.com') as any;
    expect('token' in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(out.id).toBe('inv1');
  });

  it('strips it through the toJSON path too, which is how a Mongoose doc arrives', () => {
    const out = filterInviteRecipientsToSelf({ toJSON: () => ({ ...baseInvite(), token: TOKEN }) }, 'a@x.com') as any;
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('strips it on an invite with no recipients, which skips the filtering branch entirely', () => {
    const out = filterInviteRecipientsToSelf({ id: 'i2', type: 'Session', token: TOKEN }, 'a@x.com') as any;
    expect('token' in out).toBe(false);
  });

  // The input must not be mutated: callers pass a document they go on to use, and `toJSON`/spread
  // are what keep the deletion local to the response body.
  it("does not delete the token from the caller's own object", () => {
    const invite = { ...baseInvite(), token: TOKEN };
    filterInviteRecipientsToSelf(invite, 'a@x.com');
    expect(invite.token).toBe(TOKEN);
  });
});

describe('omitInviteToken', () => {
  const TOKEN = 'wVvJ0hEr1sKq7nQ9YpB2fL4dXz8TcMuGaSiN3ROZjkw';

  // The sharer-facing counterpart: unlike filterInviteRecipientsToSelf it keeps the full recipient
  // set, which is the whole reason the two are separate functions.
  it('drops the token and keeps everything else, recipients included', () => {
    const out = omitInviteToken({ ...baseInvite(), token: TOKEN }) as any;
    expect('token' in out).toBe(false);
    expect(out.recipients).toEqual(baseInvite().recipients);
  });

  it('normalizes a Mongoose-style doc via toJSON, and leaves the caller object alone', () => {
    const source = { ...baseInvite(), token: TOKEN };
    const out = omitInviteToken({ toJSON: () => ({ ...source }) }) as any;
    expect('token' in out).toBe(false);
    expect(source.token).toBe(TOKEN);
  });
});

describe('canViewInvite', () => {
  const user = { id: 'u1', email: 'viewer@x.com', groups: [] } as any;
  const linkInvite = (over: Record<string, unknown> = {}) =>
    ({
      id: 'inv-link',
      type: 'FabFile',
      documentId: 'doc1',
      recipients: { pending: [], accepted: [], refused: [] },
      remaining: 3,
      ...over,
    }) as any;

  beforeEach(() => {
    authorizeByInviteType.mockReset();
    // A caller who holds no permission on the document: the share arm always denies,
    // so every `true` below has to come from the link arm and nowhere else.
    authorizeByInviteType.mockRejectedValue(new Error('not authorized'));
  });

  it('lets a stranger view a redeemable link invite without consulting the share arm', async () => {
    await expect(canViewInvite(user, linkInvite())).resolves.toBe(true);
    expect(authorizeByInviteType).not.toHaveBeenCalled();
  });

  it('tolerates a link invite with no recipients object at all', async () => {
    await expect(canViewInvite(user, linkInvite({ recipients: undefined }))).resolves.toBe(true);
  });

  it('refuses an exhausted link invite', async () => {
    await expect(canViewInvite(user, linkInvite({ remaining: 0 }))).resolves.toBe(false);
  });

  it('refuses an expired link invite even with redemptions left', async () => {
    const expiresAt = new Date(Date.now() - 60_000).toISOString();
    await expect(canViewInvite(user, linkInvite({ expiresAt }))).resolves.toBe(false);
  });

  it('allows a link invite whose expiry is still in the future', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await expect(canViewInvite(user, linkInvite({ expiresAt }))).resolves.toBe(true);
  });

  it('does not extend the link arm to a named invite the caller is not on', async () => {
    const named = linkInvite({ recipients: { pending: ['someone@x.com'], accepted: [], refused: [] } });
    await expect(canViewInvite(user, named)).resolves.toBe(false);
    expect(authorizeByInviteType).toHaveBeenCalled();
  });

  // Project and Organization invites carry raw user ids. Before createInvite resolved those by
  // _id, their `pending` was always empty, so a link-only arm keyed on `pending.length` handed the
  // invite's contents (project/org id, name, inviter username, permissions) to any authenticated
  // caller holding the id.
  it('does not treat a named Project invite as a link invite', async () => {
    const named = linkInvite({ type: 'Project', isLinkOnly: false });
    await expect(canViewInvite(user, named)).resolves.toBe(false);
    expect(authorizeByInviteType).toHaveBeenCalled();
  });

  it('does not treat a named Organization invite as a link invite', async () => {
    const named = linkInvite({ type: 'Organization', isLinkOnly: false });
    await expect(canViewInvite(user, named)).resolves.toBe(false);
  });

  it('fails closed on a legacy Project invite that predates the flag', async () => {
    // No isLinkOnly at all and an empty pending: indistinguishable from a link invite by shape,
    // so the type is what decides. Only FabFile/Session recipients always resolved to emails.
    const legacy = linkInvite({ type: 'Project' });
    await expect(canViewInvite(user, legacy)).resolves.toBe(false);
  });

  it('still treats a legacy FabFile invite with no recipients as a link invite', async () => {
    await expect(canViewInvite(user, linkInvite({ type: 'FabFile' }))).resolves.toBe(true);
  });

  it('honours an explicit isLinkOnly over the inferred fallback', async () => {
    await expect(canViewInvite(user, linkInvite({ type: 'Project', isLinkOnly: true }))).resolves.toBe(true);
  });

  it('still admits a named recipient by email, case-insensitively', async () => {
    const named = linkInvite({ recipients: { pending: ['VIEWER@x.com'], accepted: [], refused: [] } });
    await expect(canViewInvite(user, named)).resolves.toBe(true);
    expect(authorizeByInviteType).not.toHaveBeenCalled();
  });
});
