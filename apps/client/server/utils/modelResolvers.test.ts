import { describe, expect, it } from 'vitest';
import { ModelBackend, type ModelInfo } from '@bike4mind/common';
import { getDefaultImageModel } from './modelResolvers';

const model = (id: string, type: string, backend: ModelBackend): ModelInfo => ({ id, type, backend }) as ModelInfo;

const FLUX_PRO = model('flux-pro-1.1', 'image', ModelBackend.BFL);
const GPT_IMAGE_2 = model('gpt-image-2', 'image', ModelBackend.OpenAI);
const OTHER_IMAGE = model('local-image/sd15', 'image', ModelBackend.LocalImage);
const TEXT = model('gpt-4o-mini', 'text', ModelBackend.OpenAI);

describe('getDefaultImageModel', () => {
  it('prefers flux-pro-1.1 when present', () => {
    expect(getDefaultImageModel([GPT_IMAGE_2, FLUX_PRO, OTHER_IMAGE])).toBe(FLUX_PRO);
  });

  it('falls back through the priority order when higher-priority ids are absent', () => {
    expect(getDefaultImageModel([OTHER_IMAGE, GPT_IMAGE_2])).toBe(GPT_IMAGE_2);
  });

  it('falls back to any image model when none of the priority ids are present', () => {
    expect(getDefaultImageModel([TEXT, OTHER_IMAGE])).toBe(OTHER_IMAGE);
  });

  it('skips ids in excludeIds passed as a Set', () => {
    expect(getDefaultImageModel([FLUX_PRO, GPT_IMAGE_2], new Set([FLUX_PRO.id]))).toBe(GPT_IMAGE_2);
  });

  it('skips ids in excludeIds passed as a string array', () => {
    expect(getDefaultImageModel([FLUX_PRO, GPT_IMAGE_2], [FLUX_PRO.id])).toBe(GPT_IMAGE_2);
  });

  it('returns undefined once every candidate has been excluded', () => {
    expect(getDefaultImageModel([FLUX_PRO, GPT_IMAGE_2], [FLUX_PRO.id, GPT_IMAGE_2.id])).toBeUndefined();
  });

  it('returns undefined when the catalog has no image model', () => {
    expect(getDefaultImageModel([TEXT])).toBeUndefined();
  });
});
