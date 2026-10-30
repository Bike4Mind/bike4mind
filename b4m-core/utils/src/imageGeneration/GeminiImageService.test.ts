import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@bike4mind/observability';
import { ImageModels } from '@bike4mind/common';

// Avoid constructing the real SDK client; the instance's genAI is stubbed per test.
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {};
  },
}));

import { GeminiImageService } from './GeminiImageService';
import { ImageModerationBlockedError } from './imageGenerationErrors';

function makeService(generateContent: ReturnType<typeof vi.fn>) {
  const svc = new GeminiImageService('test-key', new Logger());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (svc as any).genAI = { models: { generateContent } };
  return svc;
}

const imageResponse = {
  candidates: [{ content: { parts: [{ inlineData: { data: 'BASE64DATA', mimeType: 'image/png' } }] } }],
};

describe('GeminiImageService.generateImageViaContent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requests IMAGE modality so Gemini returns an image instead of chat text (#8696)', async () => {
    const generateContent = vi.fn().mockResolvedValue(imageResponse);
    const svc = makeService(generateContent);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).generateImageViaContent('a yahtzee dice', ImageModels.GEMINI_2_5_FLASH_IMAGE);

    expect(generateContent).toHaveBeenCalledTimes(1);
    const arg = generateContent.mock.calls[0][0];
    expect(arg.config?.responseModalities).toEqual(['IMAGE', 'TEXT']);
  });

  it('returns a data URL when the model returns inline image data', async () => {
    const generateContent = vi.fn().mockResolvedValue(imageResponse);
    const svc = makeService(generateContent);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const url = await (svc as any).generateImageViaContent('a cat', ImageModels.GEMINI_2_5_FLASH_IMAGE);
    expect(url).toBe('data:image/png;base64,BASE64DATA');
  });

  it('surfaces the model text when no inline image is returned (preserved behavior)', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'Sounds like fun! Would you like me to generate an image...' }] } }],
    });
    const svc = makeService(generateContent);

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (svc as any).generateImageViaContent('a dice', ImageModels.GEMINI_2_5_FLASH_IMAGE)
    ).rejects.toThrow(/Would you like me to generate an image/);
  });
});

describe('GeminiImageService.edit (model passthrough)', () => {
  // Regression: edit() silently defaulted to GEMINI_2_5_FLASH_IMAGE whenever a caller omitted
  // `model`, so a user who selected e.g. Gemini 3 Pro Image got a different model's output on
  // any continuation/edit turn with no indication the model had changed.
  beforeEach(() => vi.clearAllMocks());

  it('uses the model passed in options rather than the GEMINI_2_5_FLASH_IMAGE default', async () => {
    const generateContent = vi.fn().mockResolvedValue(imageResponse);
    const svc = makeService(generateContent);

    await svc.edit('data:image/png;base64,SOURCE', 'make it blue', {
      model: ImageModels.GEMINI_3_PRO_IMAGE,
      aspect_ratio: '16:9',
      output_format: 'png',
      safety_tolerance: 2,
    });

    expect(generateContent).toHaveBeenCalledWith(expect.objectContaining({ model: ImageModels.GEMINI_3_PRO_IMAGE }));
  });

  it('falls back to GEMINI_2_5_FLASH_IMAGE only when no model is given', async () => {
    const generateContent = vi.fn().mockResolvedValue(imageResponse);
    const svc = makeService(generateContent);

    await svc.edit('data:image/png;base64,SOURCE', 'make it blue', {
      aspect_ratio: '16:9',
      output_format: 'png',
      safety_tolerance: 2,
    });

    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({ model: ImageModels.GEMINI_2_5_FLASH_IMAGE })
    );
  });
});

describe('GeminiImageService.buildGenerationConfig (enhancePrompt/seed omission)', () => {
  // Regression: Google's generateImages API rejects the mere PRESENCE of enhancePrompt/seed, not
  // just an unsupported value - so this must never set either, for ANY caller/option shape. This
  // is the single place that guarantee lives; callers are free to pass prompt_upsampling/seed
  // through without special-casing them.
  const buildConfig = (options: Record<string, unknown>) => {
    const svc = makeService(vi.fn());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (svc as any).buildGenerationConfig(options);
  };

  it('omits enhancePrompt/seed even when prompt_upsampling/seed are explicitly set', () => {
    const config = buildConfig({ prompt_upsampling: true, seed: 42 });
    expect(config).not.toHaveProperty('enhancePrompt');
    expect(config).not.toHaveProperty('seed');
  });

  it('omits enhancePrompt/seed when prompt_upsampling is explicitly false and seed is null', () => {
    const config = buildConfig({ prompt_upsampling: false, seed: null });
    expect(config).not.toHaveProperty('enhancePrompt');
    expect(config).not.toHaveProperty('seed');
  });

  it('omits enhancePrompt/seed when neither is provided', () => {
    const config = buildConfig({});
    expect(config).not.toHaveProperty('enhancePrompt');
    expect(config).not.toHaveProperty('seed');
  });

  it('still forwards output_format/aspect_ratio, which Gemini does accept', () => {
    const config = buildConfig({ output_format: 'jpeg', aspect_ratio: '16:9' });
    expect(config).toMatchObject({ outputMimeType: 'image/jpeg', aspectRatio: '16:9' });
  });
});

describe('GeminiImageService - policy blocks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps promptFeedback.blockReason to ImageModerationBlockedError instead of "No content parts"', async () => {
    const generateContent = vi.fn().mockResolvedValue({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } });
    const svc = makeService(generateContent);

    const thrown = await svc
      .edit('data:image/png;base64,SOURCE', 'edit it', { model: ImageModels.GEMINI_2_5_FLASH_IMAGE })
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ImageModerationBlockedError);
    expect((thrown as Error).message).toMatch(/blocked by Google Gemini's safety filters \(PROHIBITED_CONTENT\)/);
  });

  it('maps an IMAGE_SAFETY finish reason on an empty candidate to ImageModerationBlockedError', async () => {
    const generateContent = vi
      .fn()
      .mockResolvedValue({ responseId: 'resp-1', candidates: [{ finishReason: 'IMAGE_SAFETY' }] });
    const svc = makeService(generateContent);

    const thrown = await svc
      .edit('data:image/png;base64,SOURCE', 'edit it', { model: ImageModels.GEMINI_2_5_FLASH_IMAGE })
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ImageModerationBlockedError);
    expect((thrown as ImageModerationBlockedError).logContext).toEqual({
      provider: 'gemini',
      requestId: 'resp-1',
      reason: 'IMAGE_SAFETY',
    });
  });

  it('reports a safety block rather than a clarification when the blocked candidate carries text', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: 'I cannot help with that.' }] } }],
    });
    const svc = makeService(generateContent);

    await expect(
      svc.edit('data:image/png;base64,SOURCE', 'edit it', { model: ImageModels.GEMINI_2_5_FLASH_IMAGE })
    ).rejects.toBeInstanceOf(ImageModerationBlockedError);
  });

  it('applies the same check on the generateContent generation path', async () => {
    const generateContent = vi.fn().mockResolvedValue({ promptFeedback: { blockReason: 'SAFETY' } });
    const svc = makeService(generateContent);

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (svc as any).generateImageViaContent('a prompt', ImageModels.GEMINI_2_5_FLASH_IMAGE)
    ).rejects.toBeInstanceOf(ImageModerationBlockedError);
  });

  it('leaves a normal STOP response with text as a clarification', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Which part should change?' }] } }],
    });
    const svc = makeService(generateContent);

    const result = await svc.edit('data:image/png;base64,SOURCE', 'edit it', {
      model: ImageModels.GEMINI_2_5_FLASH_IMAGE,
    });

    expect(result.type).toBe('clarification');
  });
});
