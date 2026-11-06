import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { CreditHolderType } from '@bike4mind/common';
import { userApiKeyService } from '@bike4mind/services';

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    get: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const countActiveByUserId = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: { countActiveByUserId } }));

const resolveApiKeyTrust = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/apiKeyTrust', () => ({ resolveApiKeyTrust }));

const findIdsAdministeredBy = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({ organizationRepository: { findIdsAdministeredBy } }));

const isApiKeyAccessAllowed = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/apiKeyAccessGate', () => ({
  API_KEY_ACCESS_DENIED_MESSAGE: 'API keys require an active paid subscription',
  isApiKeyAccessAllowed,
}));

import '@pages/api/user-api-keys/eligibility';

type Assessment = userApiKeyService.ApiKeyTrustAssessment;

const notYetTrusted = (maxActiveKeys: number): Assessment => ({
  status: 'untrusted',
  reason: 'not_yet_trusted',
  maxActiveKeys,
  trustedAfter: new Date('2026-10-29T00:00:00Z'),
});

const paidStandingRequired = (maxActiveKeys: number): Assessment => ({
  status: 'untrusted',
  reason: 'paid_standing_required',
  maxActiveKeys,
});

const callEligibility = async (assessment: Assessment) => {
  resolveApiKeyTrust.mockResolvedValue({ assessment });
  const { req, res } = createMocks({ method: 'GET' });
  Object.assign(req, { user: { id: 'u1' } });
  await mockRefs.getHandler!(req, res);
  return res._getJSONData() as { canCreate: boolean; message: string | null; refusedOrgIds: string[] };
};

describe('GET /api/user-api-keys/eligibility', () => {
  beforeEach(() => {
    countActiveByUserId.mockReset();
    findIdsAdministeredBy.mockReset();
    resolveApiKeyTrust.mockReset();
    isApiKeyAccessAllowed.mockReset().mockResolvedValue(true);
  });

  it('refuses with the access message when the access switch refuses, before checking trust', async () => {
    findIdsAdministeredBy.mockResolvedValue([]);
    isApiKeyAccessAllowed.mockResolvedValue(false);
    expect(await callEligibility({ status: 'trusted' })).toEqual({
      canCreate: false,
      message: 'API keys require an active paid subscription',
      refusedOrgIds: [],
    });
    expect(isApiKeyAccessAllowed).toHaveBeenCalledWith({ id: 'u1' }, undefined, expect.anything());
    expect(resolveApiKeyTrust).not.toHaveBeenCalled();
  });

  it('reports only the refused org when the switch admits a key billed to another administered org', async () => {
    findIdsAdministeredBy.mockResolvedValue(['org-free', 'org-paid']);
    isApiKeyAccessAllowed.mockImplementation(async (_user, billing?: { organizationId?: string }) => {
      return billing?.organizationId === 'org-paid';
    });
    const result = await callEligibility({ status: 'trusted' });
    expect(result).toMatchObject({ canCreate: false, refusedOrgIds: ['org-free'] });
    expect(findIdsAdministeredBy).toHaveBeenCalledWith('u1');
    expect(isApiKeyAccessAllowed).toHaveBeenCalledWith(
      { id: 'u1' },
      { billingOwnerType: CreditHolderType.Organization, organizationId: 'org-free' },
      expect.anything()
    );
  });

  it('reports every administered org when the switch refuses them all', async () => {
    findIdsAdministeredBy.mockResolvedValue(['org-a', 'org-b']);
    isApiKeyAccessAllowed.mockResolvedValue(false);
    expect(await callEligibility({ status: 'trusted' })).toMatchObject({
      canCreate: false,
      refusedOrgIds: ['org-a', 'org-b'],
    });
  });

  it('propagates an access-switch read failure without checking trust', async () => {
    isApiKeyAccessAllowed.mockRejectedValue(new Error('settings read failed'));
    await expect(callEligibility({ status: 'trusted' })).rejects.toThrow('settings read failed');
    expect(resolveApiKeyTrust).not.toHaveBeenCalled();
  });

  it('lets a trusted account create without counting keys', async () => {
    expect(await callEligibility({ status: 'trusted' })).toEqual({
      canCreate: true,
      message: null,
      refusedOrgIds: [],
    });
    expect(countActiveByUserId).not.toHaveBeenCalled();
  });

  it('lets a not-yet-trusted account with room create, counting personal keys only', async () => {
    countActiveByUserId.mockResolvedValue(0);
    expect(await callEligibility(notYetTrusted(1))).toEqual({
      canCreate: true,
      message: null,
      refusedOrgIds: [],
    });
    expect(countActiveByUserId).toHaveBeenCalledWith('u1', 'personal');
  });

  it('refuses a not-yet-trusted account at its allowance with the requirement message', async () => {
    countActiveByUserId.mockResolvedValue(1);
    const assessment = notYetTrusted(1);
    if (assessment.status !== 'untrusted') throw new Error('unreachable');
    expect(await callEligibility(assessment)).toEqual({
      canCreate: false,
      message: userApiKeyService.describeApiKeyTrustRequirement(assessment),
      refusedOrgIds: [],
    });
  });

  it('lets a free account with room under its allowance create, counting personal keys only', async () => {
    countActiveByUserId.mockResolvedValue(0);
    expect(await callEligibility(paidStandingRequired(1))).toEqual({
      canCreate: true,
      message: null,
      refusedOrgIds: [],
    });
    expect(countActiveByUserId).toHaveBeenCalledWith('u1', 'personal');
  });

  it('refuses a free account at its allowance with the paid-standing message', async () => {
    countActiveByUserId.mockResolvedValue(1);
    expect(await callEligibility(paidStandingRequired(1))).toEqual({
      canCreate: false,
      message:
        'Free accounts may hold 1 active API key. To create more, purchase credits or a plan, or contact support.',
      refusedOrgIds: [],
    });
    expect(countActiveByUserId).toHaveBeenCalledWith('u1', 'personal');
  });

  it('refuses when the untrusted allowance is zero', async () => {
    countActiveByUserId.mockResolvedValue(0);
    const result = await callEligibility(notYetTrusted(0));
    expect(result.canCreate).toBe(false);
    expect(result.message).toMatch(/cannot create API keys yet/);
  });

  it('refuses an unverified email without counting keys', async () => {
    const result = await callEligibility({ status: 'untrusted', reason: 'email_unverified' });
    expect(result.canCreate).toBe(false);
    expect(result.message).toBe('Verify your email address to create API keys.');
    expect(countActiveByUserId).not.toHaveBeenCalled();
  });
});
