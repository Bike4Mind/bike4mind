import { describe, expect, it } from 'vitest';
import {
  createReasoningWithholder,
  isThinkingVisibility,
  providerSummarizesReasoning,
  reasoningChannelOf,
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

describe('reasoningChannelOf', () => {
  it('reads the adapter family first', () => {
    expect(reasoningChannelOf({ id: 'x', backend: 'bedrock', adapterFamily: 'bedrock-deepseek' })).toBe('always');
    expect(reasoningChannelOf({ id: 'x', adapterFamily: 'openai-responses' })).toBe('never');
  });

  it('infers Claude rows as opt-in and fails closed on anything unknown', () => {
    expect(reasoningChannelOf({ id: 'claude-sonnet-4-5', backend: 'anthropic' })).toBe('opt-in');
    expect(reasoningChannelOf({ id: 'us.anthropic.claude-opus-4-1-20250805-v1:0', backend: 'bedrock' })).toBe('opt-in');
    expect(reasoningChannelOf({ id: 'claude-sonnet-4-5' })).toBe('opt-in');
    expect(reasoningChannelOf({ id: 'gpt-5', backend: 'openai' })).toBe('never');
    expect(reasoningChannelOf({ id: 'qwen3:8b', backend: 'ollama' })).toBe('always');
    expect(reasoningChannelOf({ id: 'mystery' })).toBe('always');
  });
});

describe('createReasoningWithholder', () => {
  describe('opt-in families', () => {
    it('drops reasoning-tagged frames, markers included', () => {
      const withholder = createReasoningWithholder('opt-in');
      expect(withholder.visible('<think>', 'reasoning')).toBe('');
      expect(withholder.visible('weighing options', 'reasoning')).toBe('');
      expect(withholder.visible('</think>', 'reasoning')).toBe('');
      expect(withholder.visible('The answer.')).toBe('The answer.');
    });

    it('drops an untagged frame that is only a marker', () => {
      const withholder = createReasoningWithholder('opt-in');
      expect(withholder.visible('</think>')).toBe('');
    });

    it('keeps an answer that mentions the marker literally', () => {
      const withholder = createReasoningWithholder('opt-in');
      const answer = ['Wrap the trace in <think> and close it with ', '</think> tags.', ' Done.'];
      expect(answer.map(chunk => withholder.visible(chunk)).join('')).toBe(answer.join(''));
      expect(withholder.flush()).toBe('');
    });
  });

  it('passes everything through for families that return no reasoning', () => {
    const withholder = createReasoningWithholder('never');
    expect(withholder.visible('<think>literal</think>')).toBe('<think>literal</think>');
  });

  describe('inline families', () => {
    it('drops a span that opens and closes across chunks', () => {
      const withholder = createReasoningWithholder('always');
      const chunks = ['<think>first ', 'second', '</think>The answer', ' is 42.'];
      expect(chunks.map(chunk => withholder.visible(chunk)).join('') + withholder.flush()).toBe('The answer is 42.');
    });

    it('drops a span whose markers are split across chunks', () => {
      const withholder = createReasoningWithholder('always');
      const chunks = ['<th', 'ink>trace</th', 'ink>Answer.'];
      expect(chunks.map(chunk => withholder.visible(chunk)).join('') + withholder.flush()).toBe('Answer.');
    });

    it('releases a held partial marker once it proves to be text', () => {
      const withholder = createReasoningWithholder('always');
      expect(withholder.visible('a <')).toBe('a ');
      expect(withholder.visible('b')).toBe('<b');
      expect(withholder.visible('ends with <th')).toBe('ends with ');
      expect(withholder.flush()).toBe('<th');
    });

    it('keeps a stray close marker that opened nothing', () => {
      const withholder = createReasoningWithholder('always');
      expect(withholder.visible('a </think> b')).toBe('a </think> b');
    });

    it('hides a reopened span while it is still open', () => {
      const withholder = createReasoningWithholder('always');
      expect(withholder.visible('Answer. <think>more')).toBe('Answer. ');
      expect(withholder.visible(' still thinking')).toBe('');
    });

    it('passes tool artifact frames through', () => {
      const withholder = createReasoningWithholder('always');
      expect(withholder.visible('{"rows":1}', 'tool-artifact')).toBe('{"rows":1}');
    });
  });
});
