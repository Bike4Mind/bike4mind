// @vitest-environment node
import { createModelAdmission } from '@bike4mind/server-utils/billing/meterPlatformCompletion';
vi.mock('@bike4mind/server-utils/billing/meterPlatformCompletion', () => ({
  createModelAdmission: vi.fn(async () => ({
    assert: vi.fn(async (_modelId: string) => {}),
    admits: vi.fn(async (_modelId: string) => true),
  })),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeyScope, CreditHolderType, TooManyRequestsError } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  signToken: vi.fn(),
  createSession: vi.fn(),
  trustSettings: vi.fn(),
  tokensSince: vi.fn(),
  findFreeze: vi.fn(),
  reserve: vi.fn(),
}));

vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: () => ({ post: (fn: unknown) => fn }),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  agentRepository: {
    findDefaultVoiceAgent: vi.fn().mockResolvedValue({ type: 'voice', elevenLabsAgentId: 'agent-1' }),
  },
  fabFileRepository: {},
  projectRepository: {},
  sessionRepository: { countActiveVoiceSessionsByUserId: vi.fn().mockResolvedValue(0) },
  usageEventRepository: { userTokensSince: h.tokensSince },
  spendFreezeRepository: { findActiveForSubject: h.findFreeze },
}));
vi.mock('@bike4mind/services', () => ({
  sessionService: { createSession: h.createSession },
  userApiKeyService: { loadApiKeyTrustSettings: h.trustSettings },
}));
vi.mock('@bike4mind/server-utils/utils/apiKeyTrust', () => ({ resolveApiKeyTrust: vi.fn() }));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: (name: string) => ({ voiceV2Enabled: true, elevenLabsServerApiKey: 'el-key' })[name],
}));
vi.mock('@bike4mind/voice', () => ({
  createElevenLabsConversationalTransport: () => ({
    estimateCost: () => ({ creditsToReserve: 1 }),
    createSession: vi.fn().mockResolvedValue({ clientBootstrap: {} }),
  }),
}));
vi.mock('@bike4mind/server-utils/voice/settleVoiceHold', () => ({
  reserveVoiceHold: h.reserve,
  settlePriorVoiceHold: vi.fn(),
}));
vi.mock('@server/voice/voiceSessionToken', () => ({ signVoiceSessionToken: h.signToken }));
vi.mock('@server/managers/sessionOrigin', () => ({ resolveSessionOrigin: () => ({ channel: 'api' }) }));

import handler from '../index';

const run = (apiKeyInfo?: {
  keyId: string;
  scopes: ApiKeyScope[];
  ownerUntrusted?: boolean;
  billingOwnerType?: CreditHolderType;
  organizationId?: string;
}) => {
  const json = vi.fn();
  const req = {
    validated: {},
    user: { id: 'owner-1', isAdmin: true, organizationId: 'home-org' },
    apiKeyInfo,
    logger: { error: vi.fn() },
  };
  return (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, {
    status: () => ({ json }),
  });
};

const mintedClaims = () => h.signToken.mock.calls[0][0] as { adminRoleWithheld?: boolean };

describe('POST /api/v1/voice/sessions - admin role in the session token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.signToken.mockReturnValue('signed');
    h.createSession.mockResolvedValue({ id: 'session-1', name: 'Voice' });
    h.trustSettings.mockResolvedValue({ gateEnabled: false });
    h.findFreeze.mockResolvedValue(null);
    h.reserve.mockResolvedValue(true);
  });

  it('refuses the voice transport even when the reasoning model would be admitted', async () => {
    const refusal = new Error('paid plan required');
    const assertAdmission = vi.fn(async (modelId: string) => {
      if (modelId === 'elevenlabs') throw refusal;
    });
    vi.mocked(createModelAdmission).mockResolvedValueOnce({ assert: assertAdmission, admits: async () => true });
    await expect(run()).rejects.toBe(refusal);
    expect(assertAdmission).toHaveBeenCalledWith('elevenlabs');
    expect(createModelAdmission).toHaveBeenCalledWith(expect.objectContaining({ id: 'owner-1' }));
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.signToken).not.toHaveBeenCalled();
  });

  it.each([false, true])('signs trusted file-input admission %s for a key', async allowed => {
    await run({ keyId: 'key-1', scopes: [ApiKeyScope.AI_GENERATE, ...(allowed ? [ApiKeyScope.READ_FILES] : [])] });
    expect(h.signToken.mock.calls[0][0]).toEqual(expect.objectContaining({ fileInputsAllowed: allowed }));
  });

  it('admits file inputs for a signed-in voice session', async () => {
    await run();
    expect(h.signToken.mock.calls[0][0]).toEqual(expect.objectContaining({ fileInputsAllowed: true }));
  });

  it('marks the role withheld for a key without the admin scope', async () => {
    await run({ keyId: 'key-1', scopes: [ApiKeyScope.AI_GENERATE] });
    expect(mintedClaims().adminRoleWithheld).toBe(true);
  });

  it('leaves the claim off for a key holding the admin scope', async () => {
    await run({ keyId: 'key-1', scopes: [ApiKeyScope.AI_GENERATE, ApiKeyScope.ADMIN] });
    expect(mintedClaims().adminRoleWithheld).toBeUndefined();
  });

  it('leaves the claim off for a signed-in session', async () => {
    await run();
    expect(mintedClaims().adminRoleWithheld).toBeUndefined();
  });
});

describe('POST /api/v1/voice/sessions - untrusted API key owner quota', () => {
  const untrustedKey = { keyId: 'key-1', scopes: [ApiKeyScope.AI_GENERATE], ownerUntrusted: true };

  beforeEach(() => {
    vi.clearAllMocks();
    h.signToken.mockReturnValue('signed');
    h.createSession.mockResolvedValue({ id: 'session-1', name: 'Voice' });
    h.trustSettings.mockResolvedValue({ gateEnabled: true, untrustedTokensPerMinute: 1000, untrustedMaxConcurrent: 2 });
  });

  it('refuses an untrusted owner over the token window before opening a session or signing a token', async () => {
    h.tokensSince.mockResolvedValue({ tokens: 1000, oldestAt: new Date(Date.now() - 30_000) });
    const refusal = await run(untrustedKey).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(TooManyRequestsError);
    expect(refusal).toMatchObject({
      statusCode: 429,
      additionalInfo: { errorCode: 'token_rate_limit_exceeded', retryAfter: 30 },
    });
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.signToken).not.toHaveBeenCalled();
  });

  it('admits an untrusted owner under the token window', async () => {
    h.tokensSince.mockResolvedValue({ tokens: 999 });
    await run(untrustedKey);
    expect(h.tokensSince).toHaveBeenCalledWith('owner-1', expect.any(Date));
    expect(h.signToken).toHaveBeenCalledOnce();
  });

  it('does not check a signed-in session', async () => {
    await run();
    expect(h.trustSettings).not.toHaveBeenCalled();
    expect(h.tokensSince).not.toHaveBeenCalled();
    expect(h.signToken).toHaveBeenCalledOnce();
  });
});

describe('POST /api/v1/voice/sessions - spend freeze', () => {
  const frozen = { scopeType: 'User', frozenAt: new Date('2026-01-01T00:00:00Z'), reason: 'test freeze' };
  const key = { keyId: 'key-1', scopes: [ApiKeyScope.AI_GENERATE] };

  beforeEach(() => {
    vi.clearAllMocks();
    h.signToken.mockReturnValue('signed');
    h.createSession.mockResolvedValue({ id: 'session-1', name: 'Voice' });
    h.trustSettings.mockResolvedValue({ gateEnabled: false });
    h.findFreeze.mockResolvedValue(null);
    h.reserve.mockResolvedValue(true);
  });

  it('refuses a frozen caller with 403 spend_frozen before the model admission, a session or a token', async () => {
    h.findFreeze.mockResolvedValue(frozen);
    const refusal = await run(key).catch((e: unknown) => e);
    expect(refusal).toMatchObject({ statusCode: 403, additionalInfo: { errorCode: 'spend_frozen' } });
    expect(h.findFreeze).toHaveBeenCalledWith({ userId: 'owner-1', organizationId: 'home-org', apiKeyId: 'key-1' });
    expect(createModelAdmission).not.toHaveBeenCalled();
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.signToken).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled();
  });

  it('does not put the freeze reason in the refusal', async () => {
    h.findFreeze.mockResolvedValue(frozen);
    const refusal = await run(key).catch((e: unknown) => e);
    expect(JSON.stringify(refusal)).not.toContain('test freeze');
  });

  it('lets a freeze read error propagate', async () => {
    h.findFreeze.mockRejectedValue(new Error('db down'));
    await expect(run(key)).rejects.toThrow('db down');
    expect(h.signToken).not.toHaveBeenCalled();
  });

  it('checks the key and its user for an org-billed key, and mints the billing owner type', async () => {
    await run({ ...key, billingOwnerType: CreditHolderType.Organization, organizationId: 'key-org' });
    expect(h.findFreeze).toHaveBeenCalledWith({ userId: 'owner-1', organizationId: 'key-org', apiKeyId: 'key-1' });
    expect(h.signToken.mock.calls[0][0]).toMatchObject({ apiKeyBillingOwnerType: CreditHolderType.Organization });
    expect(h.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ apiKeyBillingOwnerType: CreditHolderType.Organization, apiKeyId: 'key-1' })
    );
  });

  it('leaves the claim off when the key carries no billing owner type', async () => {
    await run(key);
    expect(h.signToken.mock.calls[0][0]).not.toHaveProperty('apiKeyBillingOwnerType');
  });

  it('refuses a member whose home organization is frozen, since the proxy bills that org on every turn', async () => {
    h.findFreeze.mockImplementation(async (subject: { organizationId: string | null }) =>
      subject.organizationId === 'home-org' ? { ...frozen, scopeType: 'Organization' } : null
    );
    const refusal = await run(key).catch((e: unknown) => e);
    expect(refusal).toMatchObject({ statusCode: 403, additionalInfo: { errorCode: 'spend_frozen' } });
    expect(h.findFreeze).toHaveBeenCalledWith({ userId: 'owner-1', organizationId: 'home-org', apiKeyId: 'key-1' });
    expect(h.signToken).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled();
  });

  it('refuses 403 spend_frozen for an org-billed key whose org is frozen', async () => {
    h.findFreeze.mockImplementation(async (subject: { organizationId: string | null }) =>
      subject.organizationId === 'key-org' ? { ...frozen, scopeType: 'Organization' } : null
    );
    const refusal = await run({
      ...key,
      billingOwnerType: CreditHolderType.Organization,
      organizationId: 'key-org',
    }).catch((e: unknown) => e);
    expect(refusal).toMatchObject({ statusCode: 403, additionalInfo: { errorCode: 'spend_frozen' } });
    expect(h.findFreeze).toHaveBeenCalledWith({ userId: 'owner-1', organizationId: 'key-org', apiKeyId: 'key-1' });
    expect(h.signToken).not.toHaveBeenCalled();
  });

  // The proxy turn checks the org it reserves against, so the token carries no separate freeze org.
  it('reserves the voice-minutes hold against the key org and mints no freeze org claim', async () => {
    await run({ ...key, billingOwnerType: CreditHolderType.Organization, organizationId: 'key-org' });
    expect(h.signToken.mock.calls[0][0]).not.toHaveProperty('billingOrganizationId');
    expect(h.reserve).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'key-org' }));
  });
});
