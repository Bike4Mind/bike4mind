import { describe, it, expect, vi } from 'vitest';
import { API_KEY_TRUST_REQUIRED_ERROR_CODE, ApiKeyScope, CreditHolderType, ForbiddenError } from '@bike4mind/common';
import {
  ApiKeyTrustAssessment,
  ApiKeyTrustSettings,
  ApiKeyTrustSubject,
  assessApiKeyTrust,
  describeApiKeyTrustRequirement,
} from '../trust';
import {
  API_KEY_USER_CAP_ERROR_CODE,
  createExchangeUserApiKey,
  createUserApiKey,
  MAX_ACTIVE_KEYS_PER_USER,
} from '../create';

vi.mock('bcryptjs', async () => {
  const { bcryptMockFactory } = await import('./helpers/bcryptMock');
  return bcryptMockFactory();
});

const NOW = new Date('2026-10-23T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const SETTINGS: ApiKeyTrustSettings = {
  gateEnabled: true,
  minAccountAgeDays: 7,
  maxActiveKeysUntrusted: 1,
  untrustedRateLimitPerMinute: 20,
};

const youngVerifiedUser = (overrides: Partial<ApiKeyTrustSubject> = {}): ApiKeyTrustSubject => ({
  isAdmin: false,
  emailVerified: true,
  apiKeyTrustApproved: false,
  lastCreditsPurchasedAt: null,
  createdAt: new Date(NOW.getTime() - DAY_MS),
  ...overrides,
});

const assess = (user: ApiKeyTrustSubject, options: { settings?: ApiKeyTrustSettings; hasActivePlan?: boolean } = {}) =>
  assessApiKeyTrust(user, {
    settings: options.settings ?? SETTINGS,
    hasActivePlan: async () => options.hasActivePlan ?? false,
    now: NOW,
  });

describe('assessApiKeyTrust', () => {
  it('trusts everyone when the gate is off', async () => {
    const result = await assess(youngVerifiedUser({ emailVerified: false }), {
      settings: { ...SETTINGS, gateEnabled: false },
    });
    expect(result).toEqual({ status: 'trusted' });
  });

  it('refuses an unverified email even when every other condition holds', async () => {
    const user = youngVerifiedUser({ emailVerified: false, apiKeyTrustApproved: true, lastCreditsPurchasedAt: NOW });
    expect(await assess(user, { hasActivePlan: true })).toEqual({ status: 'untrusted', reason: 'email_unverified' });
  });

  it('marks a verified, young, free, unapproved account not yet trusted', async () => {
    expect(await assess(youngVerifiedUser())).toEqual({
      status: 'untrusted',
      reason: 'not_yet_trusted',
      maxActiveKeys: 1,
      trustedAfter: new Date(NOW.getTime() + 6 * DAY_MS),
    });
  });

  it.each([
    ['a past purchase', youngVerifiedUser({ lastCreditsPurchasedAt: new Date() }), false],
    ['an active plan', youngVerifiedUser(), true],
    ['admin approval', youngVerifiedUser({ apiKeyTrustApproved: true }), false],
    ['account age at the threshold', youngVerifiedUser({ createdAt: new Date(NOW.getTime() - 7 * DAY_MS) }), false],
    ['a legacy account with no createdAt', youngVerifiedUser({ createdAt: undefined }), false],
    ['a platform admin', youngVerifiedUser({ isAdmin: true, emailVerified: false }), false],
  ])('trusts %s', async (_label, user, hasActivePlan) => {
    expect(await assess(user, { hasActivePlan })).toEqual({ status: 'trusted' });
  });

  it('skips the plan lookup when a cheap field already settles trust', async () => {
    const hasActivePlan = vi.fn().mockResolvedValue(false);
    await assessApiKeyTrust(youngVerifiedUser({ apiKeyTrustApproved: true }), { settings: SETTINGS, hasActivePlan });
    await assessApiKeyTrust(youngVerifiedUser({ emailVerified: false }), { settings: SETTINGS, hasActivePlan });
    expect(hasActivePlan).not.toHaveBeenCalled();
  });
});

describe('describeApiKeyTrustRequirement', () => {
  const trustedAfter = new Date('2026-10-29T12:00:00Z');

  it('asks an unverified account to verify its email', () => {
    expect(describeApiKeyTrustRequirement({ status: 'untrusted', reason: 'email_unverified' })).toBe(
      'Verify your email address to create API keys.'
    );
  });

  it('names the key allowance and every unlock path', () => {
    const message = describeApiKeyTrustRequirement({
      status: 'untrusted',
      reason: 'not_yet_trusted',
      maxActiveKeys: 1,
      trustedAfter,
    });
    expect(message).toBe(
      'New accounts may hold 1 active API key. To create more, purchase credits or a plan, wait until 2026-10-29, or contact support.'
    );
  });

  it('says keys are unavailable when the untrusted allowance is zero', () => {
    const message = describeApiKeyTrustRequirement({
      status: 'untrusted',
      reason: 'not_yet_trusted',
      maxActiveKeys: 0,
      trustedAfter,
    });
    expect(message).toMatch(/^New accounts cannot create API keys yet\./);
  });
});

describe('createUserApiKey trust gate', () => {
  const docImpl = (doc: Record<string, unknown>) => ({ ...doc, id: 'key-1', createdAt: new Date() });
  const makeRepo = (createIfUnderCap = vi.fn().mockImplementation(docImpl)) => ({
    create: vi.fn().mockImplementation(docImpl),
    createIfUnderCap,
  });
  const params = { name: 'k', scopes: [ApiKeyScope.AI_CHAT], metadata: { createdFrom: 'dashboard' as const } };
  const notYetTrusted = (maxActiveKeys: number): ApiKeyTrustAssessment => ({
    status: 'untrusted',
    reason: 'not_yet_trusted',
    maxActiveKeys,
    trustedAfter: new Date('2026-10-29T00:00:00Z'),
  });
  // Only the repo members the mint touches are stubbed.
  const adapters = (repo: ReturnType<typeof makeRepo>, trust?: ApiKeyTrustAssessment, systemUserId = 'sys-1') =>
    ({ db: { userApiKeys: repo }, systemUserId, trust }) as unknown as Parameters<typeof createUserApiKey>[2];

  const mintError = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: unknown) => error as ForbiddenError
    );

  it('rejects an unverified account with 403 api_key_trust_required before inserting', async () => {
    const repo = makeRepo();
    const error = await mintError(
      createUserApiKey('user-1', params, adapters(repo, { status: 'untrusted', reason: 'email_unverified' }))
    );
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error?.statusCode).toBe(403);
    expect(error?.additionalInfo).toEqual({
      errorCode: API_KEY_TRUST_REQUIRED_ERROR_CODE,
      trustReason: 'email_unverified',
    });
    expect(repo.createIfUnderCap).not.toHaveBeenCalled();
  });

  it('caps a not-yet-trusted account at its untrusted allowance', async () => {
    const repo = makeRepo();
    await createUserApiKey('user-1', params, adapters(repo, notYetTrusted(1)));
    expect(repo.createIfUnderCap).toHaveBeenCalledWith(expect.anything(), 1, 'standard');
  });

  it('reports the trust code, not the generic cap code, when the untrusted allowance is used up', async () => {
    const repo = makeRepo(vi.fn().mockResolvedValue('at_cap'));
    const error = await mintError(createUserApiKey('user-1', params, adapters(repo, notYetTrusted(1))));
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error?.additionalInfo).toEqual({
      errorCode: API_KEY_TRUST_REQUIRED_ERROR_CODE,
      trustReason: 'not_yet_trusted',
      maxActiveKeys: 1,
      trustedAfter: '2026-10-29T00:00:00.000Z',
    });
  });

  it('blocks outright when the untrusted allowance is zero', async () => {
    const repo = makeRepo();
    const error = await mintError(createUserApiKey('user-1', params, adapters(repo, notYetTrusted(0))));
    expect(error?.additionalInfo).toMatchObject({ errorCode: API_KEY_TRUST_REQUIRED_ERROR_CODE });
    expect(repo.createIfUnderCap).not.toHaveBeenCalled();
  });

  it.each([
    ['trusted', { status: 'trusted' }],
    ['exempt', { status: 'exempt' }],
  ] as const)('gives a %s account the normal per-user cap', async (_label, trust) => {
    const repo = makeRepo(vi.fn().mockResolvedValue('at_cap'));
    const error = await mintError(createUserApiKey('user-1', params, adapters(repo, trust)));
    expect(repo.createIfUnderCap).toHaveBeenCalledWith(expect.anything(), MAX_ACTIVE_KEYS_PER_USER, 'standard');
    expect(error?.additionalInfo).toEqual({ errorCode: API_KEY_USER_CAP_ERROR_CODE });
  });

  it('exempts org-billed keys: the route already authorized the org admin', async () => {
    const repo = makeRepo();
    await createUserApiKey(
      'user-1',
      { ...params, organizationId: 'org-1', billingOwnerType: CreditHolderType.Organization },
      adapters(repo, { status: 'untrusted', reason: 'email_unverified' })
    );
    expect(repo.createIfUnderCap).toHaveBeenCalledWith(expect.anything(), MAX_ACTIVE_KEYS_PER_USER, 'standard');
  });

  it('exempts the system user', async () => {
    const repo = makeRepo();
    await createUserApiKey('sys-1', params, adapters(repo, { status: 'untrusted', reason: 'email_unverified' }));
    expect(repo.create).toHaveBeenCalled();
  });

  it('does not gate the oauth-exchange pool', async () => {
    const repo = makeRepo();
    await createExchangeUserApiKey(
      'user-1',
      {
        name: 'federated',
        scopes: [ApiKeyScope.AI_GENERATE],
        expiresAt: new Date(Date.now() + 60_000),
        metadata: { oauthClientId: 'client-a' },
      },
      adapters(repo)
    );
    expect(repo.createIfUnderCap).toHaveBeenCalledWith(expect.anything(), expect.any(Number), 'oauth-exchange');
  });

  it('fails closed when a caller omits the assessment', async () => {
    const repo = makeRepo();
    await expect(createUserApiKey('user-1', params, adapters(repo))).rejects.toThrow(
      'createUserApiKey requires a trust assessment'
    );
    expect(repo.createIfUnderCap).not.toHaveBeenCalled();
  });
});
