import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { signVoiceSessionToken, verifyVoiceSessionToken } from './voiceSessionToken';

vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { JWT_SECRET: 'test-secret' } }));

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

describe('voice session token apiKeyBillingOwnerType claim', () => {
  it('round-trips the billing owner type of the minting key', () => {
    const token = signVoiceSessionToken(
      { ...claims, authOrigin: 'apiKey', apiKeyId: 'k1', apiKeyBillingOwnerType: 'Organization' },
      60
    );
    expect(verifyVoiceSessionToken(token).apiKeyBillingOwnerType).toBe('Organization');
  });

  it('still verifies a token minted before the claim existed', () => {
    const token = jwt.sign({ ...claims, apiKeyId: 'k1' }, 'test-secret', {
      audience: 'voice-v2-llm-proxy',
      expiresIn: 60,
    });
    expect(verifyVoiceSessionToken(token).apiKeyBillingOwnerType).toBeUndefined();
  });

  it('rejects an unknown billing owner type', () => {
    const token = jwt.sign({ ...claims, apiKeyBillingOwnerType: 'bogus' }, 'test-secret', {
      audience: 'voice-v2-llm-proxy',
      expiresIn: 60,
    });
    expect(() => verifyVoiceSessionToken(token)).toThrow();
  });
});

describe('voice session token trusted file-input admission', () => {
  it.each([false, true])('preserves signed admission %s through verification', allowed => {
    const token = signVoiceSessionToken(
      { ...claims, authOrigin: 'apiKey', apiKeyId: 'k1', fileInputsAllowed: allowed },
      60
    );
    expect(verifyVoiceSessionToken(token).fileInputsAllowed).toBe(allowed);
  });
  it('leaves a legacy key token without affirmative admission', () => {
    const token = jwt.sign({ ...claims, apiKeyId: 'k1' }, 'test-secret', {
      audience: 'voice-v2-llm-proxy',
      expiresIn: 60,
    });
    expect(verifyVoiceSessionToken(token).fileInputsAllowed).toBeUndefined();
  });
});
