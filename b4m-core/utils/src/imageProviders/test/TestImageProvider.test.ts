import { describe, expect, it } from 'vitest';
import { TEST_IMAGE_MODEL, type StoredImageRequest } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { describeSyncProviderConformance } from '../../generationProviders/conformance';
import { ProviderSubmitError, type ProviderContext } from '../../generationProviders/types';
import { TestImageProvider } from './TestImageProvider';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const request = (prompt = 'a red bicycle'): StoredImageRequest => ({
  model: TEST_IMAGE_MODEL,
  mode: 'generate',
  prompt,
});
const context = (overrides: Partial<ProviderContext> = {}): ProviderContext => ({
  apiKey: 'unused',
  logger: new Logger({ metadata: { suite: 'TestImageProvider' } }),
  now: () => new Date(),
  signal: new AbortController().signal,
  ...overrides,
});

const provider = new TestImageProvider();

describe('TestImageProvider', () => {
  it('serves the test model as a sync provider', () => {
    expect(provider.mode).toBe('sync');
    expect(provider.id).toBe('test');
    expect(provider.models).toEqual([TEST_IMAGE_MODEL]);
  });

  it('succeeds by default with an inline PNG that fetchOutput decodes to PNG bytes', async () => {
    const result = await provider.generate(request(), {}, context());
    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') return;
    expect(result.output).toMatchObject({ kind: 'inline', contentType: 'image/png' });
    const bytes = await provider.fetchOutput(result.output, context());
    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it('accepts an edit request and ignores its inputs', async () => {
    const result = await provider.generate({ ...request(), mode: 'edit' }, {}, context());
    expect(result.status).toBe('succeeded');
  });

  it('reports [retry] as a retryable failure', async () => {
    const result = await provider.generate(request('x [retry]'), {}, context());
    expect(result).toMatchObject({ status: 'failed', retryable: true });
  });

  it('reports [fail] as a non-retryable failure', async () => {
    const result = await provider.generate(request('x [fail]'), {}, context());
    expect(result).toMatchObject({ status: 'failed', retryable: false });
  });

  it('reports [blocked] as a policy block', async () => {
    const result = await provider.generate(request('x [blocked]'), {}, context());
    expect(result.status).toBe('blocked');
  });

  it('throws a non-retryable ProviderSubmitError for [throw]', async () => {
    const error = await provider.generate(request('x [throw]'), {}, context()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderSubmitError);
    expect((error as ProviderSubmitError).retryable).toBe(false);
  });

  it('honours an aborted signal in generate and fetchOutput', async () => {
    const controller = new AbortController();
    controller.abort(new Error('lease expired'));
    const ctx = context({ signal: controller.signal });
    await expect(provider.generate(request(), {}, ctx)).rejects.toThrow('lease expired');
    await expect(
      provider.fetchOutput({ kind: 'inline', base64: 'AAAA', contentType: 'image/png' }, ctx)
    ).rejects.toThrow('lease expired');
  });
});

describeSyncProviderConformance<StoredImageRequest, TestImageProvider>('TestImageProvider', {
  provider: () => new TestImageProvider(),
  scenario: name => {
    if (name === 'blocked') return request('[blocked]');
    if (name === 'fails') return request('[fail]');
    if (name === 'rejects') return request('[throw]');
    return request();
  },
});
