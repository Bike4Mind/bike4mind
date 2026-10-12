import { describe, it, expect } from 'vitest';
import { ImageModels, ModelInfo } from '@bike4mind/common';
import { estimateGeneratedMediaUsd } from './agentToolMediaCost';
import { estimateMusicCredits } from '../musicCost';
import { estimateAudioCredits } from '../audioCost';
import { estimateImageCredits } from '../imageCost';

// Grok Imagine is a flat 0.055 USD/image (no size/quality inputs), so it keeps the
// image assertions independent of the size/quality cost matrix.
const grokModel = { id: ImageModels.GROK_IMAGINE_IMAGE_QUALITY } as ModelInfo;
const models = [grokModel];

describe('estimateGeneratedMediaUsd', () => {
  it('speech audio equals the estimateAudioCredits USD (identical to the direct/classic path)', () => {
    const data = { kind: 'speech', provider: 'openai', model: 'tts-1', characters: 4096, paths: ['a.mp3'] };
    expect(estimateGeneratedMediaUsd('audio_generation', data, models)).toBe(
      estimateAudioCredits({ kind: 'speech', provider: 'openai', model: 'tts-1', characters: 4096 }).usdCost
    );
  });

  it('sound-effect audio equals the estimateAudioCredits USD', () => {
    const data = { kind: 'sound_effect', provider: 'elevenlabs', durationSeconds: 3, paths: ['a.mp3'] };
    expect(estimateGeneratedMediaUsd('audio_generation', data, models)).toBe(
      estimateAudioCredits({ kind: 'sound_effect', provider: 'elevenlabs', durationSeconds: 3 }).usdCost
    );
  });

  it('music equals the estimateMusicCredits USD', () => {
    const data = { provider: 'elevenlabs', lengthMs: 20000, modelId: 'm', paths: ['a.mp3'] };
    expect(estimateGeneratedMediaUsd('music_generation', data, models)).toBe(
      estimateMusicCredits('elevenlabs', { lengthMs: 20000 }).usdCost
    );
  });

  it('image is the per-image USD scaled by n (flat 0.055/image for Grok Imagine)', () => {
    const data = { model: ImageModels.GROK_IMAGINE_IMAGE_QUALITY, n: 2, prompt: 'x' };
    expect(estimateGeneratedMediaUsd('image_generation', data, models)).toBeCloseTo(0.11, 6);
  });

  it('edit_image is priced like image_generation', () => {
    const data = { model: ImageModels.GROK_IMAGINE_IMAGE_QUALITY, n: 1, prompt: 'x' };
    expect(estimateGeneratedMediaUsd('edit_image', data, models)).toBeGreaterThan(0);
  });

  it('edit_image bills its one source image as input on a GPT model; image_generation does not', () => {
    const gpt = { id: ImageModels.GPT_IMAGE_2 } as ModelInfo;
    const data = { model: ImageModels.GPT_IMAGE_2, n: 1, quality: 'high', size: '1024x1024' };
    const input = { model: data.model, size: data.size, quality: data.quality } as const;
    expect(estimateGeneratedMediaUsd('image_generation', data, [gpt])).toBe(
      estimateImageCredits(gpt, 1, input).usdCost
    );
    expect(estimateGeneratedMediaUsd('edit_image', data, [gpt])).toBe(
      estimateImageCredits(gpt, 1, { ...input, inputImageCount: 1 }).usdCost
    );
  });

  it('returns 0 for a non-media tool', () => {
    expect(estimateGeneratedMediaUsd('web_search', { anything: true }, models)).toBe(0);
  });

  it('returns 0 for an image model not in the catalog (cannot price)', () => {
    expect(estimateGeneratedMediaUsd('image_generation', { model: 'unknown-model', n: 1 }, models)).toBe(0);
  });

  it('returns 0 when the payload is missing the fields the estimator needs', () => {
    expect(estimateGeneratedMediaUsd('audio_generation', { kind: 'speech' }, models)).toBe(0);
    expect(estimateGeneratedMediaUsd('music_generation', { provider: 'elevenlabs' }, models)).toBe(0);
    expect(estimateGeneratedMediaUsd('image_generation', { n: 1 }, models)).toBe(0);
  });
});
