import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getEffectiveApiKey: vi.fn(),
    getVoiceId: vi.fn(),
    getSettingsMap: vi.fn(),
    getSettingsValue: vi.fn(),
  },
}));

vi.mock('@bike4mind/common', () => ({
  ApiKeyType: { openai: 'openai', elevenlabs: 'elevenlabs' },
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveApiKey: (...a: unknown[]) => mocks.getEffectiveApiKey(...a) },
  voiceService: { getVoiceId: (...a: unknown[]) => mocks.getVoiceId(...a) },
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: (...a: unknown[]) => mocks.getSettingsMap(...a),
  getSettingsValue: (...a: unknown[]) => mocks.getSettingsValue(...a),
}));
vi.mock('@bike4mind/database', () => ({
  apiKeyRepository: {},
  adminSettingsRepository: {},
  voiceRepository: {},
}));

import { resolveTtsProvider, TtsProviderNotConfiguredError } from './resolveTtsProvider';

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.getSettingsMap.mockResolvedValue({});
});

describe('resolveTtsProvider', () => {
  it('throws when no authenticated user is supplied', async () => {
    await expect(resolveTtsProvider({ provider: 'openai', userId: undefined })).rejects.toBeInstanceOf(
      TtsProviderNotConfiguredError
    );
  });

  describe('openai', () => {
    it('throws when no effective key is configured', async () => {
      mocks.getEffectiveApiKey.mockResolvedValue(null);
      await expect(resolveTtsProvider({ provider: 'openai', userId: 'u1' })).rejects.toThrow(
        /OpenAI API key not configured/
      );
    });

    it('uses the requested voice and skips the settings lookup (lazy default)', async () => {
      mocks.getEffectiveApiKey.mockResolvedValue('sk-openai');
      const resolved = await resolveTtsProvider({ provider: 'openai', userId: 'u1', requestedVoice: 'nova' });
      expect(resolved).toEqual({ apiKey: 'sk-openai', voice: 'nova' });
      expect(mocks.getSettingsMap).not.toHaveBeenCalled();
    });

    it('falls back to the user preference before the admin default', async () => {
      mocks.getEffectiveApiKey.mockResolvedValue('sk-openai');
      const resolved = await resolveTtsProvider({ provider: 'openai', userId: 'u1', preferredVoice: 'echo' });
      expect(resolved.voice).toBe('echo');
      expect(mocks.getSettingsMap).not.toHaveBeenCalled();
    });

    it('resolves the admin default voice when neither request nor preference is set', async () => {
      mocks.getEffectiveApiKey.mockResolvedValue('sk-openai');
      mocks.getSettingsValue.mockReturnValue('shimmer');
      const resolved = await resolveTtsProvider({ provider: 'openai', userId: 'u1' });
      expect(mocks.getSettingsMap).toHaveBeenCalledTimes(1);
      expect(resolved.voice).toBe('shimmer');
    });

    it('falls back to alloy when no admin default is configured', async () => {
      mocks.getEffectiveApiKey.mockResolvedValue('sk-openai');
      mocks.getSettingsValue.mockReturnValue(undefined);
      const resolved = await resolveTtsProvider({ provider: 'openai', userId: 'u1' });
      expect(resolved.voice).toBe('alloy');
    });
  });

  describe('elevenlabs', () => {
    it('throws when no effective key is configured', async () => {
      mocks.getEffectiveApiKey.mockResolvedValue(null);
      mocks.getVoiceId.mockResolvedValue(null);
      await expect(resolveTtsProvider({ provider: 'elevenlabs', userId: 'u1' })).rejects.toThrow(
        /ElevenLabs API key not configured/
      );
    });

    it('prefers the requested voice over the stored voice', async () => {
      mocks.getEffectiveApiKey.mockResolvedValue('xi-key');
      mocks.getVoiceId.mockResolvedValue('stored-voice');
      const resolved = await resolveTtsProvider({ provider: 'elevenlabs', userId: 'u1', requestedVoice: 'req-voice' });
      expect(resolved).toEqual({ apiKey: 'xi-key', voice: 'req-voice' });
    });

    it('uses the stored voice when none is requested', async () => {
      mocks.getEffectiveApiKey.mockResolvedValue('xi-key');
      mocks.getVoiceId.mockResolvedValue('stored-voice');
      const resolved = await resolveTtsProvider({ provider: 'elevenlabs', userId: 'u1' });
      expect(resolved.voice).toBe('stored-voice');
    });

    it('leaves the voice undefined (service default) when the admin key exists but no voice is set', async () => {
      mocks.getEffectiveApiKey.mockResolvedValue('xi-admin-key');
      mocks.getVoiceId.mockResolvedValue(null);
      const resolved = await resolveTtsProvider({ provider: 'elevenlabs', userId: 'u1' });
      expect(resolved).toEqual({ apiKey: 'xi-admin-key', voice: undefined });
    });
  });
});
