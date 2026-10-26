import { describe, it, expect } from 'vitest';
import { ADAPTIVE_THINKING_MAX_TOKENS_FLOOR, type ModelInfo } from '@bike4mind/common';
import { buildReActAgentRuntimeConfig, runReasoningShortfall } from './agentExecutor.reActAgentConfig';

describe('buildReActAgentRuntimeConfig', () => {
  it('returns an empty object when no knobs are set (preserves ReActAgent defaults)', () => {
    expect(buildReActAgentRuntimeConfig({})).toEqual({});
  });

  it('forwards temperature only when defined (0 is a valid setting and must pass through)', () => {
    expect(buildReActAgentRuntimeConfig({ temperature: 0.5 })).toEqual({ temperature: 0.5 });
    expect(buildReActAgentRuntimeConfig({ temperature: 0 })).toEqual({ temperature: 0 });
    expect(buildReActAgentRuntimeConfig({})).not.toHaveProperty('temperature');
  });

  it('forwards maxTokens only when defined', () => {
    expect(buildReActAgentRuntimeConfig({ maxTokens: 2048 })).toEqual({ maxTokens: 2048 });
    expect(buildReActAgentRuntimeConfig({})).not.toHaveProperty('maxTokens');
  });

  it('does NOT spread thinking when enabled is false (guards the structuredClone regression)', () => {
    // The headline bug: the client LLM store ships `{ enabled: false, budget_tokens: 16000 }`
    // as a baseline on every dispatch. If that survives into the ReActAgent ctor and
    // gets stored on the checkpoint, `toCheckpoint()`'s `structuredClone()` can fail
    // ("Cannot transfer object of unsupported type") for some model permutations.
    const result = buildReActAgentRuntimeConfig({ thinking: { enabled: false, budget_tokens: 16000 } });
    expect(result).not.toHaveProperty('thinking');
  });

  it('does NOT spread thinking when the object is omitted entirely', () => {
    expect(buildReActAgentRuntimeConfig({})).not.toHaveProperty('thinking');
  });

  it('spreads thinking when enabled is true, defaulting budget_tokens to 16000', () => {
    const result = buildReActAgentRuntimeConfig({ thinking: { enabled: true } });
    expect(result.thinking).toEqual({ enabled: true, budget_tokens: 16000 });
  });

  it('preserves a caller-supplied budget_tokens when thinking is enabled', () => {
    const result = buildReActAgentRuntimeConfig({ thinking: { enabled: true, budget_tokens: 8000 } });
    expect(result.thinking).toEqual({ enabled: true, budget_tokens: 8000 });
  });

  it('combines all three knobs correctly when set together', () => {
    const result = buildReActAgentRuntimeConfig({
      temperature: 0.7,
      maxTokens: 4096,
      thinking: { enabled: true, budget_tokens: 12000 },
    });
    expect(result).toEqual({
      temperature: 0.7,
      maxTokens: 4096,
      thinking: { enabled: true, budget_tokens: 12000 },
    });
  });
});

describe('runReasoningShortfall', () => {
  const adaptive = {
    id: 'adaptive-model',
    type: 'text',
    backend: 'anthropic',
    can_think: true,
    thinkingStyle: 'adaptive',
    max_tokens: 128_000,
  } as ModelInfo;

  it('reports a budget below the reasoning floor on the first invocation', () => {
    expect(runReasoningShortfall({ maxTokens: 8192 }, adaptive, true)).toEqual({
      requested: 8192,
      floor: ADAPTIVE_THINKING_MAX_TOKENS_FLOOR,
    });
  });

  // A continuation carries the same budget; counting it again would double the run.
  it('does not report on a continuation', () => {
    expect(runReasoningShortfall({ maxTokens: 8192 }, adaptive, false)).toBeUndefined();
  });

  it('does not report without a model, without a budget, or at the floor', () => {
    expect(runReasoningShortfall({ maxTokens: 8192 }, undefined, true)).toBeUndefined();
    expect(runReasoningShortfall({}, adaptive, true)).toBeUndefined();
    expect(runReasoningShortfall({ maxTokens: ADAPTIVE_THINKING_MAX_TOKENS_FLOOR }, adaptive, true)).toBeUndefined();
  });

  // The Anthropic adapter raises a thinking run to the floor, so only a disabled toggle leaves it short.
  it('follows the thinking the agent is built with', () => {
    expect(runReasoningShortfall({ maxTokens: 8192, thinking: { enabled: true } }, adaptive, true)).toBeUndefined();
    expect(runReasoningShortfall({ maxTokens: 8192, thinking: { enabled: false } }, adaptive, true)).toBeDefined();
  });
});
