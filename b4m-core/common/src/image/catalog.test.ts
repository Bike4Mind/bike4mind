import { describe, expect, it } from 'vitest';
import { IMAGE_MODELS, ImageModels } from '../models';
import { getImageModelCapabilities } from '../utils/imageCapabilities';
import { isKontextModel, rejectsTransparentBackground, supportsImageEdit } from '../utils/modelHelpers';
import { getImageModelCatalogEntry, maxImageInputs } from './catalog';
import { validateImageRequest } from './validate';

// The catalog is declared separately from the predicate-derived block GET /api/models advertises, which is
// what the request path enforces today. These pin every fact the two share so neither drifts alone.
describe.each(IMAGE_MODELS)('IMAGE_MODEL_CATALOG[%s]', model => {
  const entry = getImageModelCatalogEntry(model);
  const advertised = getImageModelCapabilities(model);

  it('sizes the model the way the request path does', () => {
    expect(entry.sizing).toEqual(advertised.sizing);
  });

  it('agrees with the advertised params', () => {
    expect(entry.transparentBackground).toBe(advertised.supports.transparentBackground);
    expect(entry.seed).toBe(advertised.supports.seed);
    expect(entry.qualities).toEqual(advertised.supports.qualities);
    expect(entry.maxOutputs).toBe(advertised.supports.maxImages);
    expect(entry.inputs.reference?.max ?? 0).toBe(advertised.supports.maxReferenceImages);
    expect(!entry.modes.includes('generate')).toBe(advertised.supports.requiresInputImage);
  });

  it('offers edit exactly where an edit dispatcher (the edit path or the Kontext transform) serves it', () => {
    expect(entry.modes.includes('edit')).toBe(supportsImageEdit(model) || isKontextModel(model));
  });

  it('declares an edit_source input exactly when it offers edit', () => {
    expect(entry.inputs.edit_source !== undefined).toBe(entry.modes.includes('edit'));
  });

  it('declares aspect ratios exactly when its sizing takes one', () => {
    const takesRatio =
      entry.sizing.kind === 'aspectRatio' || (entry.sizing.kind === 'inputImage' && entry.sizing.aspectRatio);
    expect(entry.aspectRatios !== null).toBe(takesRatio);
  });

  it('accepts its own default request', () => {
    const mode = entry.modes.includes('generate') ? 'generate' : 'edit';
    const inputs =
      mode === 'edit'
        ? [{ role: 'edit_source' as const }, ...(entry.inputs.mask?.required ? [{ role: 'mask' as const }] : [])]
        : [];
    const defaultSize = 'defaultSize' in entry.sizing ? entry.sizing.defaultSize : undefined;
    expect(validateImageRequest({ mode, inputs, size: defaultSize, count: 1 }, entry)).toMatchObject({ ok: true });
  });
});

describe('transparent background', () => {
  it('is declared unsupported on exactly the models the request path steps down', () => {
    for (const model of IMAGE_MODELS) {
      if (rejectsTransparentBackground(model)) {
        expect(getImageModelCatalogEntry(model).transparentBackground).toBe(false);
      }
    }
    expect(getImageModelCatalogEntry(ImageModels.GPT_IMAGE_2).transparentBackground).toBe(false);
    expect(getImageModelCatalogEntry(ImageModels.GPT_IMAGE_2_5_FLARE).transparentBackground).toBe(true);
  });
});

describe('maxImageInputs', () => {
  it('reads the declared limit for a catalogued model', () => {
    expect(maxImageInputs(ImageModels.GPT_IMAGE_1, 'reference')).toBe(15);
    expect(maxImageInputs(ImageModels.FLUX_PRO_FILL, 'mask')).toBe(1);
  });

  it('is 0 for an undeclared role or an uncatalogued model id', () => {
    expect(maxImageInputs(ImageModels.GEMINI_3_PRO_IMAGE, 'reference')).toBe(0);
    expect(maxImageInputs('local-image/sdxl.safetensors', 'reference')).toBe(0);
    expect(maxImageInputs('toString', 'reference')).toBe(0);
  });
});
