import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyScope, ForbiddenError } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  findOrg: vi.fn(),
  findAccessibleById: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: mocks.findUser },
  organizationRepository: {
    findById: mocks.findOrg,
    shareable: { findAccessibleById: mocks.findAccessibleById },
  },
}));

import { resolveCompletionBillingOrgId } from './resolveCompletionBillingOrgId';

const ORG_ID = '64b7f0c2a1b2c3d4e5f60718';

describe('resolveCompletionBillingOrgId - a platform admin naming an organization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUser.mockImplementation(async () => ({ id: 'admin-1', isAdmin: true }));
    mocks.findOrg.mockResolvedValue({ id: ORG_ID });
    mocks.findAccessibleById.mockResolvedValue(null);
  });

  it('requires membership when the key does not hold admin:*', async () => {
    await expect(
      resolveCompletionBillingOrgId({
        apiKeyInfo: { scopes: [ApiKeyScope.AI_CHAT] },
        requestedOrgId: ORG_ID,
        userId: 'admin-1',
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.findAccessibleById).toHaveBeenCalled();
  });

  it('lets a member bill the organization through a key without admin:*', async () => {
    mocks.findAccessibleById.mockResolvedValue({ id: ORG_ID });

    await expect(
      resolveCompletionBillingOrgId({
        apiKeyInfo: { scopes: [ApiKeyScope.AI_CHAT] },
        requestedOrgId: ORG_ID,
        userId: 'admin-1',
      })
    ).resolves.toBe(ORG_ID);
  });

  it('keeps the admin role for a key holding admin:*', async () => {
    await expect(
      resolveCompletionBillingOrgId({
        apiKeyInfo: { scopes: [ApiKeyScope.ADMIN] },
        requestedOrgId: ORG_ID,
        userId: 'admin-1',
      })
    ).resolves.toBe(ORG_ID);
    expect(mocks.findAccessibleById).not.toHaveBeenCalled();
  });

  it('keeps the admin role for a signed-in caller', async () => {
    await expect(
      resolveCompletionBillingOrgId({ apiKeyInfo: undefined, requestedOrgId: ORG_ID, userId: 'admin-1' })
    ).resolves.toBe(ORG_ID);
  });
});
