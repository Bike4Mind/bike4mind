import { describe, expect, it } from 'vitest';
import { GENERATION_JOB_ERROR_CODES } from '../types/entities/GenerationJobTypes';
import {
  CreateSceneCompositionBodySchema,
  SCENE_JOB_PUBLIC_ERROR_CODES,
  toPublicSceneJobErrorCode,
} from '../schemas/sceneCompositions';
import { SceneCompositionRequestSchema, toStoredSceneCompositionRequest } from './index';

const VIDEO_ID = 'a'.repeat(24);
const AUDIO_ID = 'b'.repeat(24);

describe('SceneCompositionRequestSchema', () => {
  it('resolves every audio default for a minimal request', () => {
    const parsed = SceneCompositionRequestSchema.parse({ videoFileId: VIDEO_ID, audioFileId: AUDIO_ID });
    expect(toStoredSceneCompositionRequest(parsed)).toEqual({
      videoFileId: VIDEO_ID,
      audioFileId: AUDIO_ID,
      audio: { fit: 'trim', fadeInSeconds: 0, fadeOutSeconds: 1.5 },
    });
  });

  it('keeps the fields the caller set and trims the title', () => {
    const parsed = SceneCompositionRequestSchema.parse({
      videoFileId: VIDEO_ID,
      audioFileId: AUDIO_ID,
      coverFileId: 'c'.repeat(24),
      audio: { fit: 'loop', fadeOutSeconds: 0 },
      title: '  Sunrise ',
    });
    expect(toStoredSceneCompositionRequest(parsed)).toEqual({
      videoFileId: VIDEO_ID,
      audioFileId: AUDIO_ID,
      coverFileId: 'c'.repeat(24),
      audio: { fit: 'loop', fadeInSeconds: 0, fadeOutSeconds: 0 },
      title: 'Sunrise',
    });
  });

  it('accepts a fade of exactly 10 seconds', () => {
    const parsed = SceneCompositionRequestSchema.parse({
      videoFileId: VIDEO_ID,
      audioFileId: AUDIO_ID,
      audio: { fadeInSeconds: 10, fadeOutSeconds: 10 },
    });
    expect(parsed.audio).toMatchObject({ fadeInSeconds: 10, fadeOutSeconds: 10 });
  });

  it.each([
    ['an uppercase file id', { videoFileId: 'A'.repeat(24) }],
    ['a fade over the cap', { audio: { fadeInSeconds: 10.5 } }],
    ['a negative fade', { audio: { fadeOutSeconds: -1 } }],
    ['an unknown fit', { audio: { fit: 'stretch' } }],
    ['an unknown field', { volume: 2 }],
    ['a blank title', { title: '   ' }],
    ['a title over the cap', { title: 'x'.repeat(201) }],
  ])('rejects %s', (_label, extra) => {
    expect(
      SceneCompositionRequestSchema.safeParse({ videoFileId: VIDEO_ID, audioFileId: AUDIO_ID, ...extra }).success
    ).toBe(false);
  });
});

describe('CreateSceneCompositionBodySchema', () => {
  it('accepts mixed-case hex ids on the wire (the route lowercases them)', () => {
    expect(
      CreateSceneCompositionBodySchema.safeParse({ video_file_id: 'A'.repeat(24), audio_file_id: AUDIO_ID }).success
    ).toBe(true);
  });

  it('rejects camelCase fields rather than ignoring them', () => {
    expect(CreateSceneCompositionBodySchema.safeParse({ videoFileId: VIDEO_ID, audioFileId: AUDIO_ID }).success).toBe(
      false
    );
  });
});

describe('toPublicSceneJobErrorCode', () => {
  it('maps every internal job error code onto a published one', () => {
    for (const code of GENERATION_JOB_ERROR_CODES) {
      expect(SCENE_JOB_PUBLIC_ERROR_CODES).toContain(toPublicSceneJobErrorCode(code));
    }
  });

  it('reports an unusable input as unsupported_input, never as a provider failure', () => {
    expect(toPublicSceneJobErrorCode('unsupported_input')).toBe('unsupported_input');
    expect(toPublicSceneJobErrorCode('input_image_not_found')).toBe('unsupported_input');
  });
});
