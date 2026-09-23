import { describe, it, expect } from 'vitest';
import { ADAPTER_FAMILIES } from '../types/entities/ModelCatalogTypes';
import { REASONING_CHANNEL_BY_ADAPTER_FAMILY, inlinesReasoningIntoText } from './streamVisibility';

describe('REASONING_CHANNEL_BY_ADAPTER_FAMILY', () => {
  // A family missing here would be refused by omission, silently breaking an existing
  // backend; one named here that the catalog does not declare is a typo.
  it.each(ADAPTER_FAMILIES)('classifies %s', family => {
    expect(REASONING_CHANNEL_BY_ADAPTER_FAMILY[family]).toBeDefined();
  });

  it('names no family the catalog does not declare', () => {
    for (const family of Object.keys(REASONING_CHANNEL_BY_ADAPTER_FAMILY)) {
      expect(ADAPTER_FAMILIES).toContain(family);
    }
  });
});

describe('inlinesReasoningIntoText', () => {
  it.each(['xai', 'kimi', 'deepseek', 'ollama', 'bedrock-deepseek', 'bedrock-moonshot'])(
    'refuses %s, which wraps model reasoning at the prose index',
    family => {
      expect(inlinesReasoningIntoText(family)).toBe(true);
    }
  );

  it.each(['openai-chat', 'openai-responses', 'gemini', 'bedrock-llama', 'bedrock-jurassic', 'bedrock-titan'])(
    'admits %s, which returns no reasoning text at all',
    family => {
      expect(inlinesReasoningIntoText(family)).toBe(false);
    }
  );

  it.each(['anthropic-messages', 'bedrock-anthropic'])(
    'admits %s, whose reasoning is opt-in and off unless the caller asks',
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
