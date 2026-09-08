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
