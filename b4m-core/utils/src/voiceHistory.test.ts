import { describe, it, expect } from 'vitest';
import { formatVoiceHistory, buildVoiceInstructions } from './voiceHistory';
import { IChatHistoryItemDocument } from '@bike4mind/common';

// Helper to create mock history items
function createMockHistoryItem(prompt: string, reply: string, id = 'test-id'): Partial<IChatHistoryItemDocument> {
  return {
    id,
    prompt,
    replies: [reply],
  };
}

describe('formatVoiceHistory', () => {
  describe('empty history handling', () => {
    it('should return empty string for null history', () => {
      const result = formatVoiceHistory(null as unknown as IChatHistoryItemDocument[]);
      expect(result).toBe('');
    });

    it('should return empty string for undefined history', () => {
      const result = formatVoiceHistory(undefined as unknown as IChatHistoryItemDocument[]);
      expect(result).toBe('');
    });

    it('should return empty string for empty array', () => {
      const result = formatVoiceHistory([]);
      expect(result).toBe('');
    });
  });

  describe('basic formatting', () => {
    it('should format single history item correctly', () => {
      const history = [createMockHistoryItem('Hello', 'Hi there!')] as IChatHistoryItemDocument[];

      const result = formatVoiceHistory(history);

      expect(result).toContain('CONVERSATION CONTEXT:');
      expect(result).toContain('User: Hello');
      expect(result).toContain('Assistant: Hi there!');
    });

    it('should format multiple history items in order', () => {
      const history = [
        createMockHistoryItem('First question', 'First answer'),
        createMockHistoryItem('Second question', 'Second answer'),
      ] as IChatHistoryItemDocument[];

      const result = formatVoiceHistory(history);

      // Check order - first should come before second
      const firstUserIndex = result.indexOf('User: First question');
      const secondUserIndex = result.indexOf('User: Second question');
      expect(firstUserIndex).toBeLessThan(secondUserIndex);
    });

    it('should handle items with only prompt (no reply)', () => {
      const history = [{ id: 'test', prompt: 'Question without answer' }] as IChatHistoryItemDocument[];

      const result = formatVoiceHistory(history);

      expect(result).toContain('User: Question without answer');
      expect(result).not.toContain('Assistant:');
    });

    it('should skip thinking blocks in replies', () => {
      const history = [
        {
          id: 'test',
          prompt: 'Question',
          replies: ['<think>internal thinking</think>', 'Actual response'],
        },
      ] as IChatHistoryItemDocument[];

      const result = formatVoiceHistory(history);

      expect(result).not.toContain('<think>');
      expect(result).toContain('Assistant: Actual response');
    });
  });

  describe('truncation', () => {
    it('should truncate long messages to maxCharsPerMessage', () => {
      const longMessage = 'A'.repeat(500);
      const history = [createMockHistoryItem(longMessage, 'Short reply')] as IChatHistoryItemDocument[];

      const result = formatVoiceHistory(history, { maxCharsPerMessage: 100 });

      // Should be truncated with ellipsis
      expect(result).toContain('A'.repeat(97) + '...');
    });

    it('should truncate overall result to maxChars', () => {
      const history = Array.from({ length: 20 }, (_, i) =>
        createMockHistoryItem(`Question ${i}`, `Answer ${i}`)
      ) as IChatHistoryItemDocument[];

      const result = formatVoiceHistory(history, { maxChars: 500 });

      expect(result.length).toBeLessThanOrEqual(500);
      expect(result).toContain('...');
    });

    it('should respect recentMessageCount option', () => {
      const history = Array.from({ length: 10 }, (_, i) =>
        createMockHistoryItem(`Question ${i}`, `Answer ${i}`)
      ) as IChatHistoryItemDocument[];

      const result = formatVoiceHistory(history, { recentMessageCount: 3 });

      // Should only include last 3 items (7, 8, 9)
      expect(result).not.toContain('Question 0');
      expect(result).not.toContain('Question 6');
      expect(result).toContain('Question 7');
      expect(result).toContain('Question 8');
      expect(result).toContain('Question 9');
    });
  });

  describe('default options', () => {
    it('should use default maxChars of 3000', () => {
      const history = Array.from({ length: 100 }, (_, i) =>
        createMockHistoryItem(`Question ${i} with some extra text`, `Answer ${i} with more content`)
      ) as IChatHistoryItemDocument[];

      const result = formatVoiceHistory(history);

      expect(result.length).toBeLessThanOrEqual(3000);
    });

    it('should use default recentMessageCount of 10', () => {
      const history = Array.from({ length: 20 }, (_, i) =>
        createMockHistoryItem(`Q${i}`, `A${i}`)
      ) as IChatHistoryItemDocument[];

      const result = formatVoiceHistory(history);

      // Should not include early items (0-9), only last 10 (10-19)
      expect(result).not.toContain('Q0');
      expect(result).not.toContain('Q9');
      expect(result).toContain('Q10');
      expect(result).toContain('Q19');
    });
  });
});

describe('buildVoiceInstructions', () => {
  const baseInstructions = 'You are a helpful assistant.';

  it('should return baseInstructions when historyContext is empty string', () => {
    const result = buildVoiceInstructions(baseInstructions, '');
    expect(result).toBe(baseInstructions);
  });

  it('should return baseInstructions when historyContext is falsy', () => {
    const result = buildVoiceInstructions(baseInstructions, null as unknown as string);
    expect(result).toBe(baseInstructions);
  });

  it('should concatenate baseInstructions with historyContext', () => {
    const historyContext = '\n\nCONVERSATION CONTEXT:\nUser: Hello';
    const result = buildVoiceInstructions(baseInstructions, historyContext);

    expect(result).toBe(baseInstructions + historyContext);
  });

  it('should work with formatVoiceHistory output', () => {
    const history = [createMockHistoryItem('Hello', 'Hi!')] as IChatHistoryItemDocument[];
    const historyContext = formatVoiceHistory(history);

    const result = buildVoiceInstructions(baseInstructions, historyContext);

    expect(result).toContain(baseInstructions);
    expect(result).toContain('CONVERSATION CONTEXT:');
    expect(result).toContain('User: Hello');
  });
});
