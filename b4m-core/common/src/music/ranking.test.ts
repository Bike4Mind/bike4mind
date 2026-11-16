import { describe, expect, it } from 'vitest';
import { MUSIC_MODEL_IDS } from './catalog';
import { rankMusicModels } from './ranking';

describe('rankMusicModels', () => {
  it('opens on the newest flagship with its focus, previews and the test model last', () => {
    const ranked = rankMusicModels(MUSIC_MODEL_IDS, {});
    expect(ranked.map(model => model.id)).toEqual([
      'music_v2_5',
      'lyria-3.5',
      'music_v2',
      'music_v1',
      'test-music',
      'lyria-3-clip-preview',
    ]);
    expect(ranked[0]).toEqual({ id: 'music_v2_5', status: 'fits', pickedFor: ['exact-length songs'], whyNot: null });
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
