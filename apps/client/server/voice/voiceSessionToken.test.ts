import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { signVoiceSessionToken, verifyVoiceSessionToken } from './voiceSessionToken';

vi.mock('@server/utils/config', () => ({ Config: { JWT_SECRET: 'test-secret' } }));

const claims = { userId: 'u1', organizationId: '', sessionId: 's1', reasoningModelId: 'm1' };

describe('voice session token authOrigin claim', () => {
  it('round-trips the origin the minting door set', () => {
    const token = signVoiceSessionToken({ ...claims, authOrigin: 'apiKey', apiKeyId: 'k1' }, 60);
    expect(verifyVoiceSessionToken(token)).toEqual(expect.objectContaining({ authOrigin: 'apiKey', apiKeyId: 'k1' }));
  });

  // Tokens minted before the claim existed are still live for their TTL after a deploy.
  const legacy = (extra: Record<string, unknown>) =>
    jwt.sign({ ...claims, ...extra }, 'test-secret', { audience: 'voice-v2-llm-proxy', expiresIn: 60 });

  it('keeps a pre-claim key-minted token a key turn', () => {
    expect(verifyVoiceSessionToken(legacy({ apiKeyId: 'k1' })).authOrigin).toBe('apiKey');
  });

  it('fails a pre-claim token without a key closed to internal, not a session', () => {
    expect(verifyVoiceSessionToken(legacy({})).authOrigin).toBe('internal');
  });
});
