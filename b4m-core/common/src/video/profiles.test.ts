import { describe, expect, it } from 'vitest';
import { VIDEO_MODEL_IDS } from './catalog';
import { VIDEO_MODEL_STRENGTHS, videoModelProfile } from './profiles';

describe('videoModelProfile', () => {
  it('pairs the model strength with its provider display name', () => {
    expect(videoModelProfile('flux-3-video')).toEqual({
      blurb: VIDEO_MODEL_STRENGTHS['flux-3-video'],
      providerLabel: 'Black Forest Labs',
    });
  });

  it('has non-empty copy for every catalog model', () => {
    for (const id of VIDEO_MODEL_IDS) {
      const { blurb, providerLabel } = videoModelProfile(id);
      expect(blurb, id).not.toBe('');
      expect(providerLabel, id).not.toBe('');
    }
  });
});
