import { describe, expect, it } from 'vitest';
import { MUSIC_MODEL_IDS } from './catalog';
import { MUSIC_MODEL_STRENGTHS, musicModelProfile } from './profiles';

describe('musicModelProfile', () => {
  it('pairs the model strength with its provider display name', () => {
    expect(musicModelProfile('lyria-3.5')).toEqual({
      blurb: MUSIC_MODEL_STRENGTHS['lyria-3.5'],
      providerLabel: 'Google',
    });
  });

  it('has non-empty copy for every catalog model', () => {
    for (const id of MUSIC_MODEL_IDS) {
      const { blurb, providerLabel } = musicModelProfile(id);
      expect(blurb, id).not.toBe('');
      expect(providerLabel, id).not.toBe('');
    }
  });
});
