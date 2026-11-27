import { describe, it, expect } from 'vitest';
import { buildContextOverflowMessage, ContextOverflowError, isContextOverflowError } from './contextOverflowMessage';

describe('buildContextOverflowMessage', () => {
  const base = {
    modelName: 'Claude 4.5 Sonnet',
    inputTokens: 244_937,
    maxSafeInputTokens: 135_000,
  };

  it('preserves the size summary with localized token counts', () => {
    const msg = buildContextOverflowMessage({
      ...base,
      tokensBySource: { fabFiles: 243_329, systemPrompts: 1_068, conversationHistory: 270, userPrompt: 270 },
    });
    expect(msg).toContain('Your request is too large for Claude 4.5 Sonnet');
    expect(msg).toContain('244,937 tokens used');
    expect(msg).toContain('135,000 max');
  });

  it('lists the token breakdown sorted by size with readable labels', () => {
    const msg = buildContextOverflowMessage({
      ...base,
      tokensBySource: { fabFiles: 243_329, systemPrompts: 1_068, conversationHistory: 270, userPrompt: 270 },
    });
    expect(msg).toContain('Token breakdown:');
    expect(msg).toContain('• Fab Files: ~243,329 tokens');
    // Largest source must appear before a smaller one.
    expect(msg.indexOf('Fab Files')).toBeLessThan(msg.indexOf('System Prompts'));
  });

  it('surfaces a Fab-File-specific remediation when attached files dominate (#8026)', () => {
    const msg = buildContextOverflowMessage({
      ...base,
      tokensBySource: { fabFiles: 243_329, systemPrompts: 1_068, conversationHistory: 270, userPrompt: 270 },
    });
    expect(msg).toMatch(/Fab File/i);
    expect(msg).toMatch(/remove|detach|split|smaller/i);
  });

  it('surfaces a conversation-history remediation when history dominates', () => {
    const msg = buildContextOverflowMessage({
      modelName: 'Claude 4.5 Sonnet',
      inputTokens: 200_000,
      maxSafeInputTokens: 135_000,
      tokensBySource: { conversationHistory: 180_000, fabFiles: 5_000, systemPrompts: 1_000 },
    });
    expect(msg).toMatch(/new session|history|summari/i);
  });

  it('falls back to a generic remediation when no single source dominates', () => {
    const msg = buildContextOverflowMessage({
      modelName: 'Claude 4.5 Sonnet',
      inputTokens: 200_000,
      maxSafeInputTokens: 135_000,
      tokensBySource: { fabFiles: 70_000, conversationHistory: 70_000, mementos: 60_000 },
    });
    // No source is >= 50% of the total, so we cannot point at one culprit:
    // generic guidance, not the Fab-File-specific "detach files" remediation.
    // (Fab Files still appears in the breakdown list - assert on the hint verb.)
    expect(msg).toMatch(/reduce/i);
    expect(msg).not.toMatch(/detach/i);
  });

  it('labels a lake-retrieval bucket, and gives it generic guidance when it dominates', () => {
    const msg = buildContextOverflowMessage({
      ...base,
      // A new bucket must render as a readable label, not as its camelCase key.
      tokensBySource: { lakeRetrieval: 200_000, fabFiles: 5_000, systemPrompts: 1_068 },
    });

    expect(msg).toContain('• Lake Retrieval: ~200,000 tokens');
    expect(msg.indexOf('Lake Retrieval')).toBeLessThan(msg.indexOf('Fab Files'));
    // Lake content is not user-trimmable, so it deliberately has no remediation of its own and
    // falls back to the generic hint rather than naming a source the user cannot act on.
    expect(msg).toMatch(/reduce/i);
    expect(msg).not.toMatch(/detach/i);
  });

  it('still produces an actionable message when the breakdown is unavailable', () => {
    const msg = buildContextOverflowMessage({
      ...base,
      tokensBySource: undefined,
      messageCount: 10,
      mementoCount: 0,
    });
    expect(msg).toContain('10 messages');
    expect(msg).toMatch(/reduce/i);
  });

  it('always ends with a remediation hint marked for the user', () => {
    const msg = buildContextOverflowMessage({
      ...base,
      tokensBySource: { fabFiles: 243_329 },
    });
    expect(msg).toContain('💡');
  });

  it('always offers switching to a larger-context model', () => {
    const msg = buildContextOverflowMessage({
      modelName: 'Llama 3 Instruct 8B',
      inputTokens: 5_664,
      maxSafeInputTokens: 5_144,
      tokensBySource: { fabFiles: 2_996, systemPrompts: 1_853, toolSchemas: 787, userPrompt: 28 },
    });
    expect(msg).toContain('Your request is too large for Llama 3 Instruct 8B (5,664 tokens used, 5,144 max)');
    expect(msg).toMatch(/Remove or detach some files/);
    expect(msg).toMatch(/switch to a model with a larger context window/);
  });
});

describe('ContextOverflowError', () => {
  it('keeps the user-facing message and carries structured details', () => {
    const details = {
      modelId: 'llama3-8b',
      inputTokens: 5_664,
      maxSafeInputTokens: 5_144,
      contextLimit: 8_192,
      reservedOutputTokens: 3_048,
      tokenBreakdown: { fabFiles: 2_996 },
      messageCount: 3,
      mementoCount: 0,
    };
    const error = new ContextOverflowError('Your request is too large for Llama 3 Instruct 8B', details);
    expect(isContextOverflowError(error)).toBe(true);
    expect(error.message).toBe('Your request is too large for Llama 3 Instruct 8B');
    expect(error.details).toEqual(details);
    expect(isContextOverflowError(new Error('Your request is too large for Llama 3 Instruct 8B'))).toBe(false);
  });
});
