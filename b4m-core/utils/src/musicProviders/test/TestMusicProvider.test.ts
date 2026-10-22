import { describe, expect, it } from 'vitest';
import type { ValidatedMusicRequest } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { mp3DurationSeconds } from '../mp3Duration';
import { createMusicProviderRegistry } from '../registry';
import { ProviderSubmitError } from '../types';
import { silentMp3, TestMusicProvider } from './TestMusicProvider';

const request = (prompt: string, extra: Partial<ValidatedMusicRequest> = {}) =>
  ({ model: 'test-music', prompt, durationSeconds: 5, instrumental: false, ...extra }) as ValidatedMusicRequest;

const context = (signal: AbortSignal = new AbortController().signal) => ({
  apiKey: 'test-key',
  logger: new Logger({ metadata: { suite: 'TestMusicProvider' } }),
  now: () => new Date(),
  signal,
});

describe('TestMusicProvider', () => {
  const provider = new TestMusicProvider();

  it('registers against the music catalog', () => {
    expect(createMusicProviderRegistry([provider]).get('test')).toBe(provider);
  });

  it.each([1, 5, 30])('returns a silent MP3 that reads back as %is', async seconds => {
    const result = await provider.generate(request('a song', { durationSeconds: seconds }), {}, context());
    if (result.status !== 'succeeded') throw new Error(`expected success, got ${result.status}`);
    expect(result.output).toMatchObject({ kind: 'inline', contentType: 'audio/mpeg' });
    const bytes = await provider.fetchOutput(result.output, context());
    // Rounded up to whole 24 ms frames.
    expect(mp3DurationSeconds(bytes)).toBeGreaterThanOrEqual(seconds);
    expect(mp3DurationSeconds(bytes)).toBeLessThan(seconds + 0.024);
    expect(result.reportedDurationSeconds).toBeUndefined();
  });

  it('keeps the generated audio small', () => {
    expect(silentMp3(30).byteLength).toBeLessThan(130_000);
  });

  it('sings the request lyrics back, and none for an instrumental', async () => {
    const sung = await provider.generate(request('a song', { lyrics: 'la la' }), {}, context());
    expect(sung).toMatchObject({ status: 'succeeded', lyrics: 'la la' });
    const instrumental = await provider.generate(request('a song', { instrumental: true }), {}, context());
    expect(instrumental).not.toHaveProperty('lyrics');
  });

  it('maps the prompt markers to their outcomes', async () => {
    await expect(provider.generate(request('x [blocked]'), {}, context())).resolves.toMatchObject({
      status: 'blocked',
    });
    await expect(provider.generate(request('x [fail]'), {}, context())).resolves.toMatchObject({
      status: 'failed',
      retryable: false,
    });
    await expect(provider.generate(request('x [retry]'), {}, context())).resolves.toMatchObject({
      status: 'failed',
      retryable: true,
    });
    const thrown = provider.generate(request('x [throw]'), {}, context());
    await expect(thrown).rejects.toBeInstanceOf(ProviderSubmitError);
    await expect(thrown).rejects.toMatchObject({ definitive: false });
  });

  it('honours an aborted signal', async () => {
    const aborted = context(AbortSignal.abort());
    await expect(provider.generate(request('a song'), {}, aborted)).rejects.toMatchObject({ name: 'AbortError' });
    const output = { kind: 'inline' as const, base64: 'AA==', contentType: 'audio/mpeg' };
    await expect(provider.fetchOutput(output, aborted)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
