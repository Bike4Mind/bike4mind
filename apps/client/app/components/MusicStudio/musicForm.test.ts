import { describe, expect, it } from 'vitest';
import {
  MUSIC_MODEL_CATALOG,
  MUSIC_MODEL_IDS,
  estimateMusicCostCredits,
  validateMusicRequest,
  type PublicMusicModel,
} from '@bike4mind/common';
import { toPublicMusicModel } from '../../../server/musicGenerations/listUsableMusicModels';
import {
  canSubmit,
  clampDuration,
  clampToModel,
  estimateCredits,
  initialFormFor,
  lyricsProblem,
  toCreateBody,
  type MusicFormState,
} from './musicForm';

const model = (overrides: Partial<PublicMusicModel> = {}): PublicMusicModel => ({
  id: 'music_v2',
  object: 'music_model',
  display_name: 'Exact',
  provider: 'elevenlabs',
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
const fixed = model({ id: 'lyria-3-clip-preview', display_name: 'Clip', duration: { control: 'fixed', seconds: 30 } });
const instrumentalOnly = model({ display_name: 'Inst', vocals: 'never', lyrics: null });
const noLyrics = model({ display_name: 'Writer', lyrics: null });

const form = (overrides: Partial<MusicFormState> = {}): MusicFormState => ({
  ...initialFormFor(model()),
  prompt: 'an upbeat pop song',
  ...overrides,
});

describe('initialFormFor', () => {
  it('starts at the default duration with vocals', () => {
    expect(initialFormFor(model())).toEqual({
      modelId: 'music_v2',
      prompt: '',
      lyrics: '',
      instrumental: false,
      durationSeconds: 60,
    });
  });

  it('has no duration for a fixed-length model and is instrumental for an instrumental-only one', () => {
    expect(initialFormFor(fixed).durationSeconds).toBeNull();
    expect(initialFormFor(instrumentalOnly).instrumental).toBe(true);
  });
});

describe('clampDuration', () => {
  it('rounds and clamps into the range', () => {
    const duration = { control: 'approximate', min: 30, max: 180, default: 120 } as const;
    expect(clampDuration(12.6, duration)).toBe(30);
    expect(clampDuration(400, duration)).toBe(180);
    expect(clampDuration(null, duration)).toBe(120);
  });
});

describe('clampToModel', () => {
  it('reports a duration moved into the new range', () => {
    const narrow = model({ display_name: 'Narrow', duration: { control: 'exact', min: 3, max: 30, default: 10 } });
    const { state, changes } = clampToModel(form({ durationSeconds: 60 }), narrow);
    expect(state.durationSeconds).toBe(30);
    expect(changes).toEqual(['Duration changed from 60s to 30s.']);
  });

  it('drops the duration for a fixed model and says so', () => {
    const { state, changes } = clampToModel(form(), fixed);
    expect(state.durationSeconds).toBeNull();
    expect(changes).toEqual(['Clip always makes 30s songs.']);
  });

  it('takes the default duration, silently, coming from a fixed model', () => {
    const { state, changes } = clampToModel(form({ durationSeconds: null }), model());
    expect(state.durationSeconds).toBe(60);
    expect(changes).toEqual([]);
  });

  it('switches to instrumental for an instrumental-only model, keeping the lyrics', () => {
    const { state, changes } = clampToModel(form({ lyrics: '[Verse]\nhi' }), instrumentalOnly);
    expect(state.instrumental).toBe(true);
    expect(state.lyrics).toBe('[Verse]\nhi');
    expect(changes).toEqual(['Inst makes instrumental music only.']);
  });

  it('keeps the lyrics but warns when the model writes its own', () => {
    const { state, changes } = clampToModel(form({ lyrics: 'hello' }), noLyrics);
    expect(state.lyrics).toBe('hello');
    expect(changes).toEqual(['Writer writes its own lyrics; yours are kept but will not be sent.']);
  });

  it('leaves lyrics over the new limit to the field note, which clears once they are fixed', () => {
    const short = model({ display_name: 'Short', lyrics: { max_chars: 5, max_line_chars: null } });
    const { state, changes } = clampToModel(form({ lyrics: 'too long' }), short);
    expect(changes).toEqual([]);
    expect(lyricsProblem(state, short)).toBe('Lyrics are 8 characters; Short accepts at most 5.');
    expect(canSubmit({ ...state, lyrics: 'ok' }, short)).toBe(true);
  });
});

describe('lyricsProblem and canSubmit', () => {
  it('refuses a lyric line over the per-line limit', () => {
    const state = form({ lyrics: 'x'.repeat(21) });
    expect(lyricsProblem(state, model())).toBe('Exact accepts at most 20 characters per lyric line.');
    expect(canSubmit(state, model())).toBe(false);
  });

  it('ignores lyrics that will not be sent', () => {
    const state = form({ lyrics: 'x'.repeat(500), instrumental: true });
    expect(lyricsProblem(state, model())).toBeNull();
    expect(canSubmit(state, model())).toBe(true);
  });

  it('needs a prompt', () => {
    expect(canSubmit(form({ prompt: '   ' }), model())).toBe(false);
  });
});

describe('toCreateBody', () => {
  it('sends trimmed lyrics and the duration', () => {
    expect(toCreateBody(form({ prompt: ' pop ', lyrics: ' [Verse]\nhi \n' }), model())).toEqual({
      model: 'music_v2',
      prompt: 'pop',
      instrumental: false,
      lyrics: '[Verse]\nhi',
      duration_seconds: 60,
    });
  });

  it('omits lyrics for an instrumental song and the duration for a fixed model', () => {
    const body = toCreateBody(form({ lyrics: 'hi', instrumental: true, durationSeconds: null }), fixed);
    expect(body).toEqual({ model: 'music_v2', prompt: 'an upbeat pop song', instrumental: true });
  });

  it('omits lyrics the model does not accept', () => {
    expect(toCreateBody(form({ lyrics: 'hi' }), noLyrics)).not.toHaveProperty('lyrics');
  });
});

describe('estimateCredits', () => {
  it('matches the server hold for the requested duration', () => {
    const state = form({ modelId: 'music_v2', durationSeconds: 90 });
    expect(estimateCredits(state)).toBe(
      estimateMusicCostCredits(MUSIC_MODEL_CATALOG.music_v2, { durationSeconds: 90 })
    );
  });

  it('prices a fixed model at its fixed length', () => {
    const caps = MUSIC_MODEL_CATALOG['lyria-3-clip-preview'];
    const state = form({ modelId: 'lyria-3-clip-preview', durationSeconds: null });
    expect(estimateCredits(state)).toBe(estimateMusicCostCredits(caps, { durationSeconds: 30 }));
  });

  it('is null for a model the catalog does not know', () => {
    expect(estimateCredits(form({ modelId: 'unknown' }))).toBeNull();
  });
});

// The form must refuse exactly what the server refuses, for every catalog model (the server's public model view is
// what the form receives).
describe('agreement with validateMusicRequest', () => {
  const lyricsCases = ['', '[Verse]\nshort line', 'x'.repeat(201), `${'line\n'.repeat(900)}end`, 'y'.repeat(10_001)];

  it.each(MUSIC_MODEL_IDS)('%s', id => {
    const publicModel = toPublicMusicModel(id);
    const caps = MUSIC_MODEL_CATALOG[id];
    const base = initialFormFor(publicModel);
    const durations = caps.duration.control === 'fixed' ? [null] : [caps.duration.min, caps.duration.max];
    for (const lyrics of lyricsCases) {
      for (const instrumental of [false, true]) {
        for (const durationSeconds of durations) {
          const { state } = clampToModel(
            { ...base, prompt: 'a song', lyrics, instrumental, durationSeconds },
            publicModel
          );
          const body = toCreateBody(state, publicModel);
          const verdict = validateMusicRequest(
            {
              model: id,
              prompt: body.prompt,
              lyrics: body.lyrics,
              instrumental: body.instrumental,
              durationSeconds: body.duration_seconds,
            },
            caps
          );
          expect({ lyrics: lyrics.slice(0, 20), instrumental, ok: canSubmit(state, publicModel) }).toEqual({
            lyrics: lyrics.slice(0, 20),
            instrumental,
            ok: verdict.ok,
          });
        }
      }
    }
  });
});
