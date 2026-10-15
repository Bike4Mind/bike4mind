import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreditHolderType, type IUserDocument } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

const { mockFindById, mockResolveBillingOrgId } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockResolveBillingOrgId: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({ organizationRepository: { findById: mockFindById } }));
vi.mock('@server/utils/orgAccess', () => ({ resolveBillingOrgId: mockResolveBillingOrgId }));
vi.mock('@bike4mind/services', async () => ({
  organizationService: await import('../../../../b4m-core/services/src/organizationService/orgAuthority'),
}));

import { resolveMediaBillingOrgId } from './resolveMediaBillingOrgId';

const KEY_ORG = '64b000000000000000000001';
const OTHER_ORG = '64b000000000000000000002';

const HOME_ORG = '64b000000000000000000003';
const user = { id: 'u1', isAdmin: false, organizationId: HOME_ORG } as unknown as IUserDocument;
const logger = { warn: vi.fn() } as unknown as Logger;
const orgWithMembers = (...userIds: string[]) => ({
  id: KEY_ORG,
  userId: 'owner',
  users: userIds.map(userId => ({ userId })),
});

const orgKeyRequest = {
  user,
  logger,
  apiKeyInfo: { billingOwnerType: CreditHolderType.Organization, organizationId: KEY_ORG },
};

describe('resolveMediaBillingOrgId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue(orgWithMembers('u1'));
    mockResolveBillingOrgId.mockResolvedValue('resolved-by-session-rules');
  });

  describe('an org-billed API key', () => {
    it.each([
      ['no organization', undefined],
      ["the key's own organization", KEY_ORG],
    ])("bills the key's organization when the body names %s", async (_label, requested) => {
      await expect(resolveMediaBillingOrgId(orgKeyRequest, requested)).resolves.toBe(KEY_ORG);
      expect(mockResolveBillingOrgId).not.toHaveBeenCalled();
      expect(mockFindById).toHaveBeenCalledWith(KEY_ORG);
    });

    it.each([
      ['another organization', OTHER_ORG],
      ['personal credits (null)', null],
    ])('refuses a body naming %s with a 403 billing_organization_mismatch', async (_label, requested) => {
      await expect(resolveMediaBillingOrgId(orgKeyRequest, requested)).rejects.toMatchObject({
        statusCode: 403,
        additionalInfo: { errorCode: 'billing_organization_mismatch' },
      });
      expect(mockFindById).not.toHaveBeenCalled();
    });

    it('refuses with a 400 when the organization no longer exists', async () => {
      mockFindById.mockResolvedValue(null);

      await expect(resolveMediaBillingOrgId(orgKeyRequest, undefined)).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/no longer exists/),
      });
      expect(mockFindById).toHaveBeenCalledWith(KEY_ORG);
    });

    it("refuses with a 400 when the key's holder has left the organization", async () => {
      mockFindById.mockResolvedValue(orgWithMembers());

      await expect(resolveMediaBillingOrgId(orgKeyRequest, undefined)).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/no longer a member/),
      });
      expect(mockFindById).toHaveBeenCalledWith(KEY_ORG);
    });

    it("admits a platform admin off the roster, who mints org keys on a customer org's behalf", async () => {
      mockFindById.mockResolvedValue(orgWithMembers());
      const adminRequest = { ...orgKeyRequest, user: { id: 'admin', isAdmin: true } as IUserDocument };

      await expect(resolveMediaBillingOrgId(adminRequest, undefined)).resolves.toBe(KEY_ORG);
    });
  });

  it.each([
    ['a user-billed API key', { billingOwnerType: CreditHolderType.User }],
    ['an org-billed key with no organization id', { billingOwnerType: CreditHolderType.Organization }],
    ['a session caller', undefined],
  ])('leaves %s on the session billing rules', async (_label, apiKeyInfo) => {
    const req = { user, logger, apiKeyInfo };

    await expect(resolveMediaBillingOrgId(req, OTHER_ORG)).resolves.toBe('resolved-by-session-rules');
    expect(mockResolveBillingOrgId).toHaveBeenCalledWith(req, OTHER_ORG);
    expect(mockFindById).not.toHaveBeenCalled();
  });
});
