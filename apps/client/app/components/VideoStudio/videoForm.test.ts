import { describe, expect, it } from 'vitest';
import { estimateVideoCostCredits, VIDEO_MODEL_CATALOG } from '@bike4mind/common';
import { discreteModel, optionalAudioModel, rangeModel } from '@client/app/hooks/data/__test__/videoGenerationFixtures';
import {
  canSubmit,
  clampToModel,
  estimateCredits,
  initialFormFor,
  snapDuration,
  toCreateBody,
  VIDEO_PROMPT_MAX_LENGTH,
  type VideoFormState,
} from './videoForm';

const IMAGE = { fileId: 'img-1', fileName: 'harbor.png' };
const form = (overrides: Partial<VideoFormState> = {}): VideoFormState => ({
  ...initialFormFor(rangeModel),
  prompt: 'a lighthouse at dusk',
  ...overrides,
});

describe('initialFormFor', () => {
  it('starts from the model defaults in text to video', () => {
    expect(initialFormFor(rangeModel)).toEqual({
      modelId: 'grok-imagine-video-1.5',
      mode: 'text_to_video',
      prompt: '',
      durationSeconds: 6,
      aspectRatio: '16:9',
      resolution: '480p',
      audio: null,
      inputImage: null,
    });
  });

  it('turns audio on only for a model where it is optional', () => {
    expect(initialFormFor(optionalAudioModel).audio).toBe(true);
    expect(initialFormFor(discreteModel).audio).toBeNull();
  });
});

describe('snapDuration', () => {
  it('picks the nearest discrete value, the shorter on a tie', () => {
    expect(snapDuration(5, discreteModel.duration)).toBe(4);
    expect(snapDuration(7, discreteModel.duration)).toBe(6);
    expect(snapDuration(12, discreteModel.duration)).toBe(8);
    expect(snapDuration(1, discreteModel.duration)).toBe(4);
  });

  it('clamps a range and lands on a step', () => {
    expect(snapDuration(0, rangeModel.duration)).toBe(1);
    expect(snapDuration(20, rangeModel.duration)).toBe(15);
    expect(snapDuration(5, optionalAudioModel.duration)).toBe(6);
    expect(snapDuration(3, optionalAudioModel.duration)).toBe(4);
    expect(snapDuration(8, optionalAudioModel.duration)).toBe(6);
  });

  it('keeps an allowed value', () => {
    expect(snapDuration(6, discreteModel.duration)).toBe(6);
    expect(snapDuration(9, rangeModel.duration)).toBe(9);
  });
});

describe('clampToModel', () => {
  it('reports nothing when every value fits', () => {
    const result = clampToModel(form({ durationSeconds: 6, aspectRatio: '9:16', resolution: '720p' }), discreteModel);
    expect(result.changes).toEqual([]);
    expect(result.state).toMatchObject({ modelId: discreteModel.id, durationSeconds: 6, aspectRatio: '9:16' });
  });

  it('snaps a range duration onto a discrete model and says so', () => {
    const result = clampToModel(form({ durationSeconds: 7 }), discreteModel);
    expect(result.state.durationSeconds).toBe(6);
    expect(result.changes).toContain('Duration changed from 7s to 6s.');
  });

  it('falls back to the model default aspect ratio and resolution', () => {
    const result = clampToModel(form({ aspectRatio: '1:1', resolution: '480p' }), discreteModel);
    expect(result.state).toMatchObject({ aspectRatio: '16:9', resolution: '720p' });
    expect(result.changes).toEqual(
      expect.arrayContaining(['Aspect ratio changed from 1:1 to 16:9.', 'Resolution changed from 480p to 720p.'])
    );
  });

  it('switches mode and drops the image when the model cannot animate an image', () => {
    const result = clampToModel(
      form({ mode: 'image_to_video', inputImage: IMAGE, durationSeconds: 4 }),
      optionalAudioModel
    );
    expect(result.state).toMatchObject({ mode: 'text_to_video', inputImage: null });
    expect(result.changes).toEqual(
      expect.arrayContaining([
        'Synthetic Optional Audio does not support image to video; switched to text to video.',
        'Removed the input image (harbor.png).',
      ])
    );
  });

  it('keeps the image when the new model also animates images', () => {
    const result = clampToModel(form({ mode: 'image_to_video', inputImage: IMAGE }), discreteModel);
    expect(result.state.inputImage).toEqual(IMAGE);
  });

  it('turns audio back on, with a note, for a model that always generates it', () => {
    const start = { ...clampToModel(form(), optionalAudioModel).state, audio: false };
    const result = clampToModel(start, discreteModel);
    expect(result.state.audio).toBeNull();
    expect(result.changes).toContain('Veo 3.1 Fast always generates audio.');
  });

  it('defaults audio on when moving to a model where it is optional', () => {
    const result = clampToModel(form({ durationSeconds: 4 }), optionalAudioModel);
    expect(result.state.audio).toBe(true);
    expect(result.changes.some(change => change.toLowerCase().includes('audio'))).toBe(false);
  });
});

describe('toCreateBody', () => {
  it('sends the trimmed prompt and the chosen values, without audio for a fixed-audio model', () => {
    expect(toCreateBody(form({ prompt: '  a lighthouse  ' }))).toEqual({
      model: 'grok-imagine-video-1.5',
      prompt: 'a lighthouse',
      mode: 'text_to_video',
      duration_seconds: 6,
      aspect_ratio: '16:9',
      resolution: '480p',
    });
  });

  it('sends audio only when the model lets the user choose', () => {
    const state = { ...clampToModel(form({ durationSeconds: 4 }), optionalAudioModel).state, audio: false };
    expect(toCreateBody(state)).toMatchObject({ audio: false });
  });

  it('sends the image only in image to video', () => {
    expect(toCreateBody(form({ mode: 'image_to_video', inputImage: IMAGE }))).toMatchObject({
      mode: 'image_to_video',
      input_image_file_id: 'img-1',
    });
    expect(toCreateBody(form({ mode: 'text_to_video', inputImage: IMAGE }))).not.toHaveProperty('input_image_file_id');
  });
});

describe('canSubmit', () => {
  it('needs a non-blank prompt within the limit', () => {
    expect(canSubmit(form({ prompt: '   ' }))).toBe(false);
    expect(canSubmit(form({ prompt: 'x'.repeat(VIDEO_PROMPT_MAX_LENGTH + 1) }))).toBe(false);
    expect(canSubmit(form({ prompt: 'x'.repeat(VIDEO_PROMPT_MAX_LENGTH) }))).toBe(true);
  });

  it('needs an image in image to video', () => {
    expect(canSubmit(form({ mode: 'image_to_video', inputImage: null }))).toBe(false);
    expect(canSubmit(form({ mode: 'image_to_video', inputImage: IMAGE }))).toBe(true);
  });
});

describe('estimateCredits', () => {
  it('matches the server-side estimate for a catalog model', () => {
    const state = form({ durationSeconds: 9, resolution: '720p' });
    expect(estimateCredits(state)).toBe(
      estimateVideoCostCredits(VIDEO_MODEL_CATALOG['grok-imagine-video-1.5'], {
        model: 'grok-imagine-video-1.5',
        mode: 'text_to_video',
        prompt: state.prompt,
        durationSeconds: 9,
        aspectRatio: '16:9',
        resolution: '720p',
      })
    );
  });

  it('is null for a model the catalog does not know', () => {
    expect(estimateCredits(initialFormFor(optionalAudioModel))).toBeNull();
  });

  it('is null for a resolution the catalog has no price for', () => {
    expect(estimateCredits(form({ modelId: discreteModel.id, durationSeconds: 4, resolution: '4k' }))).toBeNull();
  });
});
