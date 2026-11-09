import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { ImageModels, type StoredImageRequest } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { describeSyncProviderConformance } from '../../generationProviders/conformance';
import type { ProviderContext } from '../../generationProviders/types';
import { XaiImageProvider } from './XaiImageProvider';

const IMAGE_URL = 'https://imgen.x.ai/xai-imgen/abc.jpeg';
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

const request = (overrides: Partial<StoredImageRequest> = {}): StoredImageRequest => ({
  model: ImageModels.GROK_IMAGINE_IMAGE_QUALITY,
  mode: 'generate',
  prompt: 'a red bicycle',
  ...overrides,
});
const context = (overrides: Partial<ProviderContext> = {}): ProviderContext => ({
  apiKey: 'xai-key',
  logger: new Logger({ metadata: { suite: 'XaiImageProvider' } }),
  now: () => new Date(),
  signal: new AbortController().signal,
  ...overrides,
});
const apiError = (status: number, message: string) =>
  OpenAI.APIError.generate(status, { error: { message } }, message, new Headers());

let imagesGenerate: ReturnType<typeof vi.spyOn>;
const fetchMock = vi.fn();

beforeEach(() => {
  imagesGenerate = vi
    .spyOn(OpenAI.Images.prototype, 'generate')
    .mockResolvedValue({ created: 0, data: [{ url: IMAGE_URL }] } as never);
  fetchMock.mockReset().mockResolvedValue(new Response(JPEG_BYTES, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const provider = new XaiImageProvider();

describe('XaiImageProvider.generate', () => {
  it('renders one Grok Imagine image from the prompt and returns its delivery URL', async () => {
    const result = await provider.generate(request(), {}, context());
    expect(imagesGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'a red bicycle', model: ImageModels.GROK_IMAGINE_IMAGE_QUALITY, n: 1 })
    );
    expect(result).toEqual({ status: 'succeeded', output: { kind: 'url', url: IMAGE_URL, requiresAuth: false } });
  });

  it('reports the moderation 400 as blocked', async () => {
    imagesGenerate.mockRejectedValue(apiError(400, 'Generated image rejected by content moderation.'));
    await expect(provider.generate(request(), {}, context())).resolves.toMatchObject({ status: 'blocked' });
  });

  it('reports any other 4xx as a non-retryable failure', async () => {
    imagesGenerate.mockRejectedValue(apiError(400, 'prompt too long'));
    await expect(provider.generate(request(), {}, context())).resolves.toMatchObject({
      status: 'failed',
      retryable: false,
    });
  });

  it('reports a 429 as retryable', async () => {
    imagesGenerate.mockRejectedValue(apiError(429, 'slow down'));
    await expect(provider.generate(request(), {}, context())).resolves.toMatchObject({
      status: 'failed',
      retryable: true,
    });
  });

  it('throws on a 5xx: the outcome is unknown', async () => {
    imagesGenerate.mockRejectedValue(apiError(500, 'upstream exploded'));
    await expect(provider.generate(request(), {}, context())).rejects.toThrow(/XAI image generation failed/);
  });

  it('throws the abort reason when the step signal fires', async () => {
    const controller = new AbortController();
    imagesGenerate.mockReturnValue(new Promise(() => undefined) as never);
    const pending = provider.generate(request(), {}, context({ signal: controller.signal }));
    controller.abort(new Error('lease ending'));
    await expect(pending).rejects.toThrow('lease ending');
  });

  it('refuses an edit request, which the catalog never offers', async () => {
    await expect(provider.generate(request({ mode: 'edit' }), {}, context())).rejects.toThrow(/edit mode/);
    expect(imagesGenerate).not.toHaveBeenCalled();
  });
});

describe('XaiImageProvider.fetchOutput', () => {
  it('downloads the delivery URL', async () => {
    const bytes = await provider.fetchOutput({ kind: 'url', url: IMAGE_URL, requiresAuth: false }, context());
    expect(bytes.equals(JPEG_BYTES)).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(new URL(IMAGE_URL), expect.objectContaining({ redirect: 'manual' }));
  });

  it('follows one https redirect', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://cdn.x.ai/abc.jpeg' } }))
      .mockResolvedValueOnce(new Response(JPEG_BYTES, { status: 200 }));
    const bytes = await provider.fetchOutput({ kind: 'url', url: IMAGE_URL, requiresAuth: false }, context());
    expect(bytes.equals(JPEG_BYTES)).toBe(true);
  });

  it('refuses inline output', async () => {
    await expect(
      provider.fetchOutput({ kind: 'inline', base64: 'AA==', contentType: 'image/png' }, context())
    ).rejects.toThrow(/url image output/);
  });
});

describeSyncProviderConformance('XaiImageProvider', {
  provider: () => new XaiImageProvider(),
  scenario: name => {
    if (name === 'blocked') imagesGenerate.mockRejectedValue(apiError(400, 'rejected by content moderation'));
    if (name === 'fails') imagesGenerate.mockRejectedValue(apiError(400, 'bad request'));
    return request();
  },
});
