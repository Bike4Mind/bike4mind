import { estimateVideoCostCredits, VIDEO_MODEL_CATALOG, type VideoModel } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { publicVideoModel } from './__fixtures__/videoModels';
import {
  estimateVideoCredits,
  parseVideoModels,
  planVideoRequest,
  PREFERRED_VIDEO_MODEL,
  resolveVideoModel,
} from './videoModels';

const gemini = publicVideoModel('gemini-omni-1.1-flash');
const grok = publicVideoModel('grok-imagine-video-1.5');
const veo = publicVideoModel('veo-3.1-fast-generate-preview');

describe('resolveVideoModel', () => {
  it('prefers the default-on model when the server offers it', () => {
    expect(resolveVideoModel([grok, gemini, veo], undefined).id).toBe(PREFERRED_VIDEO_MODEL);
  });

  it('falls back to the cheapest offered model at its defaults', () => {
    // veo 4s at $0.10/s undercuts grok 6s at $0.08/s.
    expect(resolveVideoModel([grok, veo], undefined).id).toBe(veo.id);
  });

  it('takes a named model the server offers', () => {
    expect(resolveVideoModel([grok, gemini], grok.id).id).toBe(grok.id);
  });

  it('refuses a model the server does not offer, naming what it does', () => {
    expect(() => resolveVideoModel([gemini], veo.id)).toThrow(/does not offer the video model.*It offers: gemini/);
  });

  it('refuses outright when the server offers none', () => {
    expect(() => resolveVideoModel([], undefined)).toThrow(/offers no video-generation models/);
  });
});

describe('planVideoRequest', () => {
  it('fills the model defaults and validates the result', () => {
    const plan = planVideoRequest(gemini, { prompt: ' a red lighthouse ', withImage: false });
    expect(plan.request).toMatchObject({
      model: gemini.id,
      mode: 'text_to_video',
      prompt: 'a red lighthouse',
      durationSeconds: 6,
      aspectRatio: '16:9',
      resolution: '720p',
    });
  });

  it('refuses a duration the model does not allow instead of rounding it (shared rules)', () => {
    expect(() => planVideoRequest(veo, { prompt: 'x', durationSeconds: 7, withImage: false })).toThrow(
      /unsupported_duration.*allowed: 4, 6, 8s/
    );
    expect(() => planVideoRequest(gemini, { prompt: 'x', durationSeconds: 3.5, withImage: false })).toThrow(
      /unsupported_duration/
    );
  });

  it('refuses an aspect ratio or resolution the model lacks', () => {
    expect(() => planVideoRequest(gemini, { prompt: 'x', aspectRatio: '1:1', withImage: false })).toThrow(
      /unsupported_aspect_ratio/
    );
    expect(() => planVideoRequest(gemini, { prompt: 'x', resolution: '1080p', withImage: false })).toThrow(
      /unsupported_resolution/
    );
    expect(() => planVideoRequest(gemini, { prompt: 'x', resolution: 'huge', withImage: false })).toThrow(
      /not a resolution/
    );
  });

  it('makes an input image an image_to_video request, and refuses it on a text-only model', () => {
    expect(planVideoRequest(grok, { prompt: 'x', withImage: true }).request.mode).toBe('image_to_video');
    const textOnly: VideoModel = { ...grok, id: 'text-only', modes: ['text_to_video'] };
    expect(() => planVideoRequest(textOnly, { prompt: 'x', withImage: true })).toThrow(/unsupported_mode/);
  });

  it('refuses an over-long prompt', () => {
    expect(() => planVideoRequest(gemini, { prompt: 'x'.repeat(4001), withImage: false })).toThrow(/at most 4000/);
  });
});

describe('estimateVideoCredits', () => {
  it('matches the shared estimateCost the server holds credits with', () => {
    const { request } = planVideoRequest(grok, {
      prompt: 'x',
      durationSeconds: 5,
      resolution: '720p',
      withImage: false,
    });
    expect(estimateVideoCredits(grok, request)).toBe(
      estimateVideoCostCredits(VIDEO_MODEL_CATALOG['grok-imagine-video-1.5'], request)
    );
  });

  it('prices a model this build does not know from the credits the server advertises', () => {
    const newer: VideoModel = { ...grok, id: 'future-model', credits_per_second: { '480p': 100 } };
    const { request } = planVideoRequest(newer, { prompt: 'x', durationSeconds: 3, withImage: false });
    expect(estimateVideoCredits(newer, request)).toBe(300);
  });
});

describe('parseVideoModels', () => {
  it('keeps the models it can read and drops one it cannot', () => {
    expect(parseVideoModels({ models: [gemini, { id: 'broken' }] }).map(model => model.id)).toEqual([gemini.id]);
    expect(parseVideoModels(null)).toEqual([]);
  });
});
