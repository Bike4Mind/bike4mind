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

import { canViewInvite, filterInviteRecipientsToSelf } from './inviteManager';

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

  it('still admits a named recipient by email, case-insensitively', async () => {
    const named = linkInvite({ recipients: { pending: ['VIEWER@x.com'], accepted: [], refused: [] } });
    await expect(canViewInvite(user, named)).resolves.toBe(true);
    expect(authorizeByInviteType).not.toHaveBeenCalled();
  });
});
