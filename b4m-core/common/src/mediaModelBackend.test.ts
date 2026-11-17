import { describe, expect, it } from 'vitest';
import { IMAGE_MODELS, ModelBackend } from './models';
import { VIDEO_MODEL_IDS } from './video/catalog';
import { MUSIC_MODEL_IDS } from './music/catalog';
import { TTS_DEFAULT_MODEL } from './voicePricing';
import { resolveMediaModelBackend } from './mediaModelBackend';

describe('resolveMediaModelBackend', () => {
  it('resolves every image model, so a provider allowlist can admit it', () => {
    const unresolved = IMAGE_MODELS.filter(id => resolveMediaModelBackend(id) === undefined);
    expect(unresolved).toEqual([]);
  });

  it('resolves runtime local image checkpoints and marks the unrepresentable image test provider', () => {
    expect(resolveMediaModelBackend('local-image/sd-xl')).toBe(ModelBackend.LocalImage);
    expect(resolveMediaModelBackend('test-image')).toBeNull();
    expect(resolveMediaModelBackend('local-image-lookalike')).toBeUndefined();
  });

  it('recognizes every video model and explicitly marks the unrepresentable test provider', () => {
    const unresolved = VIDEO_MODEL_IDS.filter(id => resolveMediaModelBackend(id) === undefined);
    expect(unresolved).toEqual([]);
    expect(resolveMediaModelBackend('test-video')).toBeNull();
  });

  it('resolves OpenAI TTS models and explicitly marks vendors with no ModelBackend', () => {
    expect(resolveMediaModelBackend(TTS_DEFAULT_MODEL.openai)).toBe('openai');
    expect(resolveMediaModelBackend('tts-1-hd')).toBe('openai');
    expect(resolveMediaModelBackend(TTS_DEFAULT_MODEL.elevenlabs)).toBeNull();
    expect(resolveMediaModelBackend('music_v1')).toBeNull();
  });

  it('recognizes every music model, admitting Lyria under Gemini while retaining unknown-provider refusals', () => {
    expect(MUSIC_MODEL_IDS.filter(id => resolveMediaModelBackend(id) === undefined)).toEqual([]);
    expect(resolveMediaModelBackend('lyria-3.5')).toBe('gemini');
    expect(resolveMediaModelBackend('lyria-3-clip-preview')).toBe('gemini');
    expect(resolveMediaModelBackend('test-music')).toBeNull();
    expect(resolveMediaModelBackend('music_v2_5')).toBeNull();
  });

  it('ignores unknown ids and inherited object keys', () => {
    expect(resolveMediaModelBackend('gpt-4o')).toBeUndefined();
    expect(resolveMediaModelBackend('toString')).toBeUndefined();
    expect(resolveMediaModelBackend('constructor')).toBeUndefined();
  });
});
