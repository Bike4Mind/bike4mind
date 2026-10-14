import { describe, it, expect } from 'vitest';
import { buildReActAgentRuntimeConfig } from './agentExecutor.reActAgentConfig';

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
