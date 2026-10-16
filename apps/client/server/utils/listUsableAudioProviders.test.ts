import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getEffectiveApiKey } = vi.hoisted(() => ({ getEffectiveApiKey: vi.fn() }));

vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveApiKey: (...args: unknown[]) => getEffectiveApiKey(...args) },
}));
vi.mock('@bike4mind/database', () => ({ apiKeyRepository: {}, adminSettingsRepository: {} }));

import { ApiKeyType } from '@bike4mind/common';
import { listUsableAudioProviders } from './listUsableAudioProviders';

const keysFor = (keyed: ApiKeyType[]) =>
  getEffectiveApiKey.mockImplementation(async (_userId: string, { type }: { type: ApiKeyType }) =>
    keyed.includes(type) ? `${type}-key` : null
  );

beforeEach(() => {
  getEffectiveApiKey.mockReset();
});

describe('listUsableAudioProviders', () => {
  it('lists every provider when both keys resolve', async () => {
    keysFor([ApiKeyType.openai, ApiKeyType.elevenlabs]);
    await expect(listUsableAudioProviders('u1')).resolves.toEqual({
      speech: ['openai', 'elevenlabs'],
      soundEffects: ['elevenlabs'],
    });
  });

  it('offers speech but no sound effects with only an OpenAI key', async () => {
    keysFor([ApiKeyType.openai]);
    await expect(listUsableAudioProviders('u1')).resolves.toEqual({ speech: ['openai'], soundEffects: [] });
  });

  it('lists nothing when no key resolves', async () => {
    keysFor([]);
    await expect(listUsableAudioProviders('u1')).resolves.toEqual({ speech: [], soundEffects: [] });
  });

  it('asks for a missing key as null rather than a throw, and looks each key up once', async () => {
    keysFor([]);
    await listUsableAudioProviders('u1');
    expect(getEffectiveApiKey).toHaveBeenCalledTimes(2);
    for (const [userId, options] of getEffectiveApiKey.mock.calls) {
      expect(userId).toBe('u1');
      expect(options).toMatchObject({ nullIfMissing: true });
    }
  });

  // The caller gates a Studio tab on the result, so a broken lookup must surface as a failed load rather
  // than as "no providers", which would read as an account with nothing enabled.
  it('rejects when a key lookup fails', async () => {
    getEffectiveApiKey.mockRejectedValue(new Error('key store unavailable'));
    await expect(listUsableAudioProviders('u1')).rejects.toThrow('key store unavailable');
  });
});
