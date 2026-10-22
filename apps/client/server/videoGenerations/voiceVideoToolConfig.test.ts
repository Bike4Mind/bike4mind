import { describe, expect, it, vi } from 'vitest';
import type { VideoToolConfig } from '@bike4mind/services/llm/tools';
import { getVoiceVideoToolConfigResolver, VOICE_VIDEO_DELIVERY_NOTE } from './voiceVideoToolConfig';

const makeConfig = (): VideoToolConfig => ({ usableModels: ['test-video'], createJob: vi.fn() });

describe('getVoiceVideoToolConfigResolver', () => {
  it('offers no resolver to a call minted by an API key, and never looks up models', () => {
    const buildConfig = vi.fn();
    expect(getVoiceVideoToolConfigResolver({ userId: 'u1', apiKeyId: 'k1', authOrigin: 'apiKey' }, buildConfig)).toBe(
      undefined
    );
    expect(buildConfig).not.toHaveBeenCalled();
  });

  it('refuses on the key origin alone, even when the key id is missing', () => {
    expect(getVoiceVideoToolConfigResolver({ userId: 'u1', authOrigin: 'apiKey' }, vi.fn())).toBeUndefined();
  });

  it('refuses on the key id alone, even when the origin is missing', () => {
    expect(getVoiceVideoToolConfigResolver({ userId: 'u1', apiKeyId: 'k1' }, vi.fn())).toBeUndefined();
  });

  it.each(['session', 'internal', undefined] as const)('resolves a config for a %s call', async authOrigin => {
    const config = makeConfig();
    const buildConfig = vi.fn().mockResolvedValue(config);
    const resolve = getVoiceVideoToolConfigResolver({ userId: 'u1', authOrigin }, buildConfig);
    const resolved = await resolve?.();
    expect(buildConfig).toHaveBeenCalledWith('u1');
    expect(resolved).toEqual({ ...config, deliveryNote: VOICE_VIDEO_DELIVERY_NOTE });
  });

  it('keeps the caller job creation untouched: no delivery target is stamped on the job', async () => {
    const createJob = vi.fn().mockResolvedValue({ ok: true });
    const resolve = getVoiceVideoToolConfigResolver(
      { userId: 'u1', authOrigin: 'session' },
      vi.fn().mockResolvedValue({ usableModels: ['test-video'], createJob })
    );
    const config = await resolve?.();
    const input = { user: { id: 'u1', organizationId: null }, request: {}, source: 'agent', questId: 'q1' } as const;
    await config?.createJob(input as never);
    expect(createJob).toHaveBeenCalledWith(input);
  });

  it('does not offer the tool when the caller has no usable video model', async () => {
    const resolve = getVoiceVideoToolConfigResolver(
      { userId: 'u1', authOrigin: 'session' },
      vi.fn().mockResolvedValue(null)
    );
    await expect(resolve?.()).resolves.toBeNull();
  });

  it('tells the model the clip appears in the chat and never to read out ids or links', () => {
    expect(VOICE_VIDEO_DELIVERY_NOTE).toContain('appears on screen in this session chat');
    expect(VOICE_VIDEO_DELIVERY_NOTE).toContain('cannot play video');
    expect(VOICE_VIDEO_DELIVERY_NOTE).toContain('Do not read out the job id or any link');
  });
});
