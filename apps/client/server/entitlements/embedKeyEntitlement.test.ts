import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';

const organizationRepository = vi.hoisted(() => ({ findById: vi.fn() }));
const userRepository = vi.hoisted(() => ({ findById: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ organizationRepository, userRepository }));

const getUserEntitlements = vi.hoisted(() => vi.fn());
vi.mock('./index', () => ({ getUserEntitlements }));

import { Logger } from '@bike4mind/observability';
import { embedKeyOwnerHasEntitlement } from './embedKeyEntitlement';

const warn = vi.spyOn(Logger.globalInstance, 'warn').mockImplementation(() => {});

const KEY = 'embed:whitelabel';
const userKeyRef = { userId: 'minter-1' };
const orgKeyRef = {
  userId: 'minter-1',
  billingOwnerType: CreditHolderType.Organization,
  organizationId: 'org-1',
};

describe('embedKeyOwnerHasEntitlement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userRepository.findById.mockResolvedValue({ id: 'minter-1', isAdmin: false });
    getUserEntitlements.mockResolvedValue([]);
  });

  it('resolves the minting user for a user-billed key', async () => {
    getUserEntitlements.mockResolvedValue([KEY]);
    await expect(embedKeyOwnerHasEntitlement(userKeyRef, KEY)).resolves.toBe(true);
    expect(userRepository.findById).toHaveBeenCalledWith('minter-1');
    expect(organizationRepository.findById).not.toHaveBeenCalled();
  });

  it('resolves the org billing owner, not the minter, for an org-billed key', async () => {
    organizationRepository.findById.mockResolvedValue({ id: 'org-1', userId: 'owner-9' });
    userRepository.findById.mockResolvedValue({ id: 'owner-9', isAdmin: false });
    getUserEntitlements.mockResolvedValue([KEY]);

    await expect(embedKeyOwnerHasEntitlement(orgKeyRef, KEY)).resolves.toBe(true);
    // The minter's own entitlements must never substitute for the org plan.
    expect(userRepository.findById).toHaveBeenCalledWith('owner-9');
    expect(userRepository.findById).not.toHaveBeenCalledWith('minter-1');
  });

  it('returns false when the owner lacks the entitlement', async () => {
    getUserEntitlements.mockResolvedValue(['other:key']);
    await expect(embedKeyOwnerHasEntitlement(userKeyRef, KEY)).resolves.toBe(false);
  });

  it('does NOT apply the admin bypass (plan feature, not operator privilege)', async () => {
    userRepository.findById.mockResolvedValue({ id: 'minter-1', isAdmin: true });
    getUserEntitlements.mockResolvedValue([]);
    await expect(embedKeyOwnerHasEntitlement(userKeyRef, KEY)).resolves.toBe(false);
  });

  it('fails closed when the org cannot be resolved', async () => {
    organizationRepository.findById.mockResolvedValue(null);
    await expect(embedKeyOwnerHasEntitlement(orgKeyRef, KEY)).resolves.toBe(false);
  });

  it('fails closed for an org-billed key with a missing organizationId (never the minter)', async () => {
    getUserEntitlements.mockResolvedValue([KEY]); // minter WOULD be entitled
    const orgKeyNoOrg = {
      userId: 'minter-1',
      billingOwnerType: CreditHolderType.Organization,
      organizationId: undefined,
    };
    await expect(embedKeyOwnerHasEntitlement(orgKeyNoOrg, KEY)).resolves.toBe(false);
    // Must not fall through to resolving the minter's plan.
    expect(userRepository.findById).not.toHaveBeenCalled();
  });

  it('fails closed when the org has no billing owner', async () => {
    organizationRepository.findById.mockResolvedValue({ id: 'org-1', userId: undefined });
    await expect(embedKeyOwnerHasEntitlement(orgKeyRef, KEY)).resolves.toBe(false);
  });

  it('fails closed when the owner user is not found', async () => {
    organizationRepository.findById.mockResolvedValue({ id: 'org-1', userId: 'owner-9' });
    userRepository.findById.mockResolvedValue(null);
    await expect(embedKeyOwnerHasEntitlement(orgKeyRef, KEY)).resolves.toBe(false);
  });

  it('fails closed when a repository throws', async () => {
    organizationRepository.findById.mockRejectedValue(new Error('db down'));
    await expect(embedKeyOwnerHasEntitlement(orgKeyRef, KEY)).resolves.toBe(false);
  });

  // A lookup fault strips hideBranding behind a 200, so the log line is the only
  // trace it happened. It must fire on the fault - and never on a healthy path,
  // or it becomes noise nobody reads.
  describe('lookup-failure warning', () => {
    it('warns once with the key id and billing owner when the org lookup throws', async () => {
      organizationRepository.findById.mockRejectedValue(new Error('db down'));

      await expect(embedKeyOwnerHasEntitlement(orgKeyRef, KEY, 'key-1')).resolves.toBe(false);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('owner entitlement lookup failed'),
        // The org lookup never returned, so the owner is still the minter.
        expect.objectContaining({ keyId: 'key-1', billingOwner: 'org:org-1', ownerUserId: 'minter-1' })
      );
    });

    it('reports the resolved org owner when the failure is downstream of the org lookup', async () => {
      organizationRepository.findById.mockResolvedValue({ id: 'org-1', userId: 'owner-9' });
      getUserEntitlements.mockRejectedValue(new Error('db down'));

      await expect(embedKeyOwnerHasEntitlement(orgKeyRef, KEY, 'key-1')).resolves.toBe(false);

      expect(warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ billingOwner: 'org:org-1', ownerUserId: 'owner-9' })
      );
    });

    // A user-billed key can carry a stray organizationId; the log must describe
    // the owner resolution actually performed, which keys off billingOwnerType.
    it('reports a user-billed key as user-owned even when it carries an organizationId', async () => {
      userRepository.findById.mockRejectedValue(new Error('db down'));

      await expect(
        embedKeyOwnerHasEntitlement({ userId: 'minter-1', organizationId: 'org-1' }, KEY, 'key-1')
      ).resolves.toBe(false);

      expect(warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ billingOwner: 'user:minter-1', ownerUserId: 'minter-1' })
      );
      expect(organizationRepository.findById).not.toHaveBeenCalled();
    });

    it('marks the key id as unsaved when the caller has none (create path)', async () => {
      userRepository.findById.mockRejectedValue(new Error('db down'));

      await expect(embedKeyOwnerHasEntitlement(userKeyRef, KEY)).resolves.toBe(false);

      expect(warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ keyId: '(unsaved key)', billingOwner: 'user:minter-1' })
      );
    });

    it.each([
      ['the owner is entitled', async () => getUserEntitlements.mockResolvedValue([KEY])],
      ['the owner lacks the entitlement', async () => getUserEntitlements.mockResolvedValue(['other:key'])],
      ['the org has no billing owner', async () => organizationRepository.findById.mockResolvedValue({ userId: null })],
      ['the owner user is not found', async () => userRepository.findById.mockResolvedValue(null)],
    ])('stays silent when %s', async (_label, arrange) => {
      organizationRepository.findById.mockResolvedValue({ id: 'org-1', userId: 'owner-9' });
      await arrange();

      await embedKeyOwnerHasEntitlement(orgKeyRef, KEY, 'key-1');

      expect(warn).not.toHaveBeenCalled();
    });
  });
});
