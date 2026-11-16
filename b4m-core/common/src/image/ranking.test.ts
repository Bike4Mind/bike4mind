import { describe, expect, it } from 'vitest';
import { ImageModels } from '../models';
import { IMAGE_MODEL_CATALOG } from './catalog';
import { IMAGE_MODEL_FOCUS, IMAGE_MODEL_PREFERENCE, rankImageModels } from './ranking';

const ALL = Object.values(ImageModels);
const GENERATE = { mode: 'generate', count: 1 } as const;

describe('rankImageModels', () => {
  it('opens on the first preferred model with its focus as the picked-for reason', () => {
    const [top] = rankImageModels(ALL, GENERATE);
    expect(top).toEqual({
      id: IMAGE_MODEL_PREFERENCE[0],
      status: 'fits',
      pickedFor: [IMAGE_MODEL_FOCUS[IMAGE_MODEL_PREFERENCE[0]]],
      whyNot: null,
    });
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
