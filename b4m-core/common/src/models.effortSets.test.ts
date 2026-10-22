import { describe, it, expect } from 'vitest';
import {
  ANTHROPIC_OUTPUT_CONFIG_EFFORT_MODELS,
  ChatModels,
  FIXED_TEMPERATURE_MODELS,
  NO_TEMPERATURE_MODELS,
  REASONING_EFFORT_INCOMPATIBLE_WITH_TOOLS_MODELS,
  REASONING_SUPPORTED_MODELS,
} from './models';

const isClaudeId = (id: string): boolean => id.includes('claude');

/**
 * These two sets name two different wire fields on two different APIs, and the easy
 * mistake - adding a Claude id to the OpenAI set because both are called "effort" -
 * has consequences that no type catches: FIXED_TEMPERATURE_MODELS is built by spreading
 * REASONING_SUPPORTED_MODELS, so the id would be pinned to temperature=1 while
 * NO_TEMPERATURE_MODELS says the model rejects temperature outright.
 */
describe('the Anthropic and OpenAI effort sets stay apart', () => {
  it('keeps every Claude model out of REASONING_SUPPORTED_MODELS', () => {
    expect(Array.from(REASONING_SUPPORTED_MODELS).filter(isClaudeId)).toEqual([]);
  });

  // The regression the trap above would cause, asserted on the derived set directly.
  it('keeps every Claude model out of FIXED_TEMPERATURE_MODELS', () => {
    expect(Array.from(FIXED_TEMPERATURE_MODELS).filter(isClaudeId)).toEqual([]);
  });

  it('shares no member between the two effort sets', () => {
    const shared = Array.from(ANTHROPIC_OUTPUT_CONFIG_EFFORT_MODELS).filter(id => REASONING_SUPPORTED_MODELS.has(id));
    expect(shared).toEqual([]);
  });

  it('leaves the documented REASONING_EFFORT_INCOMPATIBLE_WITH_TOOLS_MODELS invariant intact', () => {
    const orphans = Array.from(REASONING_EFFORT_INCOMPATIBLE_WITH_TOOLS_MODELS).filter(
      id => !REASONING_SUPPORTED_MODELS.has(id)
    );
    expect(orphans).toEqual([]);
  });
});

describe('ANTHROPIC_OUTPUT_CONFIG_EFFORT_MODELS', () => {
  it('lists only Claude models', () => {
    expect(Array.from(ANTHROPIC_OUTPUT_CONFIG_EFFORT_MODELS).filter(id => !isClaudeId(id))).toEqual([]);
  });

  /**
   * Effort and the absent sampling knobs are two halves of the adaptive-thinking surface,
   * so the Claude half of NO_TEMPERATURE_MODELS and this set describe the same models. A
   * new adaptive Claude added to one and not the other is the drift this catches.
   */
  it('matches the Claude half of NO_TEMPERATURE_MODELS', () => {
    expect(Array.from(ANTHROPIC_OUTPUT_CONFIG_EFFORT_MODELS).sort()).toEqual(
      Array.from(NO_TEMPERATURE_MODELS).filter(isClaudeId).sort()
    );
  });

  it('covers the current direct-served flagships', () => {
    for (const id of [ChatModels.CLAUDE_5_OPUS, ChatModels.CLAUDE_5_5_OPUS, ChatModels.CLAUDE_5_SONNET]) {
      expect(ANTHROPIC_OUTPUT_CONFIG_EFFORT_MODELS.has(id)).toBe(true);
    }
  });
});
