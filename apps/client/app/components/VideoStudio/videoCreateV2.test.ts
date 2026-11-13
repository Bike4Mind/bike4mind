import { describe, expect, it } from 'vitest';
import { discreteModel, optionalAudioModel, rangeModel } from '@client/app/hooks/data/__test__/videoGenerationFixtures';
import { videoFieldProblems, videoModelCards } from './videoCreateV2';
import { estimateCredits, initialFormFor, type VideoFormState } from './videoForm';

const form = (overrides: Partial<VideoFormState> = {}): VideoFormState => ({
  ...initialFormFor(rangeModel),
  prompt: 'a lighthouse at dusk',
  ...overrides,
});

describe('videoFieldProblems', () => {
  it('reports nothing for a form the model takes', () => {
    expect(videoFieldProblems(rangeModel, form())).toEqual({});
  });

  it('marks every value the model does not take, each with its reason and a one-click fix', () => {
    const problems = videoFieldProblems(discreteModel, form({ durationSeconds: 7, aspectRatio: '1:1' }));
    expect(problems.duration).toMatchObject({ fixLabel: 'Use 6s', fix: { durationSeconds: 6 } });
    expect(problems.duration?.reason).toMatch(/Veo 3\.1 Fast/);
    expect(problems.aspect).toMatchObject({ fixLabel: 'Use 16:9', fix: { aspectRatio: '16:9' } });
    expect(problems.resolution).toMatchObject({ fixLabel: 'Use 720p', fix: { resolution: '720p' } });
    expect(problems.mode).toBeUndefined();
  });

  it('marks a mode the model cannot run and moves to its first mode only on the fix', () => {
    const textOnly = { ...optionalAudioModel, modes: ['text_to_video' as const] };
    const problems = videoFieldProblems(textOnly, {
      ...initialFormFor(textOnly),
      mode: 'image_to_video',
      inputImage: { fileId: 'f1', fileName: 'harbor.png' },
    });
    expect(problems.mode).toMatchObject({ fix: { mode: 'text_to_video', inputImage: null } });
  });
});

describe('videoModelCards', () => {
  it('describes each model and greys the ones that do not fit the current values', () => {
    const cards = videoModelCards([rangeModel, discreteModel], form({ durationSeconds: 10 }));
    expect(cards[0]).toMatchObject({
      id: rangeModel.id,
      name: 'Grok Imagine Video 1.5',
      provider: 'xAI',
      strength: 'Stylised clips with sound, from text or an image.',
      creditsPerOutput: estimateCredits(initialFormFor(rangeModel)),
      outputNoun: 'clip',
      unavailableReason: null,
      mismatchReason: null,
    });
    expect(cards[1]?.mismatchReason).toMatch(/you asked for 10s/);
  });

  it('falls back to the provider id and no strength when the server sends no card copy', () => {
    const [card] = videoModelCards([optionalAudioModel], form());
    expect(card).toMatchObject({ provider: 'test', strength: '' });
  });
});
