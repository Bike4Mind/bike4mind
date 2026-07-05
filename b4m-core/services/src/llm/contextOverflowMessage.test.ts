import { describe, it, expect } from 'vitest';
import { buildContextOverflowMessage } from './contextOverflowMessage';

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
});
