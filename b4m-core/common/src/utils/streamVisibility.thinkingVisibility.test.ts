import { describe, expect, it } from 'vitest';
import {
  createReasoningWithholder,
  isThinkingVisibility,
  providerSummarizesReasoning,
  withholdsReasoning,
} from './streamVisibility';

describe('providerSummarizesReasoning', () => {
  it.each(['claude-sonnet-4-5', 'claude-opus-5-5', 'us.anthropic.claude-opus-4-1-20250805-v1:0'])(
    'is true for Claude 4 and later (%s)',
    modelId => {
      expect(providerSummarizesReasoning(modelId)).toBe(true);
    }
  );

  it.each([
    'claude-3-7-sonnet-20250219',
    'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
    'deepseek-reasoner',
    'grok-4',
  ])('is false for models that return the raw trace (%s)', modelId => {
    expect(providerSummarizesReasoning(modelId)).toBe(false);
  });
});

describe('withholdsReasoning', () => {
  it('never withholds at raw', () => {
    expect(withholdsReasoning('raw', 'deepseek-reasoner')).toBe(false);
  });

  it('always withholds at none, summarizing models included', () => {
    expect(withholdsReasoning('none', 'claude-sonnet-4-5')).toBe(true);
  });

  it('withholds at summary only where the provider returns the raw trace', () => {
    expect(withholdsReasoning('summary', 'claude-sonnet-4-5')).toBe(false);
    expect(withholdsReasoning('summary', 'kimi-k2-thinking')).toBe(true);
    expect(withholdsReasoning('summary', 'claude-3-7-sonnet-20250219')).toBe(true);
  });
});

describe('isThinkingVisibility', () => {
  it('accepts the three levels and nothing else', () => {
    expect(['raw', 'summary', 'none'].every(isThinkingVisibility)).toBe(true);
    expect(isThinkingVisibility('full')).toBe(false);
    expect(isThinkingVisibility(undefined)).toBe(false);
  });
});

describe('createReasoningWithholder', () => {
  it('drops reasoning-tagged frames, markers included', () => {
    const withholder = createReasoningWithholder();
    expect(withholder.visible('<think>', 'reasoning')).toBe('');
    expect(withholder.visible('weighing options', 'reasoning')).toBe('');
    expect(withholder.visible('</think>', 'reasoning')).toBe('');
    expect(withholder.visible('The answer.')).toBe('The answer.');
  });

  it('drops an inline span that opens and closes across untagged chunks', () => {
    const withholder = createReasoningWithholder();
    const chunks = ['<think>first ', 'second', '</think>The answer', ' is 42.'];
    expect(chunks.map(chunk => withholder.visible(chunk)).join('')).toBe('The answer is 42.');
  });

  it('keeps a stray close marker that opened nothing', () => {
    const withholder = createReasoningWithholder();
    expect(withholder.visible('a </think> b')).toBe('a </think> b');
  });

  it('hides a reopened span while it is still open', () => {
    const withholder = createReasoningWithholder();
    expect(withholder.visible('Answer. <think>more')).toBe('Answer. ');
    expect(withholder.visible(' still thinking')).toBe('');
  });

  it('passes tool artifact frames through', () => {
    const withholder = createReasoningWithholder();
    expect(withholder.visible('{"rows":1}', 'tool-artifact')).toBe('{"rows":1}');
  });
});
