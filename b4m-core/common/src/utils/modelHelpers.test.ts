import { describe, it, expect } from 'vitest';
import { ImageModels, type ModelInfo } from '../models';
import { BFL_IMAGE_MODELS } from '../schemas/bfl';
import type { LLMModelConfig } from '../types/entities/LLMTypes';
import { VIDEO_MODEL_IDS } from '../video/catalog';
import {
  filterRunnableModels,
  getMaxReferenceImages,
  supportsPromptUpsampling,
  isVideoModel,
  isGPTImageModel,
  isGPTImage2Model,
  isGPTImage25Model,
  rejectsTransparentBackground,
  supportsTransparentBackground,
  clampImageQualityForModel,
  isKontextModel,
  requiresImageInput,
  isModelAccessible,
  isBflImageModel,
  supportsImageEdit,
} from './modelHelpers';

describe('requiresImageInput', () => {
  it('returns true for models that mandate image input: Flux Kontext transforms and Fill inpainting', () => {
    expect(requiresImageInput(ImageModels.FLUX_KONTEXT_PRO)).toBe(true);
    expect(requiresImageInput(ImageModels.FLUX_KONTEXT_MAX)).toBe(true);
    // Fill is inpainting - it needs a base image + mask, so it requires image input too.
    expect(requiresImageInput(ImageModels.FLUX_PRO_FILL)).toBe(true);
  });

  it('returns false for text-to-image models that only optionally accept an image', () => {
    const optional = [
      ImageModels.GPT_IMAGE_1,
      ImageModels.GPT_IMAGE_1_5,
      ImageModels.GPT_IMAGE_1_MINI,
      ImageModels.GPT_IMAGE_2,
      ImageModels.DALL_E_2,
      ImageModels.FLUX_PRO,
      ImageModels.FLUX_PRO_1_1,
      ImageModels.FLUX_PRO_ULTRA,
      ImageModels.GROK_IMAGINE_IMAGE_QUALITY,
      ImageModels.GEMINI_2_5_FLASH_IMAGE,
      ImageModels.GEMINI_3_PRO_IMAGE_PREVIEW,
    ];
    for (const m of optional) {
      expect(requiresImageInput(m)).toBe(false);
    }
  });

  it('returns false for null, undefined, empty string, and unknown models', () => {
    expect(requiresImageInput(null)).toBe(false);
    expect(requiresImageInput(undefined)).toBe(false);
    expect(requiresImageInput('')).toBe(false);
    expect(requiresImageInput('unknown-model-id')).toBe(false);
  });
});

describe('isKontextModel', () => {
  it('returns true only for Flux Kontext transformation models', () => {
    expect(isKontextModel(ImageModels.FLUX_KONTEXT_PRO)).toBe(true);
    expect(isKontextModel(ImageModels.FLUX_KONTEXT_MAX)).toBe(true);
  });

  it('returns false for Fill - it requires an image but is NOT a Kontext transform (dispatched via ImageEdit)', () => {
    // Guards the overload regression: Fill must never be routed through the Kontext transform branch.
    expect(isKontextModel(ImageModels.FLUX_PRO_FILL)).toBe(false);
    expect(requiresImageInput(ImageModels.FLUX_PRO_FILL)).toBe(true);
  });

  it('returns false for other image models and empty inputs', () => {
    expect(isKontextModel(ImageModels.FLUX_PRO)).toBe(false);
    expect(isKontextModel(ImageModels.GPT_IMAGE_1)).toBe(false);
    expect(isKontextModel(null)).toBe(false);
    expect(isKontextModel(undefined)).toBe(false);
    expect(isKontextModel('')).toBe(false);
    expect(isKontextModel('unknown-model-id')).toBe(false);
  });
});

describe('isGPTImageModel', () => {
  it('matches all GPT Image variants including versioned snapshots', () => {
    expect(isGPTImageModel(ImageModels.GPT_IMAGE_1)).toBe(true);
    expect(isGPTImageModel(ImageModels.GPT_IMAGE_1_5)).toBe(true);
    expect(isGPTImageModel(ImageModels.GPT_IMAGE_1_MINI)).toBe(true);
    expect(isGPTImageModel(ImageModels.GPT_IMAGE_2)).toBe(true);
    expect(isGPTImageModel('gpt-image-2-2026-04-21')).toBe(true);
    expect(isGPTImageModel(ImageModels.GPT_IMAGE_2_5_SUNBURST)).toBe(true);
    expect(isGPTImageModel(ImageModels.GPT_IMAGE_2_5_FLARE)).toBe(true);
  });

  it('does not match non-GPT image models', () => {
    expect(isGPTImageModel(ImageModels.FLUX_KONTEXT_PRO)).toBe(false);
    expect(isGPTImageModel(ImageModels.GEMINI_2_5_FLASH_IMAGE)).toBe(false);
    expect(isGPTImageModel(null)).toBe(false);
  });
});

describe('isGPTImage2Model', () => {
  it('matches the gpt-image-2 family (2, 2.5, and their versioned snapshots) only', () => {
    expect(isGPTImage2Model(ImageModels.GPT_IMAGE_2)).toBe(true);
    expect(isGPTImage2Model('gpt-image-2-2026-04-21')).toBe(true);
    expect(isGPTImage2Model(ImageModels.GPT_IMAGE_2_5_SUNBURST)).toBe(true);
    expect(isGPTImage2Model(ImageModels.GPT_IMAGE_2_5_FLARE)).toBe(true);
    expect(isGPTImage2Model('gpt-image-2.5-flare-2026-09-08')).toBe(true);
    expect(isGPTImage2Model(ImageModels.GPT_IMAGE_1)).toBe(false);
    expect(isGPTImage2Model(ImageModels.GPT_IMAGE_1_5)).toBe(false);
    expect(isGPTImage2Model(null)).toBe(false);
  });
});

describe('isGPTImage25Model', () => {
  it('matches the 2.5 models and their snapshots, not gpt-image-2', () => {
    expect(isGPTImage25Model(ImageModels.GPT_IMAGE_2_5_SUNBURST)).toBe(true);
    expect(isGPTImage25Model('gpt-image-2.5-flare-2026-09-08')).toBe(true);
    expect(isGPTImage25Model(ImageModels.GPT_IMAGE_2)).toBe(false);
    expect(isGPTImage25Model('gpt-image-2-2026-04-21')).toBe(false);
    expect(isGPTImage25Model(null)).toBe(false);
  });
});

describe('rejectsTransparentBackground', () => {
  it('is true for gpt-image-2 only, not the 2.5 models or older GPT-Image models', () => {
    expect(rejectsTransparentBackground(ImageModels.GPT_IMAGE_2)).toBe(true);
    expect(rejectsTransparentBackground('gpt-image-2-2026-04-21')).toBe(true);
    expect(rejectsTransparentBackground(ImageModels.GPT_IMAGE_2_5_SUNBURST)).toBe(false);
    expect(rejectsTransparentBackground(ImageModels.GPT_IMAGE_2_5_FLARE)).toBe(false);
    expect(rejectsTransparentBackground(ImageModels.GPT_IMAGE_1_5)).toBe(false);
  });
});

describe('supportsTransparentBackground', () => {
  it('is true for gpt-image-1.x and the 2.5 models', () => {
    expect(supportsTransparentBackground(ImageModels.GPT_IMAGE_1)).toBe(true);
    expect(supportsTransparentBackground(ImageModels.GPT_IMAGE_1_MINI)).toBe(true);
    expect(supportsTransparentBackground(ImageModels.GPT_IMAGE_1_5)).toBe(true);
    expect(supportsTransparentBackground(ImageModels.GPT_IMAGE_2_5_SUNBURST)).toBe(true);
    expect(supportsTransparentBackground('gpt-image-2.5-flare-2026-09-08')).toBe(true);
  });

  it('is false for gpt-image-2 and every non-OpenAI provider', () => {
    expect(supportsTransparentBackground(ImageModels.GPT_IMAGE_2)).toBe(false);
    expect(supportsTransparentBackground('gpt-image-2-2026-04-21')).toBe(false);
    expect(supportsTransparentBackground(ImageModels.FLUX_PRO_1_1)).toBe(false);
    expect(supportsTransparentBackground(ImageModels.GEMINI_3_PRO_IMAGE)).toBe(false);
    expect(supportsTransparentBackground(null)).toBe(false);
  });
});

describe('clampImageQualityForModel', () => {
  it('keeps xhigh/max on the 2.5 models', () => {
    expect(clampImageQualityForModel(ImageModels.GPT_IMAGE_2_5_SUNBURST, 'xhigh')).toBe('xhigh');
    expect(clampImageQualityForModel('gpt-image-2.5-flare-2026-09-08', 'max')).toBe('max');
  });

  it('steps xhigh/max down to high on every other model', () => {
    expect(clampImageQualityForModel(ImageModels.GPT_IMAGE_2, 'xhigh')).toBe('high');
    expect(clampImageQualityForModel(ImageModels.GPT_IMAGE_1, 'max')).toBe('high');
  });

  it('leaves every other tier untouched', () => {
    expect(clampImageQualityForModel(ImageModels.GPT_IMAGE_2, 'medium')).toBe('medium');
    expect(clampImageQualityForModel(ImageModels.GPT_IMAGE_2, 'auto')).toBe('auto');
    expect(clampImageQualityForModel(ImageModels.GPT_IMAGE_2, undefined)).toBeUndefined();
  });
});

describe('isBflImageModel', () => {
  // Derived from the list itself so the assertion always covers the full set - the ResetButton
  // `style:'vivid'` and BFL-panel branches depend on Kontext models counting as BFL.
  it.each(BFL_IMAGE_MODELS)('true for BFL model %s', model => expect(isBflImageModel(model)).toBe(true));
  it('false for a non-BFL image model', () => expect(isBflImageModel(ImageModels.GPT_IMAGE_1)).toBe(false));
  it('false for null/undefined/empty', () => {
    expect(isBflImageModel(null)).toBe(false);
    expect(isBflImageModel(undefined)).toBe(false);
    expect(isBflImageModel('')).toBe(false);
  });
});

describe('ImageModels external identifiers', () => {
  // Locks the wire-format string sent to provider APIs. Renames must be
  // deliberate to avoid silent drift.
  it('matches the documented xAI Imagine API model id', () => {
    expect(ImageModels.GROK_IMAGINE_IMAGE_QUALITY).toBe('grok-imagine-image-quality');
  });
});

/**
 * isModelAccessible gates only on `enabled`, `allowedUserTags`,
 * `allowedEntitlements`, and the admin flag - the rest of ModelInfo is
 * irrelevant to access, so the fixture only sets the access-relevant fields.
 * Cast through `unknown` keeps the test honest about that minimal shape
 * without stubbing every unrelated ModelInfo field.
 */
function makeModel(overrides: Partial<LLMModelConfig> = {}): LLMModelConfig {
  return {
    id: 'test-model',
    type: 'text',
    name: 'Test Model',
    enabled: true,
    allowedUserTags: [],
    ...overrides,
  } as unknown as LLMModelConfig;
}

describe('isModelAccessible', () => {
  it('denies a disabled model even for matching tags/entitlements/admin', () => {
    const model = makeModel({ enabled: false, allowedUserTags: ['pro'], allowedEntitlements: ['medlib:pro'] });
    expect(isModelAccessible(model, ['pro'], false, ['medlib:pro'])).toBe(false);
    // Admin bypass also yields false when the model is disabled.
    expect(isModelAccessible(model, [], true, [])).toBe(false);
  });

  describe('admin', () => {
    it('grants any enabled model regardless of tags/entitlements', () => {
      const model = makeModel({ allowedUserTags: ['pro'], allowedEntitlements: ['medlib:pro'] });
      expect(isModelAccessible(model, [], true)).toBe(true);
      expect(isModelAccessible(model, [], true, [])).toBe(true);
    });
  });

  describe('tag-only model (no allowedEntitlements)', () => {
    const model = makeModel({ allowedUserTags: ['pro', 'developer'] });

    it('grants when a user tag intersects (case-insensitive)', () => {
      expect(isModelAccessible(model, ['PRO'], false)).toBe(true);
    });

    it('denies when no user tag intersects', () => {
      expect(isModelAccessible(model, ['customer'], false)).toBe(false);
    });

    it('behaves identically whether or not entitlementKeys is passed (neutral default)', () => {
      expect(isModelAccessible(model, ['customer'], false)).toBe(
        isModelAccessible(model, ['customer'], false, ['medlib:pro'])
      );
      expect(isModelAccessible(model, ['pro'], false)).toBe(isModelAccessible(model, ['pro'], false, []));
    });
  });

  describe('entitlement-only model (empty allowedUserTags)', () => {
    const model = makeModel({ allowedUserTags: [], allowedEntitlements: ['medlib:pro'] });

    it('grants a tag-less subscriber via their entitlement key (case-insensitive)', () => {
      expect(isModelAccessible(model, [], false, ['MedLib:Pro'])).toBe(true);
    });

    it('matches despite stray whitespace on either side (shared trim+lowercase normalizer)', () => {
      const padded = makeModel({ allowedUserTags: [], allowedEntitlements: ['  MedLib:Pro  '] });
      expect(isModelAccessible(padded, [], false, ['medlib:pro'])).toBe(true);
      expect(isModelAccessible(model, [], false, ['  medlib:pro  '])).toBe(true);
    });

    it('denies when the user holds no matching entitlement key', () => {
      expect(isModelAccessible(model, [], false, ['someother:pro'])).toBe(false);
    });

    it('denies when entitlementKeys is omitted (tag-only fallback)', () => {
      expect(isModelAccessible(model, [], false)).toBe(false);
    });
  });

  describe('both tag- and entitlement-gated (any-of / OR semantics)', () => {
    const model = makeModel({ allowedUserTags: ['pro'], allowedEntitlements: ['medlib:pro'] });

    it('grants via tag match alone', () => {
      expect(isModelAccessible(model, ['pro'], false, [])).toBe(true);
    });

    it('grants via entitlement match alone', () => {
      expect(isModelAccessible(model, [], false, ['medlib:pro'])).toBe(true);
    });

    it('grants when both match', () => {
      expect(isModelAccessible(model, ['pro'], false, ['medlib:pro'])).toBe(true);
    });

    it('denies when neither matches', () => {
      expect(isModelAccessible(model, ['customer'], false, ['someother:pro'])).toBe(false);
    });
  });

  describe('neither gate configured (empty tags, empty entitlements)', () => {
    it('denies a non-admin (no requirement can be satisfied)', () => {
      const model = makeModel({ allowedUserTags: [], allowedEntitlements: [] });
      expect(isModelAccessible(model, ['pro'], false, ['medlib:pro'])).toBe(false);
    });
  });
});

describe('supportsImageEdit', () => {
  it('accepts every GPT-Image model', () => {
    expect(supportsImageEdit(ImageModels.GPT_IMAGE_1)).toBe(true);
    expect(supportsImageEdit(ImageModels.GPT_IMAGE_1_5)).toBe(true);
    expect(supportsImageEdit(ImageModels.GPT_IMAGE_1_MINI)).toBe(true);
    expect(supportsImageEdit(ImageModels.GPT_IMAGE_2)).toBe(true);
  });

  it('accepts Gemini image models', () => {
    expect(supportsImageEdit(ImageModels.GEMINI_2_5_FLASH_IMAGE)).toBe(true);
    expect(supportsImageEdit(ImageModels.GEMINI_3_PRO_IMAGE)).toBe(true);
  });

  it('accepts Flux Fill but no other BFL model', () => {
    expect(supportsImageEdit(ImageModels.FLUX_PRO_FILL)).toBe(true);
    expect(supportsImageEdit(ImageModels.FLUX_KONTEXT_PRO)).toBe(false);
    expect(supportsImageEdit(ImageModels.FLUX_PRO_1_1)).toBe(false);
    expect(supportsImageEdit(ImageModels.FLUX_PRO_ULTRA)).toBe(false);
  });

  it('rejects XAI, unknown ids and empty input', () => {
    expect(supportsImageEdit(ImageModels.GROK_IMAGINE_IMAGE_QUALITY)).toBe(false);
    expect(supportsImageEdit('made-up-model')).toBe(false);
    expect(supportsImageEdit(null)).toBe(false);
    expect(supportsImageEdit(undefined)).toBe(false);
    expect(supportsImageEdit('')).toBe(false);
  });
});

describe('isVideoModel', () => {
  it('is true for every catalog video model and false for chat, image and retired Sora ids', () => {
    expect(VIDEO_MODEL_IDS.every(id => isVideoModel(id))).toBe(true);
    expect(isVideoModel('gpt-4o')).toBe(false);
    expect(isVideoModel(ImageModels.GPT_IMAGE_1)).toBe(false);
    expect(isVideoModel('sora-2')).toBe(false);
  });
});

describe('filterRunnableModels', () => {
  const info = (id: string, disabled?: boolean) => ({ id, disabled }) as ModelInfo;

  it('drops disabled models and models the user is not allowed, keeping unconfigured ones', () => {
    const models = [info('open'), info('off', true), info('gated'), info('entitled')];
    const configs = [
      makeModel({ id: 'gated', allowedUserTags: ['pro'] }),
      makeModel({ id: 'entitled', allowedEntitlements: ['medlib:pro'] }),
    ];
    expect(filterRunnableModels(models, configs, [], false, []).map(m => m.id)).toEqual(['open']);
    expect(filterRunnableModels(models, configs, ['pro'], false, ['medlib:pro']).map(m => m.id)).toEqual([
      'open',
      'gated',
      'entitled',
    ]);
  });

  it('drops a model whose admin row is switched off, even for an admin', () => {
    const configs = [makeModel({ id: 'paused', enabled: false })];
    expect(filterRunnableModels([info('paused')], configs, [], true, [])).toEqual([]);
  });
});

describe('getMaxReferenceImages', () => {
  it.each([
    [ImageModels.GPT_IMAGE_2, 15],
    [ImageModels.FLUX_2_PRO, 8],
    [ImageModels.FLUX_2_MAX, 8],
    [ImageModels.FLUX_2_KLEIN_9B, 4],
    [ImageModels.FLUX_2_KLEIN_4B, 4],
    [ImageModels.FLUX_PRO_1_1, 0],
    [ImageModels.GEMINI_3_PRO_IMAGE, 0],
  ])('%s accepts %s references', (model, limit) => {
    expect(getMaxReferenceImages(model)).toBe(limit);
  });
});

describe('supportsPromptUpsampling', () => {
  it.each([
    [ImageModels.FLUX_2_MAX, true],
    [ImageModels.FLUX_2_PRO, true],
    [ImageModels.FLUX_2_PRO_PREVIEW, true],
    [ImageModels.FLUX_2_FLEX, true],
    [ImageModels.FLUX_2_KLEIN_9B, false],
    [ImageModels.FLUX_2_KLEIN_9B_PREVIEW, false],
    [ImageModels.FLUX_2_KLEIN_4B, false],
    [ImageModels.FLUX_PRO_1_1, true],
    [ImageModels.GPT_IMAGE_2, false],
  ])('%s exposes a prompt enhancement control: %s', (model, supported) => {
    expect(supportsPromptUpsampling(model)).toBe(supported);
  });
});
