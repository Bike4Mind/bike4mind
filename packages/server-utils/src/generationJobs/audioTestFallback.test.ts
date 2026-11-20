import type { ProviderContext, SyncGenerationProvider } from '@bike4mind/utils/generationProviders';
import { describe, expect, it, vi } from 'vitest';
import { resolveApiKeyOrTest, TEST_AUDIO_KEY, withTestAudioFallback } from './audioTestFallback';

type Request = { text: string };

const fakeProvider = (label: string): SyncGenerationProvider<string, string, Request> => ({
  mode: 'sync',
  id: label,
  models: [`${label}-model`],
  generate: vi.fn(async () => ({
    status: 'succeeded' as const,
    output: { kind: 'inline' as const, base64: label, contentType: 'audio/mpeg' },
  })),
  fetchOutput: vi.fn(async () => Buffer.from(label)),
});

const ctxWith = (apiKey: string): ProviderContext =>
  ({ apiKey, signal: new AbortController().signal }) as unknown as ProviderContext;

describe('withTestAudioFallback', () => {
  it('calls the real provider with a real key', async () => {
    const real = fakeProvider('real');
    const test = fakeProvider('test');
    const provider = withTestAudioFallback(real, test);
    const ctx = ctxWith('sk-real');

    const result = await provider.generate({ text: 'hi' }, {}, ctx);
    const bytes = await provider.fetchOutput({ kind: 'inline', base64: 'x', contentType: 'audio/mpeg' }, ctx);

    expect(result).toMatchObject({ output: { base64: 'real' } });
    expect(bytes.toString()).toBe('real');
    expect(test.generate).not.toHaveBeenCalled();
    expect(test.fetchOutput).not.toHaveBeenCalled();
    expect(provider.id).toBe('real');
  });

  it('calls the test provider with the test key', async () => {
    const real = fakeProvider('real');
    const test = fakeProvider('test');
    const provider = withTestAudioFallback(real, test);
    const ctx = ctxWith(TEST_AUDIO_KEY);

    const result = await provider.generate({ text: 'hi' }, {}, ctx);
    const bytes = await provider.fetchOutput({ kind: 'inline', base64: 'x', contentType: 'audio/mpeg' }, ctx);

    expect(result).toMatchObject({ output: { base64: 'test' } });
    expect(bytes.toString()).toBe('test');
    expect(real.generate).not.toHaveBeenCalled();
    expect(real.fetchOutput).not.toHaveBeenCalled();
  });
});

describe('resolveApiKeyOrTest', () => {
  const vendors = ['openai', 'elevenlabs'] as const;
  const resolverFor = (keys: Partial<Record<(typeof vendors)[number], string>>) =>
    resolveApiKeyOrTest(vendors, async vendor => keys[vendor] ?? null);

  it('returns the real key when the vendor has one', async () => {
    await expect(resolverFor({ openai: 'sk-openai' })('openai', 'u1')).resolves.toBe('sk-openai');
  });

  it('returns null for a keyless vendor while another vendor has a key, so the real fallback runs', async () => {
    await expect(resolverFor({ elevenlabs: 'el-key' })('openai', 'u1')).resolves.toBeNull();
  });

  it('returns the test key when no vendor has a key', async () => {
    await expect(resolverFor({})('openai', 'u1')).resolves.toBe(TEST_AUDIO_KEY);
    await expect(resolverFor({})('elevenlabs', 'u1')).resolves.toBe(TEST_AUDIO_KEY);
  });

  it('returns the test key for a single-vendor kind with no key', async () => {
    const resolve = resolveApiKeyOrTest(['elevenlabs'] as const, async () => null);
    await expect(resolve('elevenlabs', 'u1')).resolves.toBe(TEST_AUDIO_KEY);
  });
});
