import { describe, expect, it } from 'vitest';
import { IMAGE_MODEL_CATALOG } from '@bike4mind/common';
import type { StudioCatalog, StudioDraft } from '@shared/studioIpc';
import { planStudioCreation } from './StudioPlan';
import { publicVideoModel } from '../media/__fixtures__/videoModels';

const catalog: StudioCatalog = {
  images: [{ id: 'gpt-image-2', name: 'GPT Image 2', capabilities: IMAGE_MODEL_CATALOG['gpt-image-2'] }],
  videos: [],
  music: [],
  speech: ['openai', 'elevenlabs'],
  soundEffects: ['elevenlabs'],
  voices: [],
};
const draft = (settings: StudioDraft['settings']): StudioDraft => ({
  sessionId: 'session',
  workspaceId: 'family',
  revision: 'revision',
  kind: 'image',
  prompt: 'A bicycle',
  selection: { mode: 'current-session' },
  settings,
});

describe('Studio web-parity request planning', () => {
  it('binds selected image model, count, size, quality and references to one batch request and total estimate', () => {
    const plan = planStudioCreation(
      draft({
        model: 'gpt-image-2',
        count: 3,
        size: '1024x1024',
        quality: 'high',
        references: [{ fileId: '0123456789abcdef01234567', name: 'Reference' }],
      }),
      'Reviewed prompt',
      catalog
    );
    expect(plan.request).toEqual({
      kind: 'image',
      count: 3,
      body: {
        model: 'gpt-image-2',
        mode: 'generate',
        prompt: 'Reviewed prompt',
        size: '1024x1024',
        quality: 'high',
        inputs: [{ role: 'reference', fileId: '0123456789abcdef01234567' }],
      },
    });
    const single = planStudioCreation(
      draft({
        model: 'gpt-image-2',
        count: 1,
        size: '1024x1024',
        quality: 'high',
        references: [{ fileId: '0123456789abcdef01234567', name: 'Reference' }],
      }),
      'Reviewed prompt',
      catalog
    );
    expect(plan.estimatedCredits).toBe(single.estimatedCredits! * 3);
  });
  it('refuses unavailable models instead of selecting the first model', () => {
    expect(() => planStudioCreation(draft({ model: 'unavailable', count: 2 }), 'Prompt', catalog)).toThrow(
      'Choose an available'
    );
    expect(() => planStudioCreation(draft({ model: 'gpt-image-2', size: 'not-a-size' }), 'Prompt', catalog)).toThrow();
  });
  it('preserves provider voice language format and advanced voice settings', () => {
    const plan = planStudioCreation(
      {
        ...draft({
          provider: 'elevenlabs',
          voice: 'voice-id',
          format: 'opus',
          languageCode: 'ja',
          stability: 0.4,
          similarityBoost: 0.8,
        }),
        kind: 'speech',
      },
      'Read this',
      catalog
    );
    expect(plan.request.body).toEqual(
      expect.objectContaining({
        provider: 'elevenlabs',
        voice: 'voice-id',
        format: 'opus',
        languageCode: 'ja',
        stability: 0.4,
        similarityBoost: 0.8,
      })
    );
    expect(() =>
      planStudioCreation(
        { ...draft({ provider: 'openai', format: 'wav', languageCode: 'ja' }), kind: 'speech' },
        'Read this',
        catalog
      )
    ).toThrow('Reset ElevenLabs-only');
  });
  it('sends actual sound-effect duration influence and format', () => {
    const plan = planStudioCreation(
      {
        ...draft({ provider: 'elevenlabs', durationSeconds: 3, promptInfluence: 0.8, format: 'mp3_44100_128' }),
        kind: 'sound-effect',
      },
      'A bell',
      catalog
    );
    expect(plan.request.body).toEqual(
      expect.objectContaining({
        text: 'A bell',
        provider: 'elevenlabs',
        durationSeconds: 3,
        promptInfluence: 0.8,
        format: 'mp3_44100_128',
      })
    );
  });
  it('sends selected video model mode first frame duration aspect resolution and audio', () => {
    const model = { ...publicVideoModel('veo-3.1-fast-generate-preview'), audio: 'optional' as const };
    const c = { ...catalog, videos: [model] };
    const plan = planStudioCreation(
      {
        ...draft({
          model: model.id,
          mode: 'image_to_video',
          durationSeconds: 4,
          aspectRatio: '16:9',
          resolution: '720p',
          audio: false,
          references: [{ fileId: '0123456789abcdef01234567', name: 'First frame' }],
        }),
        kind: 'video',
      },
      'Animate',
      c
    );
    expect(plan.request.body).toEqual(
      expect.objectContaining({
        model: model.id,
        mode: 'image_to_video',
        input_image_file_id: '0123456789abcdef01234567',
        duration_seconds: 4,
        aspect_ratio: '16:9',
        resolution: '720p',
        audio: false,
      })
    );
  });
  it('sends custom lyrics and vocals without dropping unsupported combinations', () => {
    const c: StudioCatalog = {
      ...catalog,
      music: [
        {
          id: 'music_v2_5',
          object: 'music_model',
          display_name: 'Music v2.5',
          provider: 'elevenlabs',
          vocals: 'optional',
          lyrics: { max_chars: 10000, max_line_chars: 200 },
          duration: { control: 'exact', min: 3, max: 300, default: 60 },
          output_formats: ['mp3'],
          typical_render_seconds: 60,
          pricing: { unit: 'per_second', credits: 5 },
          preview: false,
          deprecation_date: null,
        },
      ],
    };
    const input = {
      ...draft({ model: 'music_v2_5', durationSeconds: 45, instrumental: false, lyrics: 'Sing this line' }),
      kind: 'music' as const,
    };
    expect(planStudioCreation(input, 'A song', c).request.body).toEqual(
      expect.objectContaining({
        model: 'music_v2_5',
        duration_seconds: 45,
        instrumental: false,
        lyrics: 'Sing this line',
      })
    );
    expect(() =>
      planStudioCreation({ ...input, settings: { ...input.settings, instrumental: true } }, 'A song', c)
    ).toThrow('Instrumental turned off');
  });
});
