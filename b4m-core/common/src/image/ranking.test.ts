import { describe, expect, it } from 'vitest';
import { ImageModels } from '../models';
import { IMAGE_MODEL_CATALOG } from './catalog';
import { rankImageModels } from './ranking';

const ALL = Object.values(ImageModels);
const GENERATE = { mode: 'generate', count: 1 } as const;

describe('rankImageModels', () => {
  it('orders a plain text-to-image request flagship first, newest first, previews last', () => {
    const ranked = rankImageModels(ALL, GENERATE);
    expect(ranked[0]).toEqual({
      id: ImageModels.FLUX_3_IMAGE,
      status: 'fits',
      pickedFor: ['detailed scenes'],
      whyNot: null,
    });
    expect(ranked.filter(model => model.status === 'fits').map(model => model.id)).toEqual([
      ImageModels.FLUX_3_IMAGE,
      ImageModels.GPT_IMAGE_2_5_SUNBURST,
      ImageModels.GEMINI_3_PRO_IMAGE,
      ImageModels.GPT_IMAGE_2,
      ImageModels.GROK_IMAGINE_IMAGE_QUALITY,
      ImageModels.GPT_IMAGE_1_5,
      ImageModels.FLUX_2_MAX,
      ImageModels.GPT_IMAGE_1,
      ImageModels.FLUX_PRO_ULTRA,
      ImageModels.GPT_IMAGE_2_5_FLARE,
      ImageModels.FLUX_2_PRO,
      ImageModels.FLUX_2_FLEX,
      ImageModels.FLUX_PRO_1_1,
      ImageModels.FLUX_PRO,
      ImageModels.DALL_E_2,
      ImageModels.FLUX_3_IMAGE_KLEIN,
      ImageModels.GEMINI_3_1_FLASH_IMAGE,
      ImageModels.FLUX_2_KLEIN_9B,
      ImageModels.FLUX_2_KLEIN_4B,
      ImageModels.GPT_IMAGE_1_MINI,
      ImageModels.GEMINI_2_5_FLASH_IMAGE,
      ImageModels.GEMINI_3_PRO_IMAGE_PREVIEW,
      ImageModels.FLUX_2_PRO_PREVIEW,
      ImageModels.FLUX_2_KLEIN_9B_PREVIEW,
    ]);
  });

  it('orders the OpenAI and Gemini models Studio served before FLUX and Grok newest flagship first', () => {
    const served = ALL.filter(id => ['openai', 'gemini'].includes(IMAGE_MODEL_CATALOG[id].provider));
    const ranked = rankImageModels(served, GENERATE).filter(model => model.status === 'fits');
    expect(ranked.slice(0, 4).map(model => model.id)).toEqual([
      ImageModels.GPT_IMAGE_2_5_SUNBURST,
      ImageModels.GEMINI_3_PRO_IMAGE,
      ImageModels.GPT_IMAGE_2,
      ImageModels.GPT_IMAGE_1_5,
    ]);
  });

  it('orders a transparent-background request among the models with real alpha, newest flagship first', () => {
    const ranked = rankImageModels(ALL, { ...GENERATE, transparentBackground: true, outputFormat: 'png' });
    expect(ranked.filter(model => model.status === 'fits').map(model => model.id)).toEqual([
      ImageModels.GPT_IMAGE_2_5_SUNBURST,
      ImageModels.GPT_IMAGE_1_5,
      ImageModels.GPT_IMAGE_1,
      ImageModels.GPT_IMAGE_2_5_FLARE,
      ImageModels.GPT_IMAGE_1_MINI,
    ]);
    expect(ranked[0].pickedFor).toEqual(['finished artwork', 'transparent background']);
  });

  it('sinks a model that cannot take the aspect ratio, with the validator code', () => {
    const ranked = rankImageModels([ImageModels.GPT_IMAGE_1_5, ImageModels.FLUX_PRO_ULTRA], {
      ...GENERATE,
      aspectRatio: '21:9',
    });
    expect(ranked.map(model => model.id)).toEqual([ImageModels.FLUX_PRO_ULTRA, ImageModels.GPT_IMAGE_1_5]);
    expect(ranked[0].pickedFor).toEqual(['high-res photoreal', '21:9 frame']);
    expect(ranked[1].status).toBe('mismatch');
    expect(ranked[1].whyNot?.code).toBe('unsupported_aspect_ratio');
    expect(ranked[1].whyNot?.reason).toMatch(/\S/);
  });

  it('names attached references in the picked-for reasons', () => {
    const reference = { role: 'reference' } as const;
    const [one] = rankImageModels([ImageModels.GPT_IMAGE_1_5], { ...GENERATE, inputs: [reference] });
    expect(one.pickedFor).toEqual(['sharp detail and text', 'reference']);
    const [two] = rankImageModels([ImageModels.GPT_IMAGE_1_5], { ...GENERATE, inputs: [reference, reference] });
    expect(two.pickedFor).toEqual(['sharp detail and text', '2 references']);
  });

  it('keeps only models with a real alpha channel on top for a transparent background', () => {
    const ranked = rankImageModels(ALL, { ...GENERATE, transparentBackground: true, outputFormat: 'png' });
    for (const model of ranked) {
      const catalogFits = IMAGE_MODEL_CATALOG[model.id].transparentBackground && model.status === 'fits';
      if (model.status === 'fits') expect(catalogFits).toBe(true);
    }
    expect(ranked[0].pickedFor).toContain('transparent background');
    expect(ranked.some(model => model.whyNot?.code === 'unsupported_transparent_background')).toBe(true);
  });

  it('ranks edit-capable models first for an edit', () => {
    const ranked = rankImageModels(ALL, { mode: 'edit', count: 1, inputs: [{ role: 'edit_source' }] });
    expect(ranked[0].status).toBe('fits');
    expect(ranked[0].pickedFor).toContain('editing');
    const generateOnly = ranked.filter(model => IMAGE_MODEL_CATALOG[model.id].modes.edit === undefined);
    expect(generateOnly.every(model => model.whyNot?.code === 'unsupported_mode')).toBe(true);
  });

  it('marks caller-unavailable models last and keeps unknown ids pickable', () => {
    const ranked = rankImageModels(
      [ImageModels.GPT_IMAGE_1_5, 'image-from-a-newer-server', ImageModels.GPT_IMAGE_2],
      GENERATE,
      { unavailable: { [ImageModels.GPT_IMAGE_1_5]: 'Temporarily unavailable in Studio.' } }
    );
    expect(ranked.map(model => [model.id, model.status])).toEqual([
      [ImageModels.GPT_IMAGE_2, 'fits'],
      ['image-from-a-newer-server', 'fits'],
      [ImageModels.GPT_IMAGE_1_5, 'unavailable'],
    ]);
  });
});
