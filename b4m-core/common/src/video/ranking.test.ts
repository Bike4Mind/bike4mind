import { describe, expect, it } from 'vitest';
import { MODEL_UNAVAILABLE_CODE } from '../generation/modelRanking';
import { VIDEO_MODEL_IDS } from './catalog';
import { rankVideoModels, type VideoRankingRequest } from './ranking';

const TEXT: VideoRankingRequest = {
  mode: 'text_to_video',
  durationSeconds: 6,
  aspectRatio: '16:9',
  resolution: '720p',
};

describe('rankVideoModels', () => {
  it('opens on the newest flagship and never offers a retired one as fitting', () => {
    const ranked = rankVideoModels(VIDEO_MODEL_IDS, TEXT);
    expect(ranked.map(model => model.id)).toEqual([
      'flux-3-video',
      'grok-imagine-video-1.5',
      'gemini-omni-1.1-flash',
      'test-video',
      'veo-3.1-fast-generate-preview',
    ]);
    expect(ranked[0]).toMatchObject({ status: 'fits', pickedFor: ['detailed scenes'] });
    expect(ranked.find(model => model.id === 'veo-3.1-fast-generate-preview')).toMatchObject({
      status: 'unavailable',
      whyNot: { code: MODEL_UNAVAILABLE_CODE },
    });
  });

  it('sinks a text-only model when the request animates an image', () => {
    const ranked = rankVideoModels(['flux-3-video', 'grok-imagine-video-1.5'], {
      ...TEXT,
      mode: 'image_to_video',
      inputs: [{ role: 'first_frame', fileId: 'file-1' }],
    });
    expect(ranked.map(model => model.id)).toEqual(['grok-imagine-video-1.5', 'flux-3-video']);
    expect(ranked[0].pickedFor).toEqual(['stylised motion', 'your starting image']);
    expect(ranked[1].whyNot?.code).toBe('unsupported_mode');
  });

  it('sinks a model that cannot take the aspect ratio', () => {
    const ranked = rankVideoModels(['gemini-omni-1.1-flash', 'grok-imagine-video-1.5'], {
      ...TEXT,
      aspectRatio: '4:3',
    });
    expect(ranked[0].id).toBe('grok-imagine-video-1.5');
    expect(ranked[1].whyNot?.code).toBe('unsupported_aspect_ratio');
  });
});
