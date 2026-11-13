import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredImageRequest } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import type { ProviderContext } from '../../generationProviders/types';
import { LocalImageProvider } from './LocalImageProvider';

const generateMock = vi.hoisted(() => vi.fn());
const serviceConstructor = vi.hoisted(() => vi.fn());

vi.mock('../../imageGeneration/LocalImageService', () => ({
  LocalImageService: class {
    constructor(...args: unknown[]) {
      serviceConstructor(...args);
    }
    generate = generateMock;
  },
}));

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

const request = (overrides: Partial<StoredImageRequest> = {}): StoredImageRequest => ({
  model: 'local-image/sdxl',
  mode: 'generate',
  prompt: 'a red bicycle',
  ...overrides,
});
const context = (overrides: Partial<ProviderContext> = {}): ProviderContext => ({
  apiKey: 'http://localhost:7860',
  logger: new Logger({ metadata: { suite: 'LocalImageProvider' } }),
  now: () => new Date(),
  signal: new AbortController().signal,
  ...overrides,
});
const httpError = (status: number) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data: {} },
  });

const provider = new LocalImageProvider();

beforeEach(() => {
  generateMock.mockReset().mockResolvedValue([DATA_URL]);
  serviceConstructor.mockReset();
});

describe('LocalImageProvider', () => {
  it('is a sync provider that lists no static models', () => {
    expect(provider.mode).toBe('sync');
    expect(provider.id).toBe('local');
    expect(provider.models).toEqual([]);
  });

  it('renders one image through the service, passing the base URL, model and size', async () => {
    const result = await provider.generate(request({ size: '768x768' }), {}, context());
    expect(serviceConstructor).toHaveBeenCalledWith('http://localhost:7860', expect.anything());
    expect(generateMock).toHaveBeenCalledWith('a red bicycle', { n: 1, model: 'local-image/sdxl', size: '768x768' });
    expect(result).toEqual({
      status: 'succeeded',
      output: { kind: 'inline', contentType: 'image/png', base64: PNG_BYTES.toString('base64') },
    });
  });

  it('decodes the inline output back to the rendered bytes', async () => {
    const result = await provider.generate(request(), {}, context());
    if (result.status !== 'succeeded') throw new Error('expected success');
    const bytes = await provider.fetchOutput(result.output, context());
    expect(bytes.equals(PNG_BYTES)).toBe(true);
  });

  it('fails an edit request without calling the service', async () => {
    const result = await provider.generate(request({ mode: 'edit' }), {}, context());
    expect(result).toMatchObject({ status: 'failed', retryable: false });
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('fails a model that is not a local checkpoint without calling the service', async () => {
    const result = await provider.generate(request({ model: 'test-image' }), {}, context());
    expect(result).toMatchObject({ status: 'failed', retryable: false });
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('classifies a 4xx server response as a non-retryable failure', async () => {
    generateMock.mockRejectedValue(httpError(422));
    const result = await provider.generate(request(), {}, context());
    expect(result).toMatchObject({ status: 'failed', retryable: false, raw: { status: 422 } });
  });

  it('classifies a 429 as retryable', async () => {
    generateMock.mockRejectedValue(httpError(429));
    const result = await provider.generate(request(), {}, context());
    expect(result).toMatchObject({ status: 'failed', retryable: true });
  });

  it('turns any other error into a non-retryable failure carrying its message', async () => {
    generateMock.mockRejectedValue(new Error('connection refused'));
    const result = await provider.generate(request(), {}, context());
    expect(result).toMatchObject({ status: 'failed', retryable: false, message: 'connection refused' });
  });

  it('fails when the server returns no image', async () => {
    generateMock.mockResolvedValue([]);
    const result = await provider.generate(request(), {}, context());
    expect(result).toMatchObject({ status: 'failed', retryable: false });
  });

  it('rethrows when the signal is aborted instead of reporting a failure', async () => {
    const controller = new AbortController();
    generateMock.mockImplementation(async () => {
      controller.abort(new Error('lease expired'));
      throw new Error('socket hang up');
    });
    await expect(provider.generate(request(), {}, context({ signal: controller.signal }))).rejects.toThrow();
  });

  it('never calls the service when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('lease expired'));
    await expect(provider.generate(request(), {}, context({ signal: controller.signal }))).rejects.toThrow(
      'lease expired'
    );
    expect(generateMock).not.toHaveBeenCalled();
  });
});
