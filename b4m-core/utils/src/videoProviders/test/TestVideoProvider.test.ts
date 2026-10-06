import { describe, expect, it, vi } from 'vitest';
import type { ValidatedVideoRequest, VideoModelId, VideoProviderId } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { describeVideoProviderConformance } from '../conformance';
import { createVideoProviderRegistry } from '../registry';
import { readBoundedResponse, VideoOutputTooLargeError, type VideoProvider } from '../types';
import { TestVideoProvider } from './TestVideoProvider';

const START = new Date('2026-10-06T00:00:00Z');
let clock = START;
const request = (prompt: string) =>
  ({
    model: 'test-video',
    mode: 'text_to_video',
    prompt,
    durationSeconds: 2,
    aspectRatio: '16:9',
    resolution: '720p',
  }) as ValidatedVideoRequest;

describeVideoProviderConformance('TestVideoProvider', {
  provider: () => new TestVideoProvider(),
  context: { now: () => clock },
  beforeEach: () => {
    clock = START;
  },
  scenario: name =>
    request(
      name === 'blocked'
        ? 'a cat [blocked]'
        : name === 'fails'
          ? 'a cat [fail]'
          : name === 'rejects'
            ? 'a cat [reject]'
            : 'a cat'
    ),
  settle: () => {
    clock = new Date(clock.getTime() + 5_000);
  },
});

const makeContext = (now: () => Date, signal: AbortSignal = new AbortController().signal) => ({
  apiKey: 'k',
  logger: new Logger({ metadata: { suite: 'TestVideoProvider' } }),
  now,
  signal,
});

describe('TestVideoProvider specifics', () => {
  it('honours an aborted signal on every call, like a real adapter whose request was cancelled', async () => {
    const provider = new TestVideoProvider();
    const live = makeContext(() => new Date());
    const handle = await provider.submit(request('a cat'), {}, live);
    const aborted = makeContext(() => new Date(), AbortSignal.abort());
    const output = { kind: 'inline' as const, base64: 'AA==', contentType: 'video/mp4' };
    await expect(provider.submit(request('a cat'), {}, aborted)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(provider.poll(handle, aborted)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(provider.fetchOutput(output, aborted)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(provider.cancel(handle, aborted)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

const stubProvider = (id: VideoProviderId, models: readonly VideoModelId[]): VideoProvider => ({
  id,
  models,
  submit: vi.fn(),
  poll: vi.fn(),
  fetchOutput: vi.fn(),
});

describe('createVideoProviderRegistry', () => {
  it('looks providers up by id and lists ids', () => {
    const registry = createVideoProviderRegistry([new TestVideoProvider()]);
    expect(registry.get('test')).toBeInstanceOf(TestVideoProvider);
    expect(registry.ids()).toEqual(['test']);
  });

  it('rejects duplicate provider ids', () => {
    expect(() => createVideoProviderRegistry([new TestVideoProvider(), new TestVideoProvider()])).toThrow(
      'duplicate video provider: test'
    );
  });

  it('lists exactly the catalog models assigned to the test provider', () => {
    expect(new TestVideoProvider().models).toEqual(['test-video']);
  });

  it('refuses a provider that lists a model the catalog assigns to another provider', () => {
    expect(() => createVideoProviderRegistry([stubProvider('test', ['test-video', 'gemini-omni-1.1-flash'])])).toThrow(
      /lists gemini-omni-1\.1-flash, which the catalog assigns to gemini-omni/
    );
  });

  it('refuses a provider that omits a model the catalog assigns to it', () => {
    expect(() => createVideoProviderRegistry([stubProvider('test', [])])).toThrow(
      /does not list catalog models: test-video/
    );
  });
});

describe('readBoundedResponse', () => {
  it('rejects early on an oversized content-length', async () => {
    const response = new Response('x', { headers: { 'content-length': String(10) } });
    await expect(readBoundedResponse(response, 5)).rejects.toBeInstanceOf(VideoOutputTooLargeError);
  });

  it('rejects while streaming when no content-length is sent', async () => {
    await expect(readBoundedResponse(new Response('0123456789'), 5)).rejects.toBeInstanceOf(VideoOutputTooLargeError);
  });

  it('returns the bytes under the cap', async () => {
    expect((await readBoundedResponse(new Response('abc'), 5)).toString()).toBe('abc');
  });
});
