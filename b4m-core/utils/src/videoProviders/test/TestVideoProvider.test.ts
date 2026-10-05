import { describe, expect, it } from 'vitest';
import type { ValidatedVideoRequest } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { describeVideoProviderConformance } from '../conformance';
import { createVideoProviderRegistry } from '../registry';
import { ProviderSubmitError, readBoundedResponse, VideoOutputTooLargeError } from '../types';
import { TestVideoProvider } from './TestVideoProvider';

let clock = new Date('2026-10-06T00:00:00Z');
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
  scenario: name => request(name === 'blocked' ? 'a cat [blocked]' : name === 'fails' ? 'a cat [fail]' : 'a cat'),
  settle: () => {
    clock = new Date(clock.getTime() + 5_000);
  },
});

const makeContext = (now: () => Date) => ({
  apiKey: 'k',
  logger: new Logger({ metadata: { suite: 'TestVideoProvider' } }),
  now,
});

describe('TestVideoProvider specifics', () => {
  it('stays running until its ready time so the engine re-poll path is exercised', async () => {
    const provider = new TestVideoProvider();
    const ctx = makeContext(() => new Date('2026-10-06T00:00:00Z'));
    const handle = await provider.submit(request('a cat'), {}, ctx);
    expect((await provider.poll(handle, ctx)).status).toBe('running');
  });

  it('rejects submit with a definitive error for a "[reject]" prompt', async () => {
    const provider = new TestVideoProvider();
    const submission = provider.submit(
      request('x [reject]'),
      {},
      makeContext(() => new Date())
    );
    await expect(submission).rejects.toBeInstanceOf(ProviderSubmitError);
    await expect(submission).rejects.toMatchObject({ name: 'ProviderSubmitError', definitive: true });
  });
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
