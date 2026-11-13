import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageModels, type StoredImageRequest } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { ImageModerationBlockedError } from '../../imageGeneration/imageGenerationErrors';
import { describeSyncProviderConformance } from '../../generationProviders/conformance';
import type { ProviderContext } from '../../generationProviders/types';
import type { ImageInputs } from '../types';
import { OpenAIImageProvider } from './OpenAIImageProvider';

const { generate, edit, constructed } = vi.hoisted(() => ({
  generate: vi.fn(),
  edit: vi.fn(),
  constructed: vi.fn(),
}));

vi.mock('../../imageGeneration/OpenAIImageService', () => ({
  OpenAIImageService: class {
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
  model: ImageModels.GPT_IMAGE_1,
  mode: 'generate',
  prompt: 'a red bicycle',
  ...overrides,
});
const image = (role: 'edit_source' | 'mask' | 'reference', content: string) => ({
  role,
  bytes: Buffer.from(content),
  mimeType: 'image/png',
});
const dataUrlOf = (content: string) => `data:image/png;base64,${Buffer.from(content).toString('base64')}`;
const context = (overrides: Partial<ProviderContext> = {}): ProviderContext => ({
  apiKey: 'k',
  logger: new Logger({ metadata: { suite: 'OpenAIImageProvider' } }),
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

describe('OpenAIImageProvider', () => {
  const provider = new OpenAIImageProvider({ imageProcessorLambdaName: () => 'image-processor' });

  it('constructs the service with the key, logger and the lambda name read per call', async () => {
    const ctx = context();
    await provider.generate(request(), {}, ctx);
    expect(constructed).toHaveBeenCalledWith('k', ctx.logger, 'image-processor');
  });

  it('constructs the service without a lambda name when none is configured', async () => {
    await new OpenAIImageProvider().generate(request(), {}, context());
    expect(constructed).toHaveBeenCalledWith('k', expect.anything(), undefined);
  });

  describe('generate mode', () => {
    it('renders one image from the prompt and returns it inline', async () => {
      const result = await provider.generate(
        request({ quality: 'high', outputFormat: 'webp', size: '1024x1024' }),
        {},
        context()
      );
      expect(generate).toHaveBeenCalledWith('a red bicycle', {
        model: ImageModels.GPT_IMAGE_1,
        quality: 'high',
        output_format: 'webp',
        n: 1,
        size: '1024x1024',
      });
      expect(result).toEqual({
        status: 'succeeded',
        output: { kind: 'inline', contentType: 'image/png', base64: PNG_BASE64 },
      });
    });

    it('omits optional options the request did not set', async () => {
      await provider.generate(request(), {}, context());
      expect(generate).toHaveBeenCalledWith('a red bicycle', { model: ImageModels.GPT_IMAGE_1, n: 1 });
    });

    it('requests a transparent background', async () => {
      await provider.generate(request({ transparentBackground: true }), {}, context());
      expect(generate.mock.calls[0][1]).toMatchObject({ background: 'transparent' });
    });

    it('sends the first reference as imagePrompt and the rest as referenceImages', async () => {
      const inputs: ImageInputs = {
        images: [image('reference', 'one'), image('reference', 'two'), image('reference', 'three')],
      };
      await provider.generate(request(), inputs, context());
      expect(generate.mock.calls[0][1]).toMatchObject({
        imagePrompt: dataUrlOf('one'),
        referenceImages: [dataUrlOf('two'), dataUrlOf('three')],
      });
    });

    it('sends a lone reference as imagePrompt only', async () => {
      await provider.generate(request(), { images: [image('reference', 'one')] }, context());
      const options = generate.mock.calls[0][1];
      expect(options.imagePrompt).toBe(dataUrlOf('one'));
      expect(options).not.toHaveProperty('referenceImages');
    });

    it('throws when the service returns no image', async () => {
      generate.mockResolvedValue([]);
      await expect(provider.generate(request(), {}, context())).rejects.toThrow('returned no image');
    });
  });

  describe('edit mode', () => {
    const editInputs: ImageInputs = {
      images: [image('edit_source', 'src'), image('mask', 'mask'), image('reference', 'ref')],
    };

    it('edits the source with the mask and references', async () => {
      const result = await provider.generate(request({ mode: 'edit', size: '1024x1024' }), editInputs, context());
      expect(edit).toHaveBeenCalledWith(dataUrlOf('src'), 'a red bicycle', {
        model: ImageModels.GPT_IMAGE_1,
        size: '1024x1024',
        mask: dataUrlOf('mask'),
        referenceImages: [dataUrlOf('ref')],
      });
      expect(generate).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'succeeded', output: { kind: 'inline', base64: PNG_BASE64 } });
    });

    it('omits the mask and references when there are none', async () => {
      await provider.generate(request({ mode: 'edit' }), { images: [image('edit_source', 'src')] }, context());
      const options = edit.mock.calls[0][2];
      expect(options).not.toHaveProperty('mask');
      expect(options).not.toHaveProperty('referenceImages');
    });

    it('throws when the service asks for clarification instead of succeeding', async () => {
      edit.mockResolvedValue({ type: 'clarification' });
      await expect(provider.generate(request({ mode: 'edit' }), editInputs, context())).rejects.toThrow(
        'asked for clarification'
      );
    });

    it('throws when the edit_source image is missing', async () => {
      await expect(provider.generate(request({ mode: 'edit' }), {}, context())).rejects.toThrow('edit_source');
      expect(edit).not.toHaveBeenCalled();
    });
  });

  describe('error mapping', () => {
    it('reports a 429 as a retryable failure', async () => {
      generate.mockRejectedValue(rejectionWithStatus(429));
      await expect(provider.generate(request(), {}, context())).resolves.toMatchObject({
        status: 'failed',
        retryable: true,
      });
    });

    it('reports another 4xx as a non-retryable failure', async () => {
      generate.mockRejectedValue(rejectionWithStatus(400));
      await expect(provider.generate(request(), {}, context())).resolves.toMatchObject({
        status: 'failed',
        retryable: false,
      });
    });

    it('reports a moderation block as blocked', async () => {
      generate.mockRejectedValue(new ImageModerationBlockedError('refused', 'req_9'));
      await expect(provider.generate(request(), {}, context())).resolves.toEqual({
        status: 'blocked',
        reason: 'refused',
        raw: { requestId: 'req_9' },
      });
    });

    it('rethrows an error whose outcome is unknown', async () => {
      const failure = new Error('socket hang up');
      generate.mockRejectedValue(failure);
      await expect(provider.generate(request(), {}, context())).rejects.toBe(failure);
    });

    it('rethrows a 5xx', async () => {
      const failure = rejectionWithStatus(503);
      generate.mockRejectedValue(failure);
      await expect(provider.generate(request(), {}, context())).rejects.toBe(failure);
    });

    it('rejects when the signal aborts mid-call, even if the late error would classify', async () => {
      const controller = new AbortController();
      const reason = new Error('lease expired');
      let rejectGenerate: (error: unknown) => void = () => undefined;
      generate.mockReturnValue(new Promise((_resolve, reject) => (rejectGenerate = reject)));
      const pending = provider.generate(request(), {}, context({ signal: controller.signal }));
      controller.abort(reason);
      rejectGenerate(rejectionWithStatus(429));
      await expect(pending).rejects.toBe(reason);
    });
  });

  describe('fetchOutput', () => {
    it('decodes inline output', async () => {
      const bytes = await provider.fetchOutput(
        { kind: 'inline', contentType: 'image/png', base64: PNG_BASE64 },
        context()
      );
      expect(bytes.toString()).toBe('png-bytes');
    });

    it('throws when the signal is aborted', async () => {
      const controller = new AbortController();
      controller.abort(new Error('stop'));
      await expect(
        provider.fetchOutput(
          { kind: 'inline', contentType: 'image/png', base64: PNG_BASE64 },
          context({ signal: controller.signal })
        )
      ).rejects.toThrow('stop');
    });
  });
});

describeSyncProviderConformance('OpenAIImageProvider', {
  provider: () => new OpenAIImageProvider(),
  scenario: name => {
    if (name === 'blocked') generate.mockRejectedValue(new ImageModerationBlockedError('refused', 'req'));
    if (name === 'fails') generate.mockRejectedValue(rejectionWithStatus(400));
    return request();
  },
});
