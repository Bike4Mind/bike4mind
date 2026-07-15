import { describe, it, expect } from 'vitest';
import { ImageModels } from '../models';
import type { LLMModelConfig } from '../types/entities/LLMTypes';
import {
  isGPTImageModel,
  isGPTImage2Model,
  requiresImageInput,
  isModelAccessible,
  isBflImageModel,
} from './modelHelpers';

describe('requiresImageInput', () => {
  it('returns true for Flux Kontext models (the only models that mandate image input)', () => {
    expect(requiresImageInput(ImageModels.FLUX_KONTEXT_PRO)).toBe(true);
    expect(requiresImageInput(ImageModels.FLUX_KONTEXT_MAX)).toBe(true);
  });

  it('returns false for all other image models', () => {
    const optional = [
      ImageModels.GPT_IMAGE_1,
      ImageModels.GPT_IMAGE_1_5,
      ImageModels.GPT_IMAGE_1_MINI,
      ImageModels.GPT_IMAGE_2,
      ImageModels.DALL_E_2,
      ImageModels.FLUX_PRO,
      ImageModels.FLUX_PRO_1_1,
      ImageModels.FLUX_PRO_ULTRA,
      ImageModels.FLUX_PRO_FILL,
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

describe('isGPTImageModel', () => {
  it('matches all GPT Image variants including versioned snapshots', () => {
    expect(isGPTImageModel(ImageModels.GPT_IMAGE_1)).toBe(true);
    expect(isGPTImageModel(ImageModels.GPT_IMAGE_1_5)).toBe(true);
    expect(isGPTImageModel(ImageModels.GPT_IMAGE_1_MINI)).toBe(true);
    expect(isGPTImageModel(ImageModels.GPT_IMAGE_2)).toBe(true);
    expect(isGPTImageModel('gpt-image-2-2026-04-21')).toBe(true);
  });

  it('does not match non-GPT image models', () => {
    expect(isGPTImageModel(ImageModels.FLUX_KONTEXT_PRO)).toBe(false);
    expect(isGPTImageModel(ImageModels.GEMINI_2_5_FLASH_IMAGE)).toBe(false);
    expect(isGPTImageModel(null)).toBe(false);
  });
});

describe('isGPTImage2Model', () => {
  it('matches gpt-image-2 and its versioned snapshots only', () => {
    expect(isGPTImage2Model(ImageModels.GPT_IMAGE_2)).toBe(true);
    expect(isGPTImage2Model('gpt-image-2-2026-04-21')).toBe(true);
    expect(isGPTImage2Model(ImageModels.GPT_IMAGE_1)).toBe(false);
    expect(isGPTImage2Model(ImageModels.GPT_IMAGE_1_5)).toBe(false);
    expect(isGPTImage2Model(null)).toBe(false);
  });
});

describe('isBflImageModel', () => {
  // Enumerate the full BFL set (Kontext members included) - the ResetButton `style:'vivid'`
  // and BFL-panel branches depend on Kontext models counting as BFL.
  it.each([
    ImageModels.FLUX_PRO_1_1,
    ImageModels.FLUX_PRO,
    ImageModels.FLUX_PRO_ULTRA,
    ImageModels.FLUX_PRO_FILL,
    ImageModels.FLUX_KONTEXT_PRO,
    ImageModels.FLUX_KONTEXT_MAX,
  ])('true for BFL model %s', model => expect(isBflImageModel(model)).toBe(true));
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
