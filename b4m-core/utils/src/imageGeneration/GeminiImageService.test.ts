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
