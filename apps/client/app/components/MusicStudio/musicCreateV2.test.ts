import { describe, expect, it } from 'vitest';
import type { PublicMusicModel } from '@bike4mind/common';
import { musicFieldProblems, musicModelCards, withRankedMusicDefaultFirst } from './musicCreateV2';
import { estimateCredits, initialFormFor, type MusicFormState } from './musicForm';

const model = (overrides: Partial<PublicMusicModel> = {}): PublicMusicModel => ({
  id: 'music_v2',
  object: 'music_model',
  display_name: 'Exact',
  provider: 'elevenlabs',
  provider_label: 'ElevenLabs',
  blurb: 'Exact-length songs with lyric control.',
  vocals: 'optional',
  lyrics: { max_chars: 100, max_line_chars: 20 },
  duration: { control: 'exact', min: 3, max: 300, default: 60 },
  output_formats: ['mp3'],
  typical_render_seconds: 60,
  pricing: { unit: 'per_second', credits: 1 },
  preview: false,
  deprecation_date: null,
  ...overrides,
});
const exact = model();
const fixed = model({ id: 'lyria-3-clip-preview', display_name: 'Clip', duration: { control: 'fixed', seconds: 30 } });
const instrumentalOnly = model({ display_name: 'Inst', vocals: 'never', lyrics: null });
const writer = model({ display_name: 'Writer', lyrics: null });

const form = (overrides: Partial<MusicFormState> = {}): MusicFormState => ({
  ...initialFormFor(exact),
  prompt: 'an upbeat pop song',
  ...overrides,
});

describe('musicFieldProblems', () => {
  it('reports nothing for a form the model takes', () => {
    expect(musicFieldProblems(exact, form())).toEqual({});
  });

  it('marks a length a fixed-length model cannot make, with a fix to its own length', () => {
    const { duration } = musicFieldProblems(fixed, form({ durationSeconds: 60 }));
    expect(duration?.reason).toMatch(/Clip/);
    expect(duration?.fixLabel).toBe('Use 30s');
    expect(duration?.fix).toEqual({ durationSeconds: null });
  });

  it('marks a length outside the range, with a fix to the nearest one it takes', () => {
    const narrow = model({ display_name: 'Narrow', duration: { control: 'exact', min: 3, max: 30, default: 10 } });
    expect(musicFieldProblems(narrow, form({ durationSeconds: 60 })).duration).toMatchObject({
      fixLabel: 'Use 30s',
      fix: { durationSeconds: 30 },
    });
  });

  it('marks vocals on an instrumental-only model and lyrics on a model that writes its own', () => {
    expect(musicFieldProblems(instrumentalOnly, form()).instrumental).toMatchObject({ fix: { instrumental: true } });
    expect(musicFieldProblems(writer, form({ lyrics: 'hello' })).lyrics).toMatchObject({ fix: { lyrics: '' } });
    expect(musicFieldProblems(writer, form({ lyrics: 'hello', instrumental: true }))).toEqual({});
  });
});

describe('musicModelCards', () => {
  it('describes each model and greys the ones that do not fit, keeping them pickable', () => {
    const cards = musicModelCards([exact, fixed], form({ durationSeconds: 60 }));
    expect(cards[0]).toMatchObject({
      id: 'music_v2',
      name: 'Exact',
      provider: 'ElevenLabs',
      strength: 'Exact-length songs with lyric control.',
      creditsPerOutput: estimateCredits(initialFormFor(exact)),
      outputNoun: 'song',
      pickedFor: 'exact-length songs + 60s length',
      whyNotCode: null,
      unavailableReason: null,
      mismatchReason: null,
    });
    expect(cards[1]).toMatchObject({ id: fixed.id, pickedFor: null, whyNotCode: 'unsupported_duration' });
    expect(cards[1]?.unavailableReason).toBeNull();
    expect(cards[1]?.mismatchReason).toEqual(expect.any(String));
  });

  it('ranks the models that fit the form above the preferred one that does not', () => {
    const cards = musicModelCards([fixed, exact], form({ durationSeconds: 60 }));
    expect(cards.map(card => card.id)).toEqual([exact.id, fixed.id]);
  });

  it('names your lyrics or instrumental in the picked-for line', () => {
    const [withLyrics] = musicModelCards([exact], form({ lyrics: 'hello', durationSeconds: null }));
    expect(withLyrics?.pickedFor).toBe('exact-length songs + your lyrics');
    const [instrumental] = musicModelCards([exact], form({ instrumental: true, durationSeconds: null }));
    expect(instrumental?.pickedFor).toBe('exact-length songs + instrumental');
  });

  it('falls back to the provider id and no strength when the server sends no card copy', () => {
    const [card] = musicModelCards([model({ provider_label: undefined, blurb: undefined })], form());
    expect(card).toMatchObject({ provider: 'elevenlabs', strength: '' });
  });
});

describe('withRankedMusicDefaultFirst', () => {
  it('moves the ranker pick for a fresh form to the front', () => {
    const lyria = model({ id: 'lyria-3.5', display_name: 'Lyria' });
    expect(withRankedMusicDefaultFirst([exact, lyria]).map(candidate => candidate.id)).toEqual([
      'lyria-3.5',
      'music_v2',
    ]);
  });

  it('opens on a model that also ranks first against its own defaults, whatever the server order', () => {
    // The row must agree with the panel: the pick ranks first at test-music's 5s and again at its own defaults.
    const shortTest = model({ id: 'test-music', duration: { control: 'exact', min: 1, max: 30, default: 5 } });
    const v25 = model({ id: 'music_v2_5' });
    const lyria = model({ id: 'lyria-3.5', display_name: 'Lyria' });
    const [first] = withRankedMusicDefaultFirst([shortTest, lyria, v25]);
    expect(first.id).toBe('music_v2_5');
    expect(musicModelCards([shortTest, v25, lyria], initialFormFor(first))[0].id).toBe('music_v2_5');
  });
});
