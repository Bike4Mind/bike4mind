import { describe, expect, it, vi } from 'vitest';
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
      { db: { users: { findByEmail: vi.fn(), findOrCreateByEmail }, organizations: { update } } }
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
      db: { users: { findByEmail: vi.fn(), findOrCreateByEmail }, organizations: { update: vi.fn() } },
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
      { db: { users: { findByEmail: vi.fn(), findOrCreateByEmail }, organizations: { update } } }
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses an account at that address that is not the org service account', async () => {
    const findOrCreateByEmail = vi.fn(async () => asUser({ id: 'u1', isSystem: false }));
    await expect(
      getOrCreateOrgServiceAccount(
        { id: 'org1' },
        { db: { users: { findByEmail: vi.fn(), findOrCreateByEmail }, organizations: { update: vi.fn() } } }
      )
    ).rejects.toThrow(/not its service account/);
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
    const findByEmail = vi.fn(async () => stored);
    expect(await findOrgServiceAccount('org1', { db: { users: { findByEmail } } })).toBe(expected);
  });

  it('returns the org service account', async () => {
    const account = asUser({ id: 'sa1', isSystem: true, serviceAccountOrganizationId: 'org1' });
    expect(await findOrgServiceAccount('org1', { db: { users: { findByEmail: vi.fn(async () => account) } } })).toBe(
      account
    );
  });
});
