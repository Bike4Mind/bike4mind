import { describe, expect, it } from 'vitest';
import { MUSIC_MODEL_IDS } from './catalog';
import { rankMusicModels } from './ranking';

describe('rankMusicModels', () => {
  it('opens on the first preferred model with its focus', () => {
    const [top] = rankMusicModels(MUSIC_MODEL_IDS, {});
    expect(top).toEqual({ id: 'lyria-3.5', status: 'fits', pickedFor: ['full songs with vocals'], whyNot: null });
  });

  it('sinks a model that cannot make the requested length, with the validator code', () => {
    const ranked = rankMusicModels(['lyria-3-clip-preview', 'music_v2'], { durationSeconds: 90 });
    expect(ranked.map(model => model.id)).toEqual(['music_v2', 'lyria-3-clip-preview']);
    expect(ranked[0].pickedFor).toEqual(['exact-length songs', '90s length']);
    expect(ranked[1].whyNot?.code).toBe('unsupported_duration');
  });

  it('names lyrics or instrumental in the picked-for reasons', () => {
    const [withLyrics] = rankMusicModels(['music_v2'], { lyrics: 'la la la' });
    expect(withLyrics.pickedFor).toEqual(['exact-length songs', 'your lyrics']);
    const [instrumental] = rankMusicModels(['music_v2'], { instrumental: true });
    expect(instrumental.pickedFor).toContain('instrumental');
  });
});
