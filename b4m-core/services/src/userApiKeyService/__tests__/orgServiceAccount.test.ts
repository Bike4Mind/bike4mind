import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '@bike4mind/utils';
import { orgServiceAccountEmail, type IUserDocument } from '@bike4mind/common';
import { findOrgServiceAccount, getOrCreateOrgServiceAccount } from '../orgServiceAccount';

const asUser = (fields: Partial<IUserDocument>) => fields as IUserDocument;

describe('getOrCreateOrgServiceAccount', () => {
  it('upserts a system account bound to the org at its service-account address', async () => {
    const findOrCreateByEmail = vi.fn(async (_email: string, defaults: Partial<IUserDocument>) =>
      asUser({ id: 'sa1', ...defaults })
    );
    const update = vi.fn();
    const user = await getOrCreateOrgServiceAccount(
      { id: 'org1', name: 'Acme' },
      { db: { users: { findOrCreateByEmail }, organizations: { update } } }
    );

    expect(findOrCreateByEmail).toHaveBeenCalledWith(
      orgServiceAccountEmail('org1'),
      expect.objectContaining({ isSystem: true, isAdmin: false, serviceAccountOrganizationId: 'org1' })
    );
    expect(user.id).toBe('sa1');
    expect(update).toHaveBeenCalledWith({ id: 'org1', serviceAccountUserId: 'sa1' });
  });

  it('uses a non-derivable username so a human cannot squat it', async () => {
    const usernames: string[] = [];
    const findOrCreateByEmail = vi.fn(async (_email: string, defaults: Partial<IUserDocument>) => {
      usernames.push(defaults.username as string);
      return asUser({ id: 'sa1', ...defaults });
    });
    const adapters = {
      db: { users: { findOrCreateByEmail }, organizations: { update: vi.fn() } },
    };
    await getOrCreateOrgServiceAccount({ id: 'org1' }, adapters);
    await getOrCreateOrgServiceAccount({ id: 'org1' }, adapters);

    expect(usernames[0]).not.toBe('org-org1-service-account');
    expect(usernames[1]).not.toBe('org-org1-service-account');
    expect(usernames[0]).not.toBe(usernames[1]);
    expect(usernames[0].length).toBeLessThanOrEqual(64);
  });

  it('leaves the org alone when it already records this service account', async () => {
    const findOrCreateByEmail = vi.fn(async (_email: string, defaults: Partial<IUserDocument>) =>
      asUser({ id: 'sa1', ...defaults })
    );
    const update = vi.fn();
    await getOrCreateOrgServiceAccount(
      { id: 'org1', serviceAccountUserId: 'sa1' },
      { db: { users: { findOrCreateByEmail }, organizations: { update } } }
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses an account at that address that is not the org service account', async () => {
    const findOrCreateByEmail = vi.fn(async () => asUser({ id: 'u1', isSystem: false }));
    await expect(
      getOrCreateOrgServiceAccount(
        { id: 'org1' },
        { db: { users: { findOrCreateByEmail }, organizations: { update: vi.fn() } } }
      )
    ).rejects.toThrow(/not its service account/);
  });

  it('answers a retired account (org deleted) with a 404, not a 500, and does not rebind the org', async () => {
    const findOrCreateByEmail = vi.fn(async () =>
      asUser({ id: 'sa1', isSystem: true, serviceAccountOrganizationId: 'org1', serviceAccountRetiredAt: new Date() })
    );
    const update = vi.fn();
    await expect(
      getOrCreateOrgServiceAccount(
        { id: 'org1' },
        { db: { users: { findOrCreateByEmail }, organizations: { update } } }
      )
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('findOrgServiceAccount', () => {
  it.each([
    ['none exists', null, null],
    [
      'the account belongs to another org',
      asUser({ id: 'sa2', isSystem: true, serviceAccountOrganizationId: 'org2' }),
      null,
    ],
  ])('returns null when %s', async (_label, stored, expected) => {
    const findOne = vi.fn(async () => stored);
    expect(await findOrgServiceAccount('org1', { db: { users: { findOne } } })).toBe(expected);
  });

  it('uses an exact generated-address query without human email collation', async () => {
    const account = asUser({ id: 'sa1', isSystem: true, serviceAccountOrganizationId: 'org1' });
    const findOne = vi.fn(async () => account);
    expect(await findOrgServiceAccount('org1', { db: { users: { findOne } } })).toBe(account);
    expect(findOne).toHaveBeenCalledExactlyOnceWith({ email: orgServiceAccountEmail('org1') });
  });
});
