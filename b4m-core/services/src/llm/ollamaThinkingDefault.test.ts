import { describe, it, expect } from 'vitest';
import { ModelBackend } from '@bike4mind/common';
import { withOllamaThinkingDefault } from './ollamaThinkingDefault';

const OFF = { enabled: false, budget_tokens: 0 };

describe('withOllamaThinkingDefault', () => {
  it('turns thinking off for an Ollama thinking model sent no option', () => {
    expect(withOllamaThinkingDefault(undefined, { backend: ModelBackend.Ollama, can_think: true })).toEqual(OFF);
  });

  it('keeps an explicit option for an Ollama thinking model', () => {
    const on = { enabled: true, budget_tokens: 16000 };
    expect(withOllamaThinkingDefault(on, { backend: ModelBackend.Ollama, can_think: true })).toBe(on);
  });

  it('adds nothing for an Ollama model that cannot think', () => {
    expect(withOllamaThinkingDefault(undefined, { backend: ModelBackend.Ollama, can_think: false })).toBeUndefined();
  });

  it.each([ModelBackend.Anthropic, ModelBackend.OpenAI, ModelBackend.DeepSeek])(
    'adds nothing for %s, where an explicit off is not the same as no flag',
    backend => {
      expect(withOllamaThinkingDefault(undefined, { backend, can_think: true })).toBeUndefined();
    }
  );

  it('adds nothing without model info', () => {
    expect(withOllamaThinkingDefault(undefined, undefined)).toBeUndefined();
  });
});
