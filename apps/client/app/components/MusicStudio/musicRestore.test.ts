import { describe, expect, it } from 'vitest';
import type { PublicMusicModel } from '@bike4mind/common';
import type { StudioRestoreRequest } from '@client/app/components/Studio/restore/studioRestore';
import type { NonEmptyList } from '@client/app/components/Studio/useCapabilityFormState';
import { restoreMusicForm } from './musicRestore';

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

const exact = model();
const fixed = model({
  id: 'lyria-002',
  display_name: 'Fixed',
  vocals: 'never',
  lyrics: null,
  duration: { control: 'fixed', seconds: 30 },
} as Partial<PublicMusicModel>);
const MODELS: NonEmptyList<PublicMusicModel> = [exact, fixed];

const restoreOf = (request: Record<string, unknown>): StudioRestoreRequest => ({
  medium: 'music',
  request,
  fileNames: {},
});

describe('restoreMusicForm', () => {
  it('fills the model, prompt, lyrics, vocals and length of a stored music request', () => {
    const { value, notices } = restoreMusicForm(
      restoreOf({
        model: 'music_v2',
        prompt: 'lofi beat',
        lyrics: '[Verse] hi',
        instrumental: false,
        durationSeconds: 90,
      }),
      MODELS
    );
    expect(value).toEqual({
      modelId: 'music_v2',
      prompt: 'lofi beat',
      lyrics: '[Verse] hi',
      instrumental: false,
      durationSeconds: 90,
    });
    expect(notices).toEqual([]);
  });

  it('reads the legacy route shape', () => {
    const { value } = restoreMusicForm(
      restoreOf({
        provider: 'elevenlabs',
        modelId: 'music_v2',
        prompt: 'ambient',
        lengthMs: 45_400,
        forceInstrumental: true,
      }),
      MODELS
    );
    expect(value).toMatchObject({ modelId: 'music_v2', durationSeconds: 45, instrumental: true });
  });

  it('takes no duration for a fixed-length model', () => {
    expect(
      restoreMusicForm(restoreOf({ model: 'lyria-002', prompt: 'x', durationSeconds: 30 }), MODELS).value
        .durationSeconds
    ).toBeNull();
  });

  it('falls back to the first model and its defaults when the stored model or a value is gone, with notices', () => {
    const { value, notices } = restoreMusicForm(
      restoreOf({ model: 'retired-music-model', prompt: 'x', durationSeconds: -5 }),
      MODELS
    );
    expect(value).toEqual({ modelId: 'music_v2', prompt: 'x', lyrics: '', instrumental: false, durationSeconds: 60 });
    expect(notices).toEqual([
      'retired-music-model is no longer one of your music models, so Exact is picked.',
      "The take's duration (-5) is no longer valid, so the default is used.",
    ]);
  });
});
