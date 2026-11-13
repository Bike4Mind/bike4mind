import { describe, expect, it } from 'vitest';
import { discreteModel, optionalAudioModel, rangeModel } from '@client/app/hooks/data/__test__/videoGenerationFixtures';
import { videoFieldProblems, videoModelCards, withRankedVideoDefaultFirst } from './videoCreateV2';
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

// Real catalog ids, so the ranker checks them against VIDEO_MODEL_CATALOG as it does in production.
const omniModel = { ...rangeModel, id: 'gemini-omni-1.1-flash', display_name: 'Gemini Omni Flash' };
// Values both Gemini Omni Flash and Grok Imagine take.
const sharedForm = () => form({ durationSeconds: 6, aspectRatio: '16:9', resolution: '720p' });

describe('videoModelCards', () => {
  it('describes each model, ranked for the form, with why the fitting ones were picked', () => {
    const cards = videoModelCards([omniModel, rangeModel], sharedForm());
    expect(cards.map(card => card.id)).toEqual([omniModel.id, rangeModel.id]);
    expect(cards[1]).toMatchObject({
      id: rangeModel.id,
      name: 'Grok Imagine Video 1.5',
      provider: 'xAI',
      strength: 'Stylised clips with sound, from text or an image.',
      creditsPerOutput: estimateCredits(initialFormFor(rangeModel)),
      outputNoun: 'clip',
      pickedFor: 'stylised motion',
      whyNotCode: null,
      unavailableReason: null,
      mismatchReason: null,
    });
  });

  it('sinks a model that does not take a value, keeping it pickable with the validator code', () => {
    const cards = videoModelCards([omniModel, rangeModel], { ...sharedForm(), aspectRatio: '4:3' });
    expect(cards.map(card => card.id)).toEqual([rangeModel.id, omniModel.id]);
    expect(cards[1]).toMatchObject({
      pickedFor: null,
      whyNotCode: 'unsupported_aspect_ratio',
      unavailableReason: null,
    });
    expect(cards[1]?.mismatchReason).toMatch(/4:3/);
  });

  it('names a starting image in the picked-for line, even before the image is chosen', () => {
    const [top] = videoModelCards([rangeModel], { ...sharedForm(), mode: 'image_to_video', inputImage: null });
    expect(top?.pickedFor).toBe('stylised motion + your starting image');
  });

  it('marks a retired model unavailable', () => {
    const [, veo] = videoModelCards([rangeModel, discreteModel], sharedForm());
    expect(veo).toMatchObject({
      id: discreteModel.id,
      whyNotCode: 'model_unavailable',
      unavailableReason: expect.any(String),
    });
  });

  it('falls back to the provider id and no strength when the server sends no card copy', () => {
    const [card] = videoModelCards([optionalAudioModel], form());
    expect(card).toMatchObject({ provider: 'test', strength: '' });
  });
});

describe('withRankedVideoDefaultFirst', () => {
  it('moves the model that ranks first against its own defaults to the front', () => {
    // Omni ranks first at Veo's defaults, but this fixture's own 480p default does not fit it; Grok's does.
    expect(withRankedVideoDefaultFirst([discreteModel, rangeModel, omniModel]).map(model => model.id)).toEqual([
      rangeModel.id,
      discreteModel.id,
      omniModel.id,
    ]);
  });
});
