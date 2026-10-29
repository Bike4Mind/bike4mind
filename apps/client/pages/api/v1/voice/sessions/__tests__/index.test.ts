// @vitest-environment node
import { createModelAdmission } from '@server/billing/meterPlatformCompletion';
vi.mock('@server/billing/meterPlatformCompletion', () => ({
  createModelAdmission: vi.fn(async () => ({
    assert: vi.fn(async (_modelId: string) => {}),
    admits: vi.fn(async (_modelId: string) => true),
  })),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeyScope, TooManyRequestsError } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  signToken: vi.fn(),
  createSession: vi.fn(),
  trustSettings: vi.fn(),
  tokensSince: vi.fn(),
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
}));
vi.mock('@bike4mind/services', () => ({
  sessionService: { createSession: h.createSession },
  userApiKeyService: { loadApiKeyTrustSettings: h.trustSettings },
}));
vi.mock('@server/utils/apiKeyTrust', () => ({ resolveApiKeyTrust: vi.fn() }));
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
  reserveVoiceHold: vi.fn().mockResolvedValue(true),
  settlePriorVoiceHold: vi.fn(),
}));
vi.mock('@server/voice/voiceSessionToken', () => ({ signVoiceSessionToken: h.signToken }));
vi.mock('@server/managers/sessionOrigin', () => ({ resolveSessionOrigin: () => ({ channel: 'api' }) }));

import handler from '../index';

const run = (apiKeyInfo?: { keyId: string; scopes: ApiKeyScope[]; ownerUntrusted?: boolean }) => {
  const json = vi.fn();
  const req = {
    validated: {},
    user: { id: 'owner-1', isAdmin: true, organizationId: undefined },
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
