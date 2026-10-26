import { describe, expect, it } from 'vitest';
import { IMAGE_MODELS, ImageModels } from '../models';
import { getImageModelCapabilities } from '../utils/imageCapabilities';
import {
  isFlux2ImageModel,
  isGeminiImageModel,
  isKontextModel,
  rejectsTransparentBackground,
  supportsImageEdit,
} from '../utils/modelHelpers';
import { getImageModelCatalogEntry } from './catalog';
import { validateImageRequest, type ImageCapabilityRequest } from './validate';

// The catalog is declared separately from the predicate-derived block GET /api/models advertises, which is
// what the request path enforces today. These pin every fact the two share so neither drifts alone.
describe.each(IMAGE_MODELS)('IMAGE_MODEL_CATALOG[%s]', model => {
  const entry = getImageModelCatalogEntry(model);
  const { generate, edit } = entry.modes;
  const advertised = getImageModelCapabilities(model);

  it('sizes the model the way the request path does', () => {
    // Gemini is advertised as aspect-ratio sized, but its generateContent path sends no imageConfig.
    if (isGeminiImageModel(model)) {
      expect(entry.sizing).toEqual({ kind: 'fixed' });
      expect(advertised.sizing).toEqual({ kind: 'aspectRatio' });
      return;
    }
    expect(entry.sizing).toEqual(advertised.sizing);
  });

  it('agrees with the advertised params', () => {
    expect(entry.transparentBackground).toBe(advertised.supports.transparentBackground);
    expect(entry.seed).toBe(advertised.supports.seed);
    expect(entry.qualities).toEqual(advertised.supports.qualities);
    expect(generate === undefined).toBe(advertised.supports.requiresInputImage);
    expect((generate ?? edit)?.maxOutputs).toBe(advertised.supports.maxImages);
    // referenceImageFabFileIds ride with an edit_source on gpt-image and with the generate inputs on FLUX.2.
    // FLUX.1's lone image_prompt is the workbench image, which is not counted as a reference image.
    const anchorMode = isFlux2ImageModel(model) ? generate : edit;
    expect(anchorMode?.inputs.reference?.max ?? 0).toBe(advertised.supports.maxReferenceImages);
  });

  it('offers edit exactly where an edit dispatcher (the edit path or the Kontext transform) serves it', () => {
    expect(edit !== undefined).toBe(supportsImageEdit(model) || isKontextModel(model));
  });

  it('takes an edit_source in edit and never in generate', () => {
    if (edit) expect(edit.inputs.edit_source).toEqual({ max: 1 });
    expect(generate?.inputs.edit_source).toBeUndefined();
    expect(generate?.inputs.mask).toBeUndefined();
  });

  it('renders one image per edit, as every edit provider does', () => {
    if (edit) expect(edit.maxOutputs).toBe(1);
  });

  it('declares aspect ratios exactly when its sizing takes one', () => {
    const takesRatio =
      entry.sizing.kind === 'aspectRatio' || (entry.sizing.kind === 'inputImage' && entry.sizing.aspectRatio);
    const declaresRatio = [generate, edit].some(mode => mode?.aspectRatios);
    expect(declaresRatio).toBe(takesRatio);
  });

  it('accepts its own default request', () => {
    const defaultSize = 'defaultSize' in entry.sizing ? entry.sizing.defaultSize : undefined;
    const request: ImageCapabilityRequest = generate
      ? { mode: 'generate', size: defaultSize, count: 1 }
      : {
          mode: 'edit',
          inputs: [{ role: 'edit_source' }, ...(edit?.inputs.mask?.required ? [{ role: 'mask' as const }] : [])],
          count: 1,
        };
    expect(validateImageRequest(request, entry)).toMatchObject({ ok: true });
  });
});

describe('gemini image-to-image', () => {
  it('accepts one input image rendered n times on the chat generate path', () => {
    const request: ImageCapabilityRequest = { mode: 'generate', inputs: [{ role: 'reference' }], count: 2 };
    for (const model of IMAGE_MODELS.filter(model => isGeminiImageModel(model))) {
      expect(validateImageRequest(request, getImageModelCatalogEntry(model))).toMatchObject({ ok: true });
    }
  });
});

describe('transparent background', () => {
  it('is declared unsupported on every model the request path steps down', () => {
    const steppedDown = IMAGE_MODELS.filter(model => rejectsTransparentBackground(model));
    expect(steppedDown).toContain(ImageModels.GPT_IMAGE_2);
    for (const model of steppedDown) expect(getImageModelCatalogEntry(model).transparentBackground).toBe(false);
    expect(getImageModelCatalogEntry(ImageModels.GPT_IMAGE_2_5_FLARE).transparentBackground).toBe(true);
  });
});
