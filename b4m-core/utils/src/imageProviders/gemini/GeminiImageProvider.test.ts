import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageModels, type StoredImageRequest } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { ImageModerationBlockedError } from '../../imageGeneration/imageGenerationErrors';
import { describeSyncProviderConformance } from '../../generationProviders/conformance';
import type { ProviderContext } from '../../generationProviders/types';
import { GeminiImageProvider } from './GeminiImageProvider';

const { generate, edit, constructed } = vi.hoisted(() => ({
  generate: vi.fn(),
  edit: vi.fn(),
  constructed: vi.fn(),
}));

vi.mock('../../imageGeneration/GeminiImageService', () => ({
  GeminiImageService: class {
    constructor(...args: unknown[]) {
      constructed(...args);
    }
    generate = generate;
    edit = edit;
  },
}));

const PNG_BASE64 = Buffer.from('png-bytes').toString('base64');
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

const request = (overrides: Partial<StoredImageRequest> = {}): StoredImageRequest => ({
  model: ImageModels.GEMINI_2_5_FLASH_IMAGE,
  mode: 'generate',
  prompt: 'a red bicycle',
  ...overrides,
});
const image = (role: 'edit_source' | 'reference', content: string) => ({
  role,
  bytes: Buffer.from(content),
  mimeType: 'image/png',
});
const dataUrlOf = (content: string) => `data:image/png;base64,${Buffer.from(content).toString('base64')}`;
const context = (overrides: Partial<ProviderContext> = {}): ProviderContext => ({
  apiKey: 'k',
  logger: new Logger({ metadata: { suite: 'GeminiImageProvider' } }),
  now: () => new Date(),
  signal: new AbortController().signal,
  ...overrides,
});
const rejectionWithStatus = (status: number) =>
  new Error('wrapped', { cause: Object.assign(new Error('sdk'), { status }) });

beforeEach(() => {
  vi.clearAllMocks();
  generate.mockResolvedValue([PNG_DATA_URL]);
  edit.mockResolvedValue({ type: 'success', dataUrl: PNG_DATA_URL });
});

describe('GeminiImageProvider', () => {
  const provider = new GeminiImageProvider();

  it('renders one image from the prompt alone and returns it inline', async () => {
    const ctx = context();
    const result = await provider.generate(request(), {}, ctx);
    expect(constructed).toHaveBeenCalledWith('k', ctx.logger);
    expect(generate).toHaveBeenCalledWith('a red bicycle', { model: ImageModels.GEMINI_2_5_FLASH_IMAGE, n: 1 });
    expect(edit).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'succeeded',
      output: { kind: 'inline', contentType: 'image/png', base64: PNG_BASE64 },
    });
  });

  it('turns a generate reference into image-to-image through the edit call', async () => {
    await provider.generate(request(), { images: [image('reference', 'ref')] }, context());
    expect(edit).toHaveBeenCalledWith(dataUrlOf('ref'), 'a red bicycle', {
      model: ImageModels.GEMINI_2_5_FLASH_IMAGE,
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('edits the edit_source image in edit mode', async () => {
    const result = await provider.generate(
      request({ mode: 'edit' }),
      { images: [image('edit_source', 'src')] },
      context()
    );
    expect(edit).toHaveBeenCalledWith(dataUrlOf('src'), 'a red bicycle', {
      model: ImageModels.GEMINI_2_5_FLASH_IMAGE,
    });
    expect(result.status).toBe('succeeded');
  });

  it('throws when an edit arrives without its edit_source', async () => {
    await expect(provider.generate(request({ mode: 'edit' }), {}, context())).rejects.toThrow(/edit_source/);
  });

  it('fails, without retry, when Gemini answers with a clarification instead of an image', async () => {
    edit.mockResolvedValue({ type: 'clarification', question: 'Which bicycle?' });
    const result = await provider.generate(
      request({ mode: 'edit' }),
      { images: [image('edit_source', 's')] },
      context()
    );
    expect(result).toMatchObject({ status: 'failed', retryable: false });
    expect(result.status === 'failed' && result.message).toContain('Which bicycle?');
  });

  it('reports a policy block as blocked', async () => {
    generate.mockRejectedValue(new ImageModerationBlockedError('refused', 'req-1', 'gemini'));
    expect(await provider.generate(request(), {}, context())).toMatchObject({
      status: 'blocked',
      raw: { requestId: 'req-1' },
    });
  });

  it('retries a rate limit and fails other 4xx answers for good', async () => {
    generate.mockRejectedValueOnce(rejectionWithStatus(429));
    expect(await provider.generate(request(), {}, context())).toMatchObject({ status: 'failed', retryable: true });
    edit.mockRejectedValueOnce(rejectionWithStatus(400));
    expect(
      await provider.generate(request({ mode: 'edit' }), { images: [image('edit_source', 's')] }, context())
    ).toMatchObject({ status: 'failed', retryable: false });
  });

  it('rethrows an error of unknown outcome', async () => {
    generate.mockRejectedValue(rejectionWithStatus(503));
    await expect(provider.generate(request(), {}, context())).rejects.toThrow('wrapped');
  });

  it('rethrows on abort even when the late error would classify', async () => {
    const controller = new AbortController();
    let rejectLater: (error: unknown) => void = () => undefined;
    generate.mockReturnValue(new Promise((_, reject) => (rejectLater = reject)));
    const pending = provider.generate(request(), {}, context({ signal: controller.signal }));
    controller.abort(new Error('lease expired'));
    rejectLater(rejectionWithStatus(400));
    await expect(pending).rejects.toThrow('lease expired');
  });

  it('decodes inline output and refuses after abort', async () => {
    const output = { kind: 'inline' as const, contentType: 'image/png', base64: PNG_BASE64 };
    expect((await provider.fetchOutput(output, context())).toString()).toBe('png-bytes');
    const controller = new AbortController();
    controller.abort();
    await expect(provider.fetchOutput(output, context({ signal: controller.signal }))).rejects.toThrow();
  });
});

describeSyncProviderConformance('GeminiImageProvider', {
  provider: () => new GeminiImageProvider(),
  scenario: name => {
    if (name === 'blocked') generate.mockRejectedValue(new ImageModerationBlockedError('refused', 'req', 'gemini'));
    if (name === 'fails') generate.mockRejectedValue(rejectionWithStatus(400));
    return request();
  },
});
