import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyType } from '@bike4mind/common';

const { getEffectiveApiKeyWithSource } = vi.hoisted(() => ({ getEffectiveApiKeyWithSource: vi.fn() }));

vi.mock('@bike4mind/auth', () => ({ apiKeyService: { getEffectiveApiKeyWithSource } }));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {}, apiKeyRepository: {} }));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    warn() {}
  },
}));

import { usageKeySourceFields } from './providerKeySource';

describe('usageKeySourceFields', () => {
  beforeEach(() => getEffectiveApiKeyWithSource.mockReset());

  it('stamps the source of the key an ElevenLabs call resolves to', async () => {
    getEffectiveApiKeyWithSource.mockResolvedValue({ key: 'k', source: 'user' });
    expect(await usageKeySourceFields('elevenlabs', 'u1')).toEqual({ keySource: 'user' });
    expect(getEffectiveApiKeyWithSource).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ type: ApiKeyType.elevenlabs }),
      expect.anything()
    );
  });

  it('leaves other providers unstamped without resolving a key', async () => {
    expect(await usageKeySourceFields('openai', 'u1')).toEqual({});
    expect(getEffectiveApiKeyWithSource).not.toHaveBeenCalled();
  });

  it('leaves the row unstamped when no key resolves or the lookup throws', async () => {
    getEffectiveApiKeyWithSource.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('db down'));
    expect(await usageKeySourceFields('elevenlabs', 'u1')).toEqual({});
    expect(await usageKeySourceFields('elevenlabs', 'u1')).toEqual({});
  });
});
