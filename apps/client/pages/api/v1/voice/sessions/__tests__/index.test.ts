// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';

const h = vi.hoisted(() => ({ signToken: vi.fn(), createSession: vi.fn() }));

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
}));
vi.mock('@bike4mind/services', () => ({ sessionService: { createSession: h.createSession } }));
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

const run = (apiKeyInfo?: { keyId: string; scopes: ApiKeyScope[] }) => {
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
