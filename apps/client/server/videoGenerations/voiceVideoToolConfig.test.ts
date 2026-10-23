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
    expect(resolved).toEqual({
      ...config,
      deliveryNote: VOICE_VIDEO_DELIVERY_NOTE,
      createJob: expect.any(Function),
    });
  });

  it('keeps the caller job creation untouched: no delivery target is stamped on the job', async () => {
    const createJob = vi.fn().mockResolvedValue({ ok: true });
    const resolve = getVoiceVideoToolConfigResolver(
      { userId: 'u1', authOrigin: 'session' },
      vi.fn().mockResolvedValue({ usableModels: ['test-video'], createJob }),
      { claim: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) }
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

  describe('turn claim', () => {
    const input = { user: { id: 'u1', organizationId: null }, request: {}, source: 'agent', questId: 'q1' } as never;
    const setup = async (createJob: ReturnType<typeof vi.fn>, claimed = true) => {
      const slots = { claim: vi.fn().mockResolvedValue(claimed), release: vi.fn().mockResolvedValue(undefined) };
      const resolve = getVoiceVideoToolConfigResolver(
        { userId: 'u1', authOrigin: 'session' },
        vi.fn().mockResolvedValue({ usableModels: ['test-video'], createJob }),
        slots
      );
      return { slots, config: await resolve?.() };
    };

    it('refuses and never calls createJob when the claim is refused', async () => {
      const createJob = vi.fn();
      const { config } = await setup(createJob, false);
      await expect(config?.createJob(input)).resolves.toMatchObject({ ok: false, code: 'turn_cancelled' });
      expect(createJob).not.toHaveBeenCalled();
    });

    it('refuses when the quest id is missing', async () => {
      const createJob = vi.fn();
      const { config, slots } = await setup(createJob);
      await expect(config?.createJob({ ...(input as object), questId: undefined } as never)).resolves.toMatchObject({
        ok: false,
        code: 'turn_cancelled',
      });
      expect(slots.claim).not.toHaveBeenCalled();
      expect(createJob).not.toHaveBeenCalled();
    });

    it.each([
      ['a refused job', { ok: false, status: 402, code: 'insufficient_credits', message: 'x' }],
      ['an idempotent replay', { ok: true, created: false }],
    ])('releases the claim on %s', async (_name, result) => {
      const { config, slots } = await setup(vi.fn().mockResolvedValue(result));
      await expect(config?.createJob(input)).resolves.toEqual(result);
      expect(slots.release).toHaveBeenCalledWith('q1');
    });

    it('keeps the claim when a new job was created', async () => {
      const { config, slots } = await setup(vi.fn().mockResolvedValue({ ok: true, created: true }));
      await config?.createJob(input);
      expect(slots.release).not.toHaveBeenCalled();
    });

    it('keeps the claim when createJob throws', async () => {
      const { config, slots } = await setup(vi.fn().mockRejectedValue(new Error('boom')));
      await expect(config?.createJob(input)).rejects.toThrow('boom');
      expect(slots.release).not.toHaveBeenCalled();
    });
  });
});
