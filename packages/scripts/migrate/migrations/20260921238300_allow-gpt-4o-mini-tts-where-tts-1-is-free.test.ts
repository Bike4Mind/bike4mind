import { describe, it, expect } from 'vitest';
import { TTS_DEFAULT_MODEL } from '@bike4mind/common';

import { withNewTtsDefault } from './20260921238300_allow-gpt-4o-mini-tts-where-tts-1-is-free';

describe('allow-gpt-4o-mini-tts-where-tts-1-is-free', () => {
  // The migration's literal must be the model admission actually checks for OpenAI TTS.
  it('adds the current OpenAI TTS default', () => {
    expect(withNewTtsDefault(['tts-1'])).toEqual(['tts-1', TTS_DEFAULT_MODEL.openai]);
  });

  it('keeps the JSON-string storage shape', () => {
    expect(withNewTtsDefault('["cheap-text","tts-1"]')).toBe('["cheap-text","tts-1","gpt-4o-mini-tts"]');
  });

  it.each([
    ['tts-1 not allowlisted', '["cheap-text","tts-1-hd"]'],
    ['already allowlisted', '["tts-1","gpt-4o-mini-tts"]'],
    ['unparseable string', 'tts-1'],
    ['not a list', '{"tts-1":true}'],
    ['missing', undefined],
  ])('leaves the value alone when %s', (_case, value) => {
    expect(withNewTtsDefault(value)).toBeNull();
  });
});
