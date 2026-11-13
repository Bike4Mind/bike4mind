import { describe, expect, it } from 'vitest';
import { IMAGE_MODELS } from './models';
import { VIDEO_MODEL_IDS } from './video/catalog';
import { TTS_DEFAULT_MODEL } from './voicePricing';
import { resolveMediaModelBackend } from './mediaModelBackend';

describe('resolveMediaModelBackend', () => {
  it('resolves every image model, so a provider allowlist can admit it', () => {
    const unresolved = IMAGE_MODELS.filter(id => resolveMediaModelBackend(id) === undefined);
    expect(unresolved).toEqual([]);
  });

  it('resolves every video model except the non-production test provider', () => {
    const unresolved = VIDEO_MODEL_IDS.filter(id => resolveMediaModelBackend(id) === undefined);
    expect(unresolved).toEqual(['test-video']);
  });

  it('resolves OpenAI TTS models and leaves vendors with no ModelBackend unresolved', () => {
    expect(resolveMediaModelBackend(TTS_DEFAULT_MODEL.openai)).toBe('openai');
    expect(resolveMediaModelBackend('tts-1-hd')).toBe('openai');
    expect(resolveMediaModelBackend(TTS_DEFAULT_MODEL.elevenlabs)).toBeUndefined();
    expect(resolveMediaModelBackend('music_v1')).toBeUndefined();
  });

  it('ignores unknown ids and inherited object keys', () => {
    expect(resolveMediaModelBackend('gpt-4o')).toBeUndefined();
    expect(resolveMediaModelBackend('toString')).toBeUndefined();
    expect(resolveMediaModelBackend('constructor')).toBeUndefined();
  });
});
