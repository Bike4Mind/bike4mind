import { describe, it, expect, afterEach } from 'vitest';
import { ModelBackend } from '@bike4mind/common';
import { isBackendUsable, resolveListingKey } from './backendGate';

const savedUrl = process.env.IMAGE_GEN_BASE_URL;

afterEach(() => {
  if (savedUrl === undefined) delete process.env.IMAGE_GEN_BASE_URL;
  else process.env.IMAGE_GEN_BASE_URL = savedUrl;
});

describe('resolveListingKey', () => {
  it('resolves a keyed backend only when the caller has a key', () => {
    expect(
      resolveListingKey(ModelBackend.XAI, { apiKeys: { xai: 'k' }, isSelfHost: false, bedrockReachable: true })
    ).toBe('k');
    expect(
      resolveListingKey(ModelBackend.XAI, { apiKeys: { xai: null }, isSelfHost: false, bedrockReachable: true })
    ).toBeNull();
    expect(
      resolveListingKey(ModelBackend.XAI, { apiKeys: null, isSelfHost: false, bedrockReachable: true })
    ).toBeNull();
  });

  it('resolves BFL only from a real key, never a demo-key stand-in', () => {
    // A 'demo-key' fallback here listed the Flux models on a keyless deployment, and the
    // client then defaulted image generation to one of them - a guaranteed provider 403.
    expect(
      resolveListingKey(ModelBackend.BFL, { apiKeys: null, isSelfHost: false, bedrockReachable: true })
    ).toBeNull();
    expect(
      resolveListingKey(ModelBackend.BFL, { apiKeys: { bfl: null }, isSelfHost: true, bedrockReachable: false })
    ).toBeNull();
    expect(
      resolveListingKey(ModelBackend.BFL, { apiKeys: { bfl: 'real' }, isSelfHost: false, bedrockReachable: true })
    ).toBe('real');
  });

  it('honors the local-image env fallback only under self-host', () => {
    process.env.IMAGE_GEN_BASE_URL = 'http://imagegen:7860';
    expect(
      resolveListingKey(ModelBackend.LocalImage, { apiKeys: null, isSelfHost: false, bedrockReachable: true })
    ).toBeNull();
    expect(
      resolveListingKey(ModelBackend.LocalImage, { apiKeys: null, isSelfHost: true, bedrockReachable: false })
    ).toBe('http://imagegen:7860');
    // An explicit table entry wins over the env in either mode.
    expect(
      resolveListingKey(ModelBackend.LocalImage, {
        apiKeys: { [ModelBackend.LocalImage]: 'http://other:7860' },
        isSelfHost: false,
        bedrockReachable: true,
      })
    ).toBe('http://other:7860');
  });
});

describe('isBackendUsable', () => {
  it('treats the keyless backends as listable without a key', () => {
    expect(isBackendUsable(ModelBackend.Bedrock, { apiKeys: null, isSelfHost: false, bedrockReachable: true })).toBe(
      true
    );
    expect(isBackendUsable(ModelBackend.AWS, { apiKeys: null, isSelfHost: false, bedrockReachable: true })).toBe(true);
  });

  it('withholds the AWS-credentialed backends under self-host', () => {
    expect(isBackendUsable(ModelBackend.Bedrock, { apiKeys: null, isSelfHost: true, bedrockReachable: false })).toBe(
      false
    );
    expect(isBackendUsable(ModelBackend.AWS, { apiKeys: null, isSelfHost: true, bedrockReachable: false })).toBe(false);
  });

  it('lists Bedrock under self-host only with Bedrock credentials, and AWS never', () => {
    expect(isBackendUsable(ModelBackend.Bedrock, { apiKeys: null, isSelfHost: true, bedrockReachable: true })).toBe(
      true
    );
    expect(isBackendUsable(ModelBackend.AWS, { apiKeys: null, isSelfHost: true, bedrockReachable: true })).toBe(false);
  });

  it('fails closed for a backend this build cannot list at all', () => {
    // VoyageAI has no entry in the getAvailableModels fan-out, so no caller can
    // list it and a catalog row naming it must never be emitted.
    expect(
      isBackendUsable(ModelBackend.VoyageAI, { apiKeys: { voyageai: 'k' }, isSelfHost: false, bedrockReachable: true })
    ).toBe(false);
    expect(isBackendUsable('some-future-backend', { apiKeys: null, isSelfHost: false, bedrockReachable: true })).toBe(
      false
    );
  });

  it('tracks the caller key for every keyed backend', () => {
    for (const backend of [
      ModelBackend.OpenAI,
      ModelBackend.Anthropic,
      ModelBackend.Gemini,
      ModelBackend.Ollama,
      ModelBackend.XAI,
      ModelBackend.BFL,
    ]) {
      expect(isBackendUsable(backend, { apiKeys: null, isSelfHost: false, bedrockReachable: true })).toBe(false);
      expect(isBackendUsable(backend, { apiKeys: { [backend]: 'k' }, isSelfHost: false, bedrockReachable: true })).toBe(
        true
      );
    }
  });
});
