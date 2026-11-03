import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
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

import '@pages/api/user-api-keys/eligibility';

type Assessment = userApiKeyService.ApiKeyTrustAssessment;

const notYetTrusted = (maxActiveKeys: number): Assessment => ({
  status: 'untrusted',
  reason: 'not_yet_trusted',
  maxActiveKeys,
  trustedAfter: new Date('2026-10-29T00:00:00Z'),
});

const callEligibility = async (assessment: Assessment) => {
  resolveApiKeyTrust.mockResolvedValue({ assessment });
  const { req, res } = createMocks({ method: 'GET' });
  Object.assign(req, { user: { id: 'u1' } });
  await mockRefs.getHandler!(req, res);
  return res._getJSONData() as { canCreate: boolean; message: string | null };
};

describe('GET /api/user-api-keys/eligibility', () => {
  beforeEach(() => {
    countActiveByUserId.mockReset();
    resolveApiKeyTrust.mockReset();
  });

  it('lets a trusted account create without counting keys', async () => {
    expect(await callEligibility({ status: 'trusted' })).toEqual({ canCreate: true, message: null });
    expect(countActiveByUserId).not.toHaveBeenCalled();
  });

  it('lets a not-yet-trusted account with room create, counting personal keys only', async () => {
    countActiveByUserId.mockResolvedValue(0);
    expect(await callEligibility(notYetTrusted(1))).toEqual({ canCreate: true, message: null });
    expect(countActiveByUserId).toHaveBeenCalledWith('u1', 'personal');
  });

  it('refuses a not-yet-trusted account at its allowance with the requirement message', async () => {
    countActiveByUserId.mockResolvedValue(1);
    const assessment = notYetTrusted(1);
    if (assessment.status !== 'untrusted') throw new Error('unreachable');
    expect(await callEligibility(assessment)).toEqual({
      canCreate: false,
      message: userApiKeyService.describeApiKeyTrustRequirement(assessment),
    });
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
