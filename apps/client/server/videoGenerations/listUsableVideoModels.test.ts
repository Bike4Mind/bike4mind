import { describe, expect, it, vi } from 'vitest';
import { usdToCredits, VideoModelSchema, type VideoProviderId } from '@bike4mind/common';
import { createVideoProviderRegistry, TestVideoProvider, type VideoProvider } from '@bike4mind/utils/videoProviders';
import { hasUsableKey, listUsableVideoModels } from './listUsableVideoModels';

// The real Gemini adapter is registered by a later task; the listing only needs a provider that serves its catalog model.
const fakeGemini = (): VideoProvider => ({
  id: 'gemini-omni',
  models: ['gemini-omni-1.1-flash'],
  submit: vi.fn(),
  poll: vi.fn(),
  fetchOutput: vi.fn(),
});

const deps = (
  overrides: {
    enabled?: Record<string, boolean>;
    keys?: Partial<Record<VideoProviderId, string | null>>;
    withTest?: boolean;
  } = {}
) => ({
  providers: createVideoProviderRegistry([fakeGemini(), ...(overrides.withTest ? [new TestVideoProvider()] : [])]),
  getSettings: vi.fn(async () => ({
    enforceCredits: true,
    // Gemini Omni ships disabled (catalog defaultEnabled: false), so these tests enable it as an admin would.
    videoGeneration: { enabledModels: overrides.enabled ?? { 'gemini-omni-1.1-flash': true } },
  })),
  resolveApiKey: vi.fn(async (providerId: VideoProviderId, _userId: string) =>
    overrides.keys?.[providerId] === undefined ? 'k' : overrides.keys[providerId]
  ),
});

describe('listUsableVideoModels', () => {
  it('lists enabled, registered models with a usable key, priced in credits per second', async () => {
    const models = await listUsableVideoModels('u1', deps());
    expect(models.map(m => m.id)).toEqual(['gemini-omni-1.1-flash']);
    expect(VideoModelSchema.parse(models[0])).toEqual(models[0]);
    expect(models[0].credits_per_second).toEqual({ '720p': usdToCredits(0.1014) });
  });

  it('omits an unregistered provider, a disabled model and a provider without a key', async () => {
    expect((await listUsableVideoModels('u1', deps({ withTest: true }))).map(m => m.id)).toEqual([
      'test-video',
      'gemini-omni-1.1-flash',
    ]);
    expect(await listUsableVideoModels('u1', deps({ enabled: { 'gemini-omni-1.1-flash': false } }))).toEqual([]);
    expect(await listUsableVideoModels('u1', deps({ keys: { 'gemini-omni': null } }))).toEqual([]);
    expect(
      (await listUsableVideoModels('u1', deps({ withTest: true, keys: { 'gemini-omni': null } }))).map(m => m.id)
    ).toEqual(['test-video']);
  });

  it('omits Gemini Omni until an admin enables it', async () => {
    const d = deps({ enabled: {}, withTest: true });
    expect((await listUsableVideoModels('u1', d)).map(m => m.id)).toEqual(['test-video']);
    expect(d.resolveApiKey).not.toHaveBeenCalledWith('gemini-omni', 'u1');
  });

  it('resolves one key per registered provider for the listing user', async () => {
    const d = deps({ withTest: true });
    await listUsableVideoModels('u1', d);
    expect(d.resolveApiKey).toHaveBeenCalledTimes(2);
    expect(d.resolveApiKey).toHaveBeenCalledWith('test', 'u1');
    expect(d.resolveApiKey).toHaveBeenCalledWith('gemini-omni', 'u1');
  });
});

describe('hasUsableKey', () => {
  it('is false when no key resolves and true when one does', async () => {
    expect(await hasUsableKey('gemini-omni', 'u1', deps({ keys: { 'gemini-omni': null } }))).toBe(false);
    expect(await hasUsableKey('gemini-omni', 'u1', deps())).toBe(true);
  });
});
