import { describe, expect, it } from 'vitest';
import { ImageModels } from '../models';
import { IMAGE_MODEL_STRENGTHS, imageModelProfile } from './profiles';

describe('imageModelProfile', () => {
  it('pairs the model strength with its provider display name', () => {
    expect(imageModelProfile(ImageModels.GEMINI_3_PRO_IMAGE)).toEqual({
      blurb: IMAGE_MODEL_STRENGTHS[ImageModels.GEMINI_3_PRO_IMAGE],
      providerLabel: 'Google',
    });
  });

  it('is null for an id outside the image catalog', () => {
    expect(imageModelProfile('gpt-4o')).toBeNull();
    expect(imageModelProfile('toString')).toBeNull();
  });
});
