import { describe, expect, it } from 'vitest';
import { ImageModels } from '../models';
import { getImageModelCatalogEntry } from './catalog';
import { validateImageRequest, type ImageCapabilityRequest } from './validate';

const gptImage1 = getImageModelCatalogEntry(ImageModels.GPT_IMAGE_1);
const gptImage2 = getImageModelCatalogEntry(ImageModels.GPT_IMAGE_2);
const fluxPro = getImageModelCatalogEntry(ImageModels.FLUX_PRO_1_1);
const fill = getImageModelCatalogEntry(ImageModels.FLUX_PRO_FILL);
const kontext = getImageModelCatalogEntry(ImageModels.FLUX_KONTEXT_PRO);
const ultra = getImageModelCatalogEntry(ImageModels.FLUX_PRO_ULTRA);
const gemini = getImageModelCatalogEntry(ImageModels.GEMINI_3_PRO_IMAGE);
const grok = getImageModelCatalogEntry(ImageModels.GROK_IMAGINE_IMAGE_QUALITY);

const codesOf = (result: ReturnType<typeof validateImageRequest>) =>
  result.ok ? [] : result.failures.map(f => f.code);

describe('validateImageRequest', () => {
  it('returns the request itself when every field is honoured', () => {
    const request: ImageCapabilityRequest = {
      mode: 'generate',
      size: '1536x1024',
      quality: 'high',
      outputFormat: 'webp',
      count: 4,
      transparentBackground: true,
      inputs: [{ role: 'reference' }, { role: 'reference' }],
    };
    expect(validateImageRequest(request, gptImage1)).toEqual({ ok: true, request });
  });

  it('reports every failing field at once, each with its field', () => {
    const result = validateImageRequest(
      { mode: 'generate', size: '4096x4096', quality: 'max', seed: 7, style: 'vivid' },
      gptImage1
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.map(({ code, field }) => [code, field])).toEqual([
      ['unsupported_size', 'size'],
      ['unsupported_quality', 'quality'],
      ['unsupported_style', 'style'],
      ['unsupported_seed', 'seed'],
    ]);
    expect(result.failures[0].message).toContain('1024x1024');
  });

  describe('transparent background', () => {
    it('fails on gpt-image-2 instead of stepping down', () => {
      expect(validateImageRequest({ mode: 'generate', transparentBackground: true }, gptImage2)).toEqual({
        ok: false,
        failures: [
          {
            code: 'unsupported_transparent_background',
            field: 'transparentBackground',
            message: expect.stringContaining('transparent'),
          },
        ],
      });
    });

    it('rejects jpeg, which cannot carry alpha, rather than promoting it to png', () => {
      const result = validateImageRequest(
        { mode: 'generate', transparentBackground: true, outputFormat: 'jpeg' },
        gptImage1
      );
      expect(codesOf(result)).toEqual(['unsupported_output_format']);
    });
  });

  describe('inputs', () => {
    it('requires an edit_source for edit', () => {
      const result = validateImageRequest({ mode: 'edit' }, gemini);
      expect(result).toMatchObject({ ok: false, failures: [{ code: 'missing_input', role: 'edit_source' }] });
    });

    it('requires the mask Fill declares mandatory', () => {
      const result = validateImageRequest({ mode: 'edit', inputs: [{ role: 'edit_source' }] }, fill);
      expect(result).toMatchObject({ ok: false, failures: [{ code: 'missing_input', field: 'inputs', role: 'mask' }] });
      expect(validateImageRequest({ mode: 'edit', inputs: [{ role: 'edit_source' }, { role: 'mask' }] }, fill).ok).toBe(
        true
      );
    });

    it('rejects an edit_source or mask on generate', () => {
      const result = validateImageRequest({ mode: 'generate', inputs: [{ role: 'mask' }] }, gptImage1);
      expect(result).toMatchObject({ ok: false, failures: [{ code: 'unexpected_input', role: 'mask' }] });
    });

    it('rejects reference images on a model that would silently drop them', () => {
      const result = validateImageRequest(
        { mode: 'edit', inputs: [{ role: 'edit_source' }, { role: 'reference' }] },
        gemini
      );
      expect(result).toMatchObject({ ok: false, failures: [{ code: 'unsupported_input_role', role: 'reference' }] });
    });

    it('caps each role at its declared max', () => {
      const inputs = Array.from({ length: 16 }, () => ({ role: 'reference' as const }));
      expect(codesOf(validateImageRequest({ mode: 'generate', inputs }, gptImage1))).toEqual(['too_many_inputs']);
    });
  });

  describe('mode', () => {
    it('rejects generate on an edit-only model', () => {
      expect(codesOf(validateImageRequest({ mode: 'generate' }, kontext))).toEqual(['unsupported_mode']);
    });

    it('rejects edit on a generate-only model', () => {
      const result = validateImageRequest({ mode: 'edit', inputs: [{ role: 'edit_source' }] }, grok);
      expect(codesOf(result)).toEqual(['unsupported_mode', 'unsupported_input_role']);
    });
  });

  describe('size', () => {
    it('accepts a custom gpt-image-2 size within its limits and auto', () => {
      expect(validateImageRequest({ mode: 'generate', size: '1920x1088' }, gptImage2).ok).toBe(true);
      expect(validateImageRequest({ mode: 'generate', size: 'auto' }, gptImage2).ok).toBe(true);
      expect(codesOf(validateImageRequest({ mode: 'generate', size: '1920x1080' }, gptImage2))).toEqual([
        'unsupported_size',
      ]);
    });

    it('accepts BFL presets and on-step custom sizes, never rounding one', () => {
      expect(validateImageRequest({ mode: 'generate', size: '1440x810' }, fluxPro).ok).toBe(true);
      expect(validateImageRequest({ mode: 'generate', size: '640x480' }, fluxPro).ok).toBe(true);
      expect(codesOf(validateImageRequest({ mode: 'generate', size: '650x480' }, fluxPro))).toEqual([
        'unsupported_size',
      ]);
      expect(codesOf(validateImageRequest({ mode: 'generate', size: '1472x800' }, fluxPro))).toEqual([
        'unsupported_size',
      ]);
    });

    it('rejects a size on a model sized by ratio, input image or nothing', () => {
      for (const caps of [ultra, gemini, grok]) {
        expect(codesOf(validateImageRequest({ mode: 'generate', size: '1024x1024' }, caps))).toEqual([
          'unsupported_size',
        ]);
      }
    });
  });

  describe('aspect ratio', () => {
    it('checks a BFL range numerically', () => {
      expect(validateImageRequest({ mode: 'generate', aspectRatio: '21:9' }, ultra).ok).toBe(true);
      expect(validateImageRequest({ mode: 'generate', aspectRatio: '5:7' }, ultra).ok).toBe(true);
      expect(codesOf(validateImageRequest({ mode: 'generate', aspectRatio: '3:1' }, ultra))).toEqual([
        'unsupported_aspect_ratio',
      ]);
      expect(codesOf(validateImageRequest({ mode: 'generate', aspectRatio: 'wide' }, ultra))).toEqual([
        'unsupported_aspect_ratio',
      ]);
    });

    it('checks a Gemini list exactly', () => {
      expect(validateImageRequest({ mode: 'generate', aspectRatio: '4:5' }, gemini).ok).toBe(true);
      expect(codesOf(validateImageRequest({ mode: 'generate', aspectRatio: '5:7' }, gemini))).toEqual([
        'unsupported_aspect_ratio',
      ]);
    });

    it('rejects a ratio on a model that takes none', () => {
      expect(codesOf(validateImageRequest({ mode: 'generate', aspectRatio: '1:1' }, gptImage1))).toEqual([
        'unsupported_aspect_ratio',
      ]);
    });
  });

  describe('output', () => {
    it('rejects webp where the provider has none, and any format where it takes none', () => {
      expect(codesOf(validateImageRequest({ mode: 'generate', outputFormat: 'webp' }, gemini))).toEqual([
        'unsupported_output_format',
      ]);
      expect(codesOf(validateImageRequest({ mode: 'generate', outputFormat: 'png' }, grok))).toEqual([
        'unsupported_output_format',
      ]);
    });

    it('bounds count to 1..maxOutputs', () => {
      expect(validateImageRequest({ mode: 'generate', count: 10 }, fluxPro).ok).toBe(true);
      for (const count of [0, 11, 1.5]) {
        expect(codesOf(validateImageRequest({ mode: 'generate', count }, fluxPro))).toEqual([
          'unsupported_output_count',
        ]);
      }
      const editCount = validateImageRequest({ mode: 'edit', inputs: [{ role: 'edit_source' }], count: 2 }, kontext);
      expect(codesOf(editCount)).toEqual(['unsupported_output_count']);
    });

    it('accepts a seed only where the model honours one', () => {
      expect(validateImageRequest({ mode: 'generate', seed: 42 }, fluxPro).ok).toBe(true);
      expect(codesOf(validateImageRequest({ mode: 'generate', seed: 42 }, gemini))).toEqual(['unsupported_seed']);
    });
  });
});
