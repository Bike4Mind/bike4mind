import { describe, it, expect } from 'vitest';
import { ADAPTER_FAMILIES } from '../types/entities/ModelCatalogTypes';
import { REASONING_SAFE_ADAPTER_FAMILIES, inlinesReasoningIntoText } from './streamVisibility';

describe('inlinesReasoningIntoText', () => {
  it('names only families the catalog actually declares', () => {
    // A typo here would silently refuse a provider it was meant to allow.
    for (const family of REASONING_SAFE_ADAPTER_FAMILIES) {
      expect(ADAPTER_FAMILIES).toContain(family);
    }
  });

  it.each(['kimi', 'deepseek', 'xai', 'ollama', 'bedrock-deepseek', 'bedrock-moonshot'])(
    'refuses %s, which wraps model reasoning in the text channel',
    family => {
      expect(inlinesReasoningIntoText(family)).toBe(true);
    }
  );

  it.each(['openai-chat', 'openai-responses', 'anthropic-messages', 'bedrock-anthropic', 'gemini'])(
    'allows %s, whose reasoning is opt-in and separately indexed',
    family => {
      expect(inlinesReasoningIntoText(family)).toBe(false);
    }
  );

  it('fails closed on a family the catalog cannot describe', () => {
    expect(inlinesReasoningIntoText(undefined)).toBe(true);
    expect(inlinesReasoningIntoText('')).toBe(true);
    expect(inlinesReasoningIntoText('some-future-provider')).toBe(true);
  });
});
