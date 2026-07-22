import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';

const organizationRepository = vi.hoisted(() => ({ findById: vi.fn() }));
const userRepository = vi.hoisted(() => ({ findById: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ organizationRepository, userRepository }));

const getUserEntitlements = vi.hoisted(() => vi.fn());
vi.mock('./index', () => ({ getUserEntitlements }));

import { embedKeyOwnerHasEntitlement } from './embedKeyEntitlement';

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
});
