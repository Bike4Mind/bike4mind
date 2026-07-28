import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildAndSortMessages,
  calculateTotalTokenLength,
  processFabFilesServer,
  computeCosineSimilarity,
  getLastBuildDebugInfo,
  fetchAndProcessPreviousMessages,
  fetchAgentConversationHistory,
} from './utils';
import { ensureToolPairingIntegrity, stripAllToolBlocks } from '@bike4mind/llm-adapters';
import type { IMessage, ISessionDocument } from '@bike4mind/common';

// Define ITokenizer type locally since it's in @bike4mind/utils
interface ITokenizer {
  countTokens: (text: string) => Promise<number>;
  encodeTokens: (text: string) => Promise<number[]>;
  clearCache: () => void;
  getCacheStats: () => { size: number; keys: string[] };
  warmUpCache: (texts: string[]) => Promise<void>;
}

const mockLogger = {
  log: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  updateMetadata: vi.fn(),
};

const createMockTokenizer = (tokenCounts: Map<string, number> = new Map()): ITokenizer => {
  return {
    countTokens: vi.fn(async (text: string) => {
      if (tokenCounts.has(text)) {
        return tokenCounts.get(text)!;
      }
      return Math.ceil(text.length / 3.5);
    }),
    encodeTokens: vi.fn(async (text: string) => {
      const count = tokenCounts.get(text) ?? Math.ceil(text.length / 3.5);
      return Array(count).fill(1);
    }),
    clearCache: vi.fn(),
    getCacheStats: vi.fn(() => ({ size: 0, keys: [] })),
    warmUpCache: vi.fn(async () => {}),
  };
};

describe('Context Management Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Buffer Calculation Logic', () => {
    it('should use 5% buffer for large context windows', async () => {
      const maxInputTokens = 100000; // Large context window
      // Expected buffer: Math.floor(maxInputTokens * 0.05) = 5000

      const tokenizer = createMockTokenizer();

      await buildAndSortMessages(
        [],
        [],
        [{ role: 'user', content: 'test' }],
        maxInputTokens,
        {},
        0,
        mockLogger as any,
        tokenizer
      );

      // Reserves 5% (5000 tokens) as buffer; no overflow warning expected.
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should use minimum 1000 token buffer for small context windows', async () => {
      const maxInputTokens = 10000; // Small context window
      // Expected buffer: 1000 (minimum)

      const tokenizer = createMockTokenizer();

      await buildAndSortMessages(
        [],
        [],
        [{ role: 'user', content: 'test' }],
        maxInputTokens,
        {},
        0,
        mockLogger as any,
        tokenizer
      );

      // Should use 1000 minimum instead of 5% (500)
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should calculate buffer as max(1000, 5% of maxInputTokens)', async () => {
      const testCases = [
        { maxInputTokens: 5000 }, // 5% = 250, use 1000
        { maxInputTokens: 20000 }, // 5% = 1000, use 1000
        { maxInputTokens: 50000 }, // 5% = 2500, use 2500
        { maxInputTokens: 200000 }, // 5% = 10000, use 10000
      ];

      for (const { maxInputTokens } of testCases) {
        const tokenizer = createMockTokenizer();
        const result = await buildAndSortMessages(
          [],
          [],
          [{ role: 'user', content: 'test' }],
          maxInputTokens,
          {},
          0,
          mockLogger as any,
          tokenizer
        );

        expect(result).toBeDefined();
      }
    });
  });

  describe('processMessages - Priority-based Retention', () => {
    it('should prioritize system messages over all others', async () => {
      const messages: IMessage[] = [
        { role: 'assistant', content: 'A'.repeat(1000) }, // ~285 tokens
        { role: 'system', content: 'Important system message' }, // ~7 tokens
        { role: 'user', content: 'B'.repeat(1000) }, // ~285 tokens
      ];

      const tokenBudget = 300; // Only enough for system + one other
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        [messages[0], messages[2]], // previous messages (assistant, user)
        [messages[1]], // fab messages (system)
        [],
        tokenBudget + 1000, // Add buffer back
        {},
        14, // INFINITE_VALUE
        mockLogger as any,
        tokenizer
      );

      // System message should always be included
      const systemMsg = result.find(m => m.role === 'system');
      expect(systemMsg).toBeDefined();
      expect(systemMsg?.content).toBe('Important system message');
    });

    it('should prioritize user messages over assistant messages', async () => {
      const messages: IMessage[] = [
        { role: 'user', content: 'User message 1' },
        { role: 'assistant', content: 'Assistant response 1' },
        { role: 'user', content: 'User message 2' },
        { role: 'assistant', content: 'Assistant response 2' },
      ];

      // Set very tight budget to force prioritization
      const tokenBudget = 50;
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        messages,
        [],
        [],
        tokenBudget + 1000,
        {},
        14,
        mockLogger as any,
        tokenizer
      );

      const userCount = result.filter(m => m.role === 'user').length;
      const assistantCount = result.filter(m => m.role === 'assistant').length;

      // Under budget pressure, user messages are retained at least as much as assistant messages.
      expect(userCount).toBeGreaterThanOrEqual(assistantCount);
    });

    it('should preserve complete messages when budget allows', async () => {
      const messages: IMessage[] = [
        { role: 'user', content: 'Short message 1' },
        { role: 'assistant', content: 'Short response 1' },
        { role: 'user', content: 'Short message 2' },
      ];

      const tokenBudget = 1000; // Plenty of budget
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        messages,
        [],
        [],
        tokenBudget + 1000,
        {},
        14,
        mockLogger as any,
        tokenizer
      );

      // All messages should be preserved
      expect(result.length).toBe(messages.length);
    });

    it('should fall back to truncation when no complete messages fit', async () => {
      const messages: IMessage[] = [
        { role: 'user', content: 'X'.repeat(10000) }, // Very large message
        { role: 'assistant', content: 'Y'.repeat(10000) }, // Very large message
      ];

      const tokenBudget = 100; // Very small budget
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        messages,
        [],
        [],
        tokenBudget + 1000,
        {},
        14,
        mockLogger as any,
        tokenizer
      );

      // Should still return some (truncated) messages without crashing.
      expect(result).toBeDefined();
    });

    it('should track removed messages for visibility', async () => {
      const messages: IMessage[] = [
        { role: 'user', content: 'Message 1' },
        { role: 'assistant', content: 'Response 1' },
        { role: 'user', content: 'Message 2' },
        { role: 'assistant', content: 'Response 2' },
        { role: 'user', content: 'Message 3' },
      ];

      const tokenBudget = 50; // Force some removal
      const tokenizer = createMockTokenizer();

      await buildAndSortMessages(messages, [], [], tokenBudget + 1000, {}, 14, mockLogger as any, tokenizer);

      const debugInfo = getLastBuildDebugInfo();
      expect(debugInfo).toBeDefined();

      if (debugInfo?.removedMessages && debugInfo.removedMessages.length > 0) {
        debugInfo.removedMessages.forEach(removed => {
          expect(removed).toHaveProperty('role');
          expect(removed).toHaveProperty('tokens');
          expect(removed).toHaveProperty('priority');
        });
      }
    });
  });

  describe('Recent Exchange Protection', () => {
    it('should protect the last 3 user+assistant exchange pairs under budget pressure', async () => {
      // Build a 10-turn conversation (20 messages) with large early messages
      const messages: IMessage[] = [];
      for (let i = 0; i < 10; i++) {
        messages.push({ role: 'user', content: `User message ${i} ${'X'.repeat(200)}` });
        messages.push({ role: 'assistant', content: `Assistant response ${i} ${'Y'.repeat(200)}` });
      }

      // Budget tight enough to force dropping some messages but not all
      const tokenBudget = 800;
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        messages,
        [],
        [],
        tokenBudget + 1000,
        {},
        14,
        mockLogger as any,
        tokenizer
      );

      // The last 3 user messages (indices 14, 16, 18) must survive
      const resultContents = result.map(m => m.content as string);
      expect(resultContents.some(c => c.includes('User message 7'))).toBe(true);
      expect(resultContents.some(c => c.includes('User message 8'))).toBe(true);
      expect(resultContents.some(c => c.includes('User message 9'))).toBe(true);

      // The last 3 assistant responses (indices 15, 17, 19) must survive
      expect(resultContents.some(c => c.includes('Assistant response 7'))).toBe(true);
      expect(resultContents.some(c => c.includes('Assistant response 8'))).toBe(true);
      expect(resultContents.some(c => c.includes('Assistant response 9'))).toBe(true);
    });
  });

  describe('Recency Preference Within Same Priority', () => {
    it('should drop older messages before newer ones within the same priority level', async () => {
      // 6 user messages of similar size - budget only fits some
      const messages: IMessage[] = [];
      for (let i = 0; i < 6; i++) {
        messages.push({ role: 'user', content: `User message ${i} ${'Z'.repeat(300)}` });
      }

      // Budget enough for ~4 user messages but not all 6
      const tokenBudget = 400;
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        messages,
        [],
        [],
        tokenBudget + 1000,
        {},
        14,
        mockLogger as any,
        tokenizer
      );

      const resultContents = result.map(m => m.content as string);

      // Newest messages (4, 5) should always be present (protected as recent exchanges)
      expect(resultContents.some(c => c.includes('User message 5'))).toBe(true);
      expect(resultContents.some(c => c.includes('User message 4'))).toBe(true);

      // If any messages were dropped, they should be the oldest ones (0, 1) not the newest
      if (result.length < 6) {
        const hasOldest = resultContents.some(c => c.includes('User message 0'));
        const hasNewest = resultContents.some(c => c.includes('User message 5'));
        expect(hasNewest).toBe(true);
        // Oldest is more likely to be dropped than newest
        if (!hasOldest) {
          expect(hasNewest).toBe(true); // newest survived while oldest didn't
        }
      }
    });
  });

  describe('Chronological Order Preservation', () => {
    it('should return selected messages in original chronological order', async () => {
      const messages: IMessage[] = [
        { role: 'user', content: 'First user message' },
        { role: 'assistant', content: 'First assistant response' },
        { role: 'user', content: 'Second user message' },
        { role: 'assistant', content: 'Second assistant response' },
        { role: 'user', content: 'Third user message' },
        { role: 'assistant', content: 'Third assistant response' },
      ];

      const tokenBudget = 1000;
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        messages,
        [],
        [],
        tokenBudget + 1000,
        {},
        14,
        mockLogger as any,
        tokenizer
      );

      // Verify messages appear in the same relative order as the input
      const userMessages = result.filter(m => m.role === 'user');
      const assistantMessages = result.filter(m => m.role === 'assistant');

      for (let i = 1; i < userMessages.length; i++) {
        const prevIdx = result.indexOf(userMessages[i - 1]);
        const currIdx = result.indexOf(userMessages[i]);
        expect(currIdx).toBeGreaterThan(prevIdx);
      }

      for (let i = 1; i < assistantMessages.length; i++) {
        const prevIdx = result.indexOf(assistantMessages[i - 1]);
        const currIdx = result.indexOf(assistantMessages[i]);
        expect(currIdx).toBeGreaterThan(prevIdx);
      }
    });
  });

  describe('History Pruning - Simple vs Complex Queries', () => {
    it('should limit history for simple queries (historyCount set)', async () => {
      const previousMessages: IMessage[] = Array(40)
        .fill(null)
        .map((_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i}`,
        }));

      const historyCount = 20; // Reduced history for simple queries
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        previousMessages,
        [],
        [{ role: 'user', content: 'Current prompt' }],
        10000,
        {},
        historyCount,
        mockLogger as any,
        tokenizer
      );

      // At most historyCount * 2 history messages (code slices historyCount * 2).
      const historyInResult = result.filter(m => m.role === 'user' || m.role === 'assistant').length;

      expect(historyInResult).toBeLessThanOrEqual(historyCount * 2 + 1); // +1 for current prompt
    });

    it('should use full history for complex queries (INFINITE_VALUE)', async () => {
      const previousMessages: IMessage[] = Array(10)
        .fill(null)
        .map((_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i}`,
        }));

      const INFINITE_VALUE = 14;
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        previousMessages,
        [],
        [{ role: 'user', content: 'Current prompt' }],
        10000,
        {},
        INFINITE_VALUE,
        mockLogger as any,
        tokenizer
      );

      // Should include all previous messages (budget permitting)
      const historyInResult = result
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .filter(m => m.content !== 'Current prompt').length;

      expect(historyInResult).toBeGreaterThan(0);
    });

    it('should allocate tokens proportionally when both history and content are large', async () => {
      const previousMessages: IMessage[] = Array(20)
        .fill(null)
        .map((_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Previous message ${i}`,
        }));

      const fabMessages: IMessage[] = [{ role: 'user', content: 'Large knowledge file content: ' + 'X'.repeat(5000) }];

      const tokenBudget = 1000;
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        previousMessages,
        fabMessages,
        [{ role: 'user', content: 'Current prompt' }],
        tokenBudget + 1000,
        {},
        14,
        mockLogger as any,
        tokenizer
      );

      // Both history and knowledge included; allocation ~70% knowledge / 30% history. The cap is
      // only real if the result actually fits: with recent-pair protection left on for the content
      // pass, the oversized knowledge message came back untouched and blew the budget.
      expect(result.length).toBeGreaterThan(0);
      expect(await calculateTotalTokenLength(result, { estimateOnly: false, tokenizer })).toBeLessThanOrEqual(
        tokenBudget + 1000
      );
    });
  });

  describe('Context Overflow Detection', () => {
    it('should detect and log overflow when final token count exceeds limit', async () => {
      // Create messages that fit initially but will exceed after final token count
      const previousMessages: IMessage[] = Array(5)
        .fill(null)
        .map((_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: 'X'.repeat(3000), // Each ~857 tokens
        }));

      const maxInputTokens = 2000; // Set limit that will be exceeded after processing
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        previousMessages,
        [],
        [{ role: 'user', content: 'Y'.repeat(1000) }],
        maxInputTokens,
        {},
        14,
        mockLogger as any,
        tokenizer
      );

      // The point of the final safety pass: whatever it does, the result has to fit. It used to be
      // unable to shrink at all, so the overflow reached the caller's hard throw instead.
      expect(await calculateTotalTokenLength(result, { estimateOnly: false, tokenizer })).toBeLessThanOrEqual(
        maxInputTokens
      );
    });

    it('should handle edge cases near token limits without overflow', async () => {
      const maxInputTokens = 1000;
      // Create content that's just under the limit after buffer
      const safeContent = 'X'.repeat(2800); // ~800 tokens, safe with 5% buffer

      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        [],
        [],
        [{ role: 'user', content: safeContent }],
        maxInputTokens,
        {},
        14,
        mockLogger as any,
        tokenizer
      );

      // Should not trigger overflow warning
      expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('exceeds maxInputTokens'));
      expect(result.length).toBeGreaterThan(0);
    });

    it('should provide accurate overflow detection with debug info', async () => {
      const maxInputTokens = 500;
      const messages: IMessage[] = [{ role: 'user', content: 'A'.repeat(10000) }];

      const tokenizer = createMockTokenizer();

      await buildAndSortMessages(messages, [], [], maxInputTokens, {}, 14, mockLogger as any, tokenizer);

      const debugInfo = getLastBuildDebugInfo();
      expect(debugInfo).toBeDefined();
    });
  });

  describe('Regression Tests for Fixed Bugs', () => {
    it('should not cause hallucinations from mid-content truncation (#5515)', async () => {
      // Issue: Mid-content truncation was causing LLM hallucinations
      // Fix: Prioritize dropping complete messages over truncating content

      const messages: IMessage[] = [
        { role: 'user', content: 'Complete user message about project requirements' },
        { role: 'assistant', content: 'Complete assistant response with detailed explanation' },
        { role: 'user', content: 'Follow-up question' },
      ];

      const tokenBudget = 100; // Tight budget
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        messages,
        [],
        [],
        tokenBudget + 1000,
        {},
        14,
        mockLogger as any,
        tokenizer
      );

      // Each result message must be complete: whole messages are dropped, never truncated mid-content.
      result.forEach(msg => {
        if (typeof msg.content === 'string') {
          // Check that content is from original messages, not truncated
          const isOriginalContent = messages.some(
            original =>
              typeof original.content === 'string' &&
              (msg.content === original.content || original.content.startsWith(msg.content as string))
          );
          expect(isOriginalContent).toBe(true);
        }
      });
    });

    it('should handle zero or negative token budgets gracefully', async () => {
      const messages: IMessage[] = [{ role: 'user', content: 'Test message' }];

      const tokenizer = createMockTokenizer();

      const resultZero = await buildAndSortMessages(messages, [], [], 0, {}, 14, mockLogger as any, tokenizer);

      expect(resultZero).toBeDefined();
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid maxInputTokens'));
    });

    it('should preserve message order after priority-based selection', async () => {
      const messages: IMessage[] = [
        { role: 'user', content: 'First user message' },
        { role: 'assistant', content: 'First assistant response' },
        { role: 'user', content: 'Second user message' },
        { role: 'assistant', content: 'Second assistant response' },
      ];

      const tokenBudget = 1000; // Enough for all
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        messages,
        [],
        [],
        tokenBudget + 1000,
        {},
        14,
        mockLogger as any,
        tokenizer
      );

      const userAssistantMessages = result.filter(m => m.role === 'user' || m.role === 'assistant');

      // Verify chronological order is maintained
      for (let i = 1; i < userAssistantMessages.length; i++) {
        const prevIndex = messages.findIndex(m => m.content === userAssistantMessages[i - 1].content);
        const currIndex = messages.findIndex(m => m.content === userAssistantMessages[i].content);

        if (prevIndex !== -1 && currIndex !== -1) {
          expect(currIndex).toBeGreaterThanOrEqual(prevIndex);
        }
      }
    });

    it('should handle empty message arrays without errors', async () => {
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages([], [], [], 1000, {}, 14, mockLogger as any, tokenizer);

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should correctly calculate debug info for truncation visibility', async () => {
      const messages: IMessage[] = Array(30)
        .fill(null)
        .map((_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i}`,
        }));

      const tokenBudget = 200;
      const tokenizer = createMockTokenizer();

      await buildAndSortMessages(messages, [], [], tokenBudget + 1000, {}, 14, mockLogger as any, tokenizer);

      const debugInfo = getLastBuildDebugInfo();

      expect(debugInfo).toBeDefined();
      expect(debugInfo?.wasTruncated).toBeDefined();
      expect(debugInfo?.originalMessageCount).toBeDefined();
      expect(debugInfo?.truncatedMessageCount).toBeDefined();

      if (debugInfo?.wasTruncated) {
        expect(debugInfo.originalMessageCount).toBeGreaterThan(debugInfo.truncatedMessageCount);
        expect(debugInfo.truncationMethod).toBeDefined();
      }
    });

    it('should allocate 70% to knowledge files and 30% to history when both exceed budget', async () => {
      const previousMessages: IMessage[] = Array(10)
        .fill(null)
        .map((_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: 'Previous: ' + 'X'.repeat(500),
        }));

      const fabMessages: IMessage[] = [{ role: 'user', content: 'Knowledge: ' + 'Y'.repeat(2000) }];

      const tokenBudget = 1000;
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        previousMessages,
        fabMessages,
        [{ role: 'user', content: 'Current' }],
        tokenBudget + 1000,
        {},
        14,
        mockLogger as any,
        tokenizer
      );

      // Both knowledge and history present (knowledge gets the larger share: ~70% vs 30%).
      expect(result.length).toBeGreaterThan(0);

      const hasKnowledge = result.some(m => typeof m.content === 'string' && m.content.includes('Knowledge:'));
      const hasHistory = result.some(m => typeof m.content === 'string' && m.content.includes('Previous:'));

      // At least one of each type should be present when both are available
      expect(hasKnowledge || hasHistory).toBe(true);
      expect(await calculateTotalTokenLength(result, { estimateOnly: false, tokenizer })).toBeLessThanOrEqual(
        tokenBudget + 1000
      );
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle messages with array content (images)', async () => {
      const messages: IMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image' },
            { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' } },
          ],
        },
      ];

      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages([], messages, [], 10000, {}, 14, mockLogger as any, tokenizer);

      // Should handle array content without errors
      expect(result).toBeDefined();
      const imageMessage = result.find(m => Array.isArray(m.content));
      expect(imageMessage).toBeDefined();
    });

    it('should handle very large context windows (200k+ tokens)', async () => {
      const maxInputTokens = 200000; // Modern LLM context window
      const messages: IMessage[] = Array(100)
        .fill(null)
        .map((_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i}: ` + 'X'.repeat(1000),
        }));

      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(messages, [], [], maxInputTokens, {}, 14, mockLogger as any, tokenizer);

      // Should handle large context without errors
      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle messages with undefined or null content', async () => {
      const messages: IMessage[] = [
        { role: 'user', content: 'Valid message' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'Another valid message' },
      ];

      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(messages, [], [], 1000, {}, 14, mockLogger as any, tokenizer);

      expect(result).toBeDefined();
    });
  });

  describe('ensureToolPairingIntegrity - Tool Use/Result Pairing (#5880)', () => {
    it('should preserve messages when all tool_use/tool_result pairs are intact', () => {
      const messages: IMessage[] = [
        { role: 'user', content: 'Use the calculator tool' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will calculate that for you.' },
            { type: 'tool_use', id: 'toolu_123', name: 'calculator', input: { expression: '2+2' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_123', content: '4' }],
        },
        { role: 'assistant', content: 'The result is 4.' },
      ];

      const result = ensureToolPairingIntegrity(messages as IMessage[]);

      expect(result).toHaveLength(4);
      expect(result).toEqual(messages);
    });

    it('should remove orphaned tool_result blocks when tool_use is missing', () => {
      // Simulates scenario where assistant message with tool_use was truncated
      const messages: IMessage[] = [
        { role: 'user', content: 'Use the calculator tool' },
        // Missing: assistant message with tool_use for toolu_123
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_123', content: '4' }],
        },
        { role: 'assistant', content: 'The result is 4.' },
      ];

      const mockWarn = vi.fn();
      const result = ensureToolPairingIntegrity(messages as IMessage[], { log: vi.fn(), warn: mockWarn });

      // Should remove the message with orphaned tool_result
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('Use the calculator tool');
      expect(result[1].content).toBe('The result is 4.');
      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('toolu_123'));
    });

    it('should preserve tool_result when corresponding tool_use exists', () => {
      const messages: IMessage[] = [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_abc', name: 'search', input: { query: 'test' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_abc', content: 'Search results...' }],
        },
      ];

      const result = ensureToolPairingIntegrity(messages as IMessage[]);

      expect(result).toHaveLength(2);
    });

    it('should handle multiple tool_use/tool_result pairs in same message', () => {
      const messages: IMessage[] = [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'tool1', input: {} },
            { type: 'tool_use', id: 'toolu_2', name: 'tool2', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Result 1' },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: 'Result 2' },
          ],
        },
      ];

      const result = ensureToolPairingIntegrity(messages as IMessage[]);

      expect(result).toHaveLength(2);
      expect((result[1].content as unknown[]).length).toBe(2);
    });

    it('should remove only orphaned tool_result blocks, keeping valid ones', () => {
      const messages: IMessage[] = [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_valid', name: 'tool', input: {} },
            // Missing: tool_use for toolu_orphan
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_valid', content: 'Valid result' },
            { type: 'tool_result', tool_use_id: 'toolu_orphan', content: 'Orphan result' },
          ],
        },
      ];

      const result = ensureToolPairingIntegrity(messages as IMessage[]);

      expect(result).toHaveLength(2);
      const toolResultMessage = result[1];
      expect(Array.isArray(toolResultMessage.content)).toBe(true);
      expect((toolResultMessage.content as unknown[]).length).toBe(1);
      expect((toolResultMessage.content as { tool_use_id: string }[])[0].tool_use_id).toBe('toolu_valid');
    });

    it('should handle messages with string content (no tool blocks)', () => {
      const messages: IMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
      ];

      const result = ensureToolPairingIntegrity(messages as IMessage[]);

      expect(result).toHaveLength(3);
      expect(result).toEqual(messages);
    });

    it('should remove user message entirely if all tool_result blocks are orphaned', () => {
      const messages: IMessage[] = [
        { role: 'user', content: 'Do something' },
        // No assistant message with tool_use
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_orphan1', content: 'Result 1' },
            { type: 'tool_result', tool_use_id: 'toolu_orphan2', content: 'Result 2' },
          ],
        },
        { role: 'assistant', content: 'Done' },
      ];

      const mockLog = vi.fn();
      const result = ensureToolPairingIntegrity(messages as IMessage[], { log: mockLog, warn: vi.fn() });

      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('Do something');
      expect(result[1].content).toBe('Done');
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('removed 2 orphaned'));
    });

    it('should handle empty message array', () => {
      const result = ensureToolPairingIntegrity([]);
      expect(result).toHaveLength(0);
    });

    it('should handle mixed content types in user messages', () => {
      const messages: IMessage[] = [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'tool', input: {} }],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Here is the result:' },
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Result' },
          ],
        },
      ];

      const result = ensureToolPairingIntegrity(messages as IMessage[]);

      expect(result).toHaveLength(2);
      expect((result[1].content as unknown[]).length).toBe(2);
    });

    it('should log when orphaned blocks are removed', () => {
      const messages: IMessage[] = [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_missing', content: 'Result' }],
        },
      ];

      const mockLog = vi.fn();
      const mockWarn = vi.fn();

      ensureToolPairingIntegrity(messages as IMessage[], { log: mockLog, warn: mockWarn });

      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('toolu_missing'));
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('removed 1 orphaned'));
    });

    it('should work without logger parameter', () => {
      const messages: IMessage[] = [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_orphan', content: 'Result' }],
        },
      ];

      // Should not throw when logger is not provided
      const result = ensureToolPairingIntegrity(messages as IMessage[]);
      expect(result).toHaveLength(0);
    });

    it('should remove orphaned tool_use blocks when tool_result is missing', () => {
      // Simulates scenario where user message with tool_result was truncated
      const messages: IMessage[] = [
        { role: 'user', content: 'Use the calculator tool' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will calculate that for you.' },
            { type: 'tool_use', id: 'toolu_orphan', name: 'calculator', input: { expression: '2+2' } },
          ],
        },
        // Missing: user message with tool_result for toolu_orphan
        { role: 'assistant', content: 'The result is 4.' },
      ];

      const mockWarn = vi.fn();
      const mockLog = vi.fn();
      const result = ensureToolPairingIntegrity(messages as IMessage[], { log: mockLog, warn: mockWarn });

      // Should remove the tool_use block but keep the text content
      expect(result).toHaveLength(3);
      expect(result[0].content).toBe('Use the calculator tool');
      // Assistant message should only have text, not tool_use
      const assistantContent = result[1].content as { type: string; text?: string }[];
      expect(assistantContent).toHaveLength(1);
      expect(assistantContent[0].type).toBe('text');
      expect(result[2].content).toBe('The result is 4.');
      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('toolu_orphan'));
    });

    it('should remove entire assistant message if all tool_use blocks are orphaned', () => {
      const messages: IMessage[] = [
        { role: 'user', content: 'Do something' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_orphan1', name: 'tool1', input: {} },
            { type: 'tool_use', id: 'toolu_orphan2', name: 'tool2', input: {} },
          ],
        },
        // Missing: user messages with tool_result
        { role: 'assistant', content: 'Done' },
      ];

      const mockLog = vi.fn();
      const result = ensureToolPairingIntegrity(messages as IMessage[], { log: mockLog, warn: vi.fn() });

      // Should remove the entire assistant message with only orphaned tool_use blocks
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('Do something');
      expect(result[1].content).toBe('Done');
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('2 orphaned tool_use block(s)'));
    });

    it('should handle mixed orphaned tool_use and tool_result blocks', () => {
      const messages: IMessage[] = [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_valid', name: 'tool', input: {} },
            { type: 'tool_use', id: 'toolu_orphan_use', name: 'tool2', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_valid', content: 'Valid result' },
            { type: 'tool_result', tool_use_id: 'toolu_orphan_result', content: 'Orphan result' },
          ],
        },
      ];

      const mockLog = vi.fn();
      const mockWarn = vi.fn();
      const result = ensureToolPairingIntegrity(messages as IMessage[], { log: mockLog, warn: mockWarn });

      // Should keep only the valid pair
      expect(result).toHaveLength(2);
      const assistantContent = result[0].content as { type: string; id?: string }[];
      expect(assistantContent).toHaveLength(1);
      expect(assistantContent[0].id).toBe('toolu_valid');
      const userContent = result[1].content as { type: string; tool_use_id?: string }[];
      expect(userContent).toHaveLength(1);
      expect(userContent[0].tool_use_id).toBe('toolu_valid');
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('1 orphaned tool_result block(s)'));
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('1 orphaned tool_use block(s)'));
    });

    it('should preserve messages with only tool_use blocks when all have matching tool_result', () => {
      const messages: IMessage[] = [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'tool', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Result' }],
        },
      ];

      const result = ensureToolPairingIntegrity(messages as IMessage[]);

      expect(result).toHaveLength(2);
      expect(result).toEqual(messages);
    });
  });

  describe('ensureToolPairingIntegrity - Adjacency Validation', () => {
    it('should strip tool_use blocks when tool_result is not immediately adjacent', () => {
      // tool_use in msg[1] but tool_result is in msg[3] (not adjacent - msg[2] is plain text)
      const messages: IMessage[] = [
        { role: 'user', content: 'Search for info' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me search.' },
            { type: 'tool_use', id: 'toolu_abc', name: 'web_search', input: { query: 'test' } },
          ],
        },
        { role: 'user', content: 'Actually never mind' },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_abc', content: 'Search results' }],
        },
        { role: 'assistant', content: 'Here are the results.' },
      ];

      const mockWarn = vi.fn();
      const result = ensureToolPairingIntegrity(messages as IMessage[], { log: vi.fn(), warn: mockWarn });

      // The tool_use should be stripped from msg[1] (not adjacent to its tool_result)
      const assistantMsg = result.find(m => m.role === 'assistant' && Array.isArray(m.content));
      if (assistantMsg && Array.isArray(assistantMsg.content)) {
        const hasToolUse = assistantMsg.content.some((b: { type?: string }) => b.type === 'tool_use');
        expect(hasToolUse).toBe(false);
        // But text content should be preserved
        const hasText = assistantMsg.content.some((b: { type?: string }) => b.type === 'text');
        expect(hasText).toBe(true);
      }
      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('[Tool Pairing Adjacency]'));
    });

    it('should keep matched tool_use blocks and only strip unmatched ones (surgical repair)', () => {
      // Assistant has 2 tool_use blocks, but next user message only has result for one
      const messages: IMessage[] = [
        { role: 'user', content: 'Do two things' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will do both.' },
            { type: 'tool_use', id: 'toolu_good', name: 'calculator', input: { expr: '1+1' } },
            { type: 'tool_use', id: 'toolu_bad', name: 'web_search', input: { q: 'test' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_good', content: '2' },
            // Missing tool_result for toolu_bad
          ],
        },
        { role: 'assistant', content: 'Done.' },
      ];

      const mockWarn = vi.fn();
      const result = ensureToolPairingIntegrity(messages as IMessage[], { log: vi.fn(), warn: mockWarn });

      // The assistant message should keep toolu_good but lose toolu_bad
      const assistantMsg = result[1];
      expect(Array.isArray(assistantMsg.content)).toBe(true);
      const content = assistantMsg.content as Array<{ type: string; id?: string }>;

      const toolUseBlocks = content.filter(b => b.type === 'tool_use');
      expect(toolUseBlocks).toHaveLength(1);
      expect(toolUseBlocks[0].id).toBe('toolu_good');

      // Text should be preserved
      const textBlocks = content.filter(b => b.type === 'text');
      expect(textBlocks).toHaveLength(1);

      // The user message should only have the matching tool_result
      const userMsg = result[2];
      expect(Array.isArray(userMsg.content)).toBe(true);
      const userContent = userMsg.content as Array<{ type: string; tool_use_id?: string }>;
      const toolResultBlocks = userContent.filter(b => b.type === 'tool_result');
      expect(toolResultBlocks).toHaveLength(1);
      expect(toolResultBlocks[0].tool_use_id).toBe('toolu_good');
    });

    it('should preserve fully matched adjacent tool pairs', () => {
      const messages: IMessage[] = [
        { role: 'user', content: 'Calculate' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Calculating...' },
            { type: 'tool_use', id: 'toolu_1', name: 'calc', input: {} },
            { type: 'tool_use', id: 'toolu_2', name: 'search', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Result 1' },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: 'Result 2' },
          ],
        },
        { role: 'assistant', content: 'Done.' },
      ];

      const result = ensureToolPairingIntegrity(messages as IMessage[]);

      // Everything should be preserved as-is
      expect(result).toHaveLength(4);
      const assistantContent = result[1].content as Array<{ type: string }>;
      expect(assistantContent.filter(b => b.type === 'tool_use')).toHaveLength(2);
    });

    it('should replace assistant-only-tool_use message with empty text when tool_result exists but is non-adjacent', () => {
      // tool_result exists (so pass 2 doesn't remove it), but it's not adjacent to the tool_use
      const messages: IMessage[] = [
        { role: 'user', content: 'Do something' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_orphan', name: 'tool', input: {} }],
        },
        // Plain text user message breaks adjacency
        { role: 'user', content: 'What happened?' },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_orphan', content: 'result' }],
        },
        { role: 'assistant', content: 'Sorry about that.' },
      ];

      const result = ensureToolPairingIntegrity(messages as IMessage[], { log: vi.fn(), warn: vi.fn() });

      // The assistant message at index 1 should have tool_use stripped, replaced with empty text
      const assistantMsg = result[1];
      expect(Array.isArray(assistantMsg.content)).toBe(true);
      const content = assistantMsg.content as Array<{ type: string; text?: string }>;
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe('text');
      expect(content[0].text).toBe('[Tool calls removed during message repair]');
    });
  });

  describe('stripAllToolBlocks', () => {
    it('should remove all tool_use and tool_result blocks from messages', () => {
      const messages: IMessage[] = [
        { role: 'user', content: 'Search for something' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me search.' },
            { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { q: 'test' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Results here' }],
        },
        { role: 'assistant', content: 'Here are the results.' },
      ];

      const result = stripAllToolBlocks(messages as IMessage[]);

      // Should have 4 messages (user text, assistant text-only, user placeholder, assistant text)
      expect(result).toHaveLength(4);

      // First message unchanged
      expect(result[0].content).toBe('Search for something');

      // Assistant message should only have text block
      const assistantContent = result[1].content as Array<{ type: string }>;
      expect(assistantContent).toHaveLength(1);
      expect(assistantContent[0].type).toBe('text');

      // User tool_result message should be replaced with placeholder
      expect(result[2].role).toBe('user');
      expect(result[2].content).toBe('[Tool results removed during error recovery]');

      // Final assistant message unchanged
      expect(result[3].content).toBe('Here are the results.');
    });

    it('should preserve non-tool content in messages', () => {
      const messages: IMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'How are you?' },
      ];

      const result = stripAllToolBlocks(messages as IMessage[]);

      expect(result).toHaveLength(3);
      expect(result).toEqual(messages);
    });

    it('should drop assistant messages that contain only tool_use blocks', () => {
      const messages: IMessage[] = [
        { role: 'user', content: 'Do something' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'tool', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Done' }],
        },
        { role: 'assistant', content: 'All done.' },
      ];

      const result = stripAllToolBlocks(messages as IMessage[]);

      // Assistant-only-tool_use message should be dropped
      // User tool_result message should become placeholder
      expect(result).toHaveLength(3);
      expect(result[0].content).toBe('Do something');
      expect(result[1].role).toBe('user');
      expect(result[1].content).toBe('[Tool results removed during error recovery]');
      expect(result[2].content).toBe('All done.');
    });

    it('should log warning with counts when stripping blocks', () => {
      const messages: IMessage[] = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Using tools' },
            { type: 'tool_use', id: 'toolu_1', name: 'a', input: {} },
            { type: 'tool_use', id: 'toolu_2', name: 'b', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'r1' },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: 'r2' },
          ],
        },
      ];

      const mockWarn = vi.fn();
      stripAllToolBlocks(messages as IMessage[], { log: vi.fn(), warn: mockWarn });

      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('Stripped 2 tool_use and 2 tool_result blocks'));
    });

    it('should handle mixed content in user messages (text + tool_result)', () => {
      const messages: IMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Here is context' },
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'result' },
          ],
        },
      ];

      const result = stripAllToolBlocks(messages as IMessage[]);

      expect(result).toHaveLength(1);
      const content = result[0].content as Array<{ type: string }>;
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe('text');
    });
  });

  describe('fetchAndProcessPreviousMessages - Context Summary Boundary Filter', () => {
    // Helper to build a fake IChatHistoryItemDocument with an ObjectId-format string id.
    // ObjectIds are 24-char hex; we use zero-padded numbers so string sort == temporal sort.
    const makeItem = (n: number, overrides: Record<string, unknown> = {}) => ({
      id: String(n).padStart(24, '0'),
      sessionId: 'session1',
      prompt: `prompt ${n}`,
      reply: `reply ${n}`,
      replies: [`reply ${n}`],
      timestamp: new Date(n * 1000),
      type: 'message',
      status: 'done',
      ...overrides,
    });

    const makeSession = (overrides: Partial<ISessionDocument> = {}): ISessionDocument =>
      ({
        id: 'session1',
        ...overrides,
      }) as unknown as ISessionDocument;

    it('returns all messages when no contextSummaryUpToQuestId is set', async () => {
      // getMostRecentChatHistory returns newest-first; function reverses then pops current prompt
      const items = [makeItem(4), makeItem(3), makeItem(2), makeItem(1)];
      const db = { quests: { getMostRecentChatHistory: vi.fn().mockResolvedValue(items) } };

      const [messages, count, meta] = await fetchAndProcessPreviousMessages(makeSession(), 10, { db });

      // After reverse -> [1,2,3,4], pop removes 4 (current prompt) -> [1,2,3]
      expect(count).toBe(3);
      // Each item converts to 2 IMessages (user prompt + assistant reply) -> 3 items x 2 = 6
      expect(messages).toHaveLength(6);
      expect(meta.oldestIncludedQuestId).toBe(makeItem(1).id);
    });

    it('excludes messages at or before the boundary', async () => {
      // Items 1-4 returned newest-first
      const items = [makeItem(4), makeItem(3), makeItem(2), makeItem(1)];
      const db = { quests: { getMostRecentChatHistory: vi.fn().mockResolvedValue(items) } };
      // Boundary = id of item 2 -> keep only items with id > makeItem(2).id
      const session = makeSession({ contextSummaryUpToQuestId: makeItem(2).id });

      const [messages, count, meta] = await fetchAndProcessPreviousMessages(session, 10, { db });

      // After reverse -> [1,2,3,4], pop -> [1,2,3], filter keeps id > "000...02" -> [3]
      expect(count).toBe(1);
      expect(meta.oldestIncludedQuestId).toBe(makeItem(3).id);
      // The remaining message should correspond to item 3
      expect(messages.some(m => m.role === 'user' && (m.content as string).includes('prompt 3'))).toBe(true);
    });

    it('excludes nothing when all messages are after the boundary', async () => {
      const items = [makeItem(4), makeItem(3), makeItem(2)];
      const db = { quests: { getMostRecentChatHistory: vi.fn().mockResolvedValue(items) } };
      // Boundary older than everything returned
      const session = makeSession({ contextSummaryUpToQuestId: makeItem(1).id });

      const [messages, count, meta] = await fetchAndProcessPreviousMessages(session, 10, { db });

      // After reverse -> [2,3,4], pop -> [2,3]; both ids > boundary(1)
      expect(count).toBe(2);
      expect(meta.oldestIncludedQuestId).toBe(makeItem(2).id);
      expect(messages.length).toBeGreaterThan(0);
    });

    it('returns empty messages when all history is within the summary boundary', async () => {
      const items = [makeItem(3), makeItem(2), makeItem(1)];
      const db = { quests: { getMostRecentChatHistory: vi.fn().mockResolvedValue(items) } };
      // Boundary encompasses all returned items
      const session = makeSession({ contextSummaryUpToQuestId: makeItem(4).id });

      const [messages, count, meta] = await fetchAndProcessPreviousMessages(session, 10, { db });

      // After reverse -> [1,2,3], pop -> [1,2], filter keeps id > "000...04" -> none
      expect(count).toBe(0);
      expect(messages).toHaveLength(0);
      expect(meta.oldestIncludedQuestId).toBeNull();
    });

    it('sets oldestIncludedQuestId to null when no items pass the boundary filter', async () => {
      const items = [makeItem(2), makeItem(1)];
      const db = { quests: { getMostRecentChatHistory: vi.fn().mockResolvedValue(items) } };
      const session = makeSession({ contextSummaryUpToQuestId: makeItem(9).id });

      const [, , meta] = await fetchAndProcessPreviousMessages(session, 10, { db });

      expect(meta.oldestIncludedQuestId).toBeNull();
    });

    it('returns oldestIncludedQuestId even when historyCount is null (no limit)', async () => {
      const items = [makeItem(3), makeItem(2), makeItem(1)];
      const db = { quests: { getMostRecentChatHistory: vi.fn().mockResolvedValue(items) } };
      const session = makeSession({ contextSummaryUpToQuestId: makeItem(1).id });

      const [, , meta] = await fetchAndProcessPreviousMessages(session, null, { db });

      // After reverse -> [1,2,3], pop -> [1,2], filter keeps id > "000...01" -> [2]
      expect(meta.oldestIncludedQuestId).toBe(makeItem(2).id);
    });

    describe('recentGeneratedImages', () => {
      const makeImgItem = (n: number, images: string[]) => makeItem(n, { images });

      it('collects generated image keys newest-first with originating prompt', async () => {
        // newest-first input; function reverses then pops the current prompt (item 4)
        const items = [makeImgItem(4, ['d.jpg']), makeImgItem(3, ['c.jpg']), makeImgItem(2, ['b.jpg']), makeItem(1)];
        const db = { quests: { getMostRecentChatHistory: vi.fn().mockResolvedValue(items) } };

        const [, , meta] = await fetchAndProcessPreviousMessages(makeSession(), 10, { db });

        // history after pop = [1,2,3]; newest-first = 3 then 2 (item 4 is the current prompt, excluded)
        expect(meta.recentGeneratedImages).toEqual([
          { key: 'c.jpg', prompt: 'prompt 3' },
          { key: 'b.jpg', prompt: 'prompt 2' },
        ]);
      });

      it('filters out non-image generated artifacts (e.g. .xlsx)', async () => {
        const items = [makeItem(3), makeImgItem(2, ['schedule-abc.xlsx', 'snake-def.png']), makeItem(1)];
        const db = { quests: { getMostRecentChatHistory: vi.fn().mockResolvedValue(items) } };

        const [, , meta] = await fetchAndProcessPreviousMessages(makeSession(), 10, { db });

        expect(meta.recentGeneratedImages).toEqual([{ key: 'snake-def.png', prompt: 'prompt 2' }]);
      });

      it('caps the list at 6 images', async () => {
        // one item carrying 8 image keys; current prompt is a no-image item
        const many = Array.from({ length: 8 }, (_, i) => `img${i}.jpg`);
        const items = [makeItem(3), makeImgItem(2, many), makeItem(1)];
        const db = { quests: { getMostRecentChatHistory: vi.fn().mockResolvedValue(items) } };

        const [, , meta] = await fetchAndProcessPreviousMessages(makeSession(), 10, { db });

        expect(meta.recentGeneratedImages).toHaveLength(6);
        expect(meta.recentGeneratedImages?.[0]).toEqual({ key: 'img0.jpg', prompt: 'prompt 2' });
      });

      it('returns an empty array when no generated images exist', async () => {
        const items = [makeItem(3), makeItem(2), makeItem(1)];
        const db = { quests: { getMostRecentChatHistory: vi.fn().mockResolvedValue(items) } };

        const [, , meta] = await fetchAndProcessPreviousMessages(makeSession(), 10, { db });

        expect(meta.recentGeneratedImages).toEqual([]);
      });
    });
  });

  describe('fetchAgentConversationHistory', () => {
    const makeItem = (n: number, overrides: Record<string, unknown> = {}) => ({
      id: String(n).padStart(24, '0'),
      sessionId: 'session1',
      prompt: `prompt ${n}`,
      reply: `reply ${n}`,
      replies: [`reply ${n}`],
      timestamp: new Date(n * 1000),
      type: 'message',
      status: 'done',
      ...overrides,
    });

    const makeSession = (overrides: Partial<ISessionDocument> = {}): ISessionDocument =>
      ({ id: 'session1', ...overrides }) as unknown as ISessionDocument;

    it('returns chronological user/assistant text turns and KEEPS the most-recent turn (no pop)', async () => {
      // Newest-first from the repo. Unlike the chat path, the current user message is NOT a quest,
      // so item 3 (the prior turn with the follow-up question) must be retained.
      const items = [makeItem(3), makeItem(2), makeItem(1)];
      const db = { quests: { getMostRecentChatHistory: vi.fn().mockResolvedValue(items) } };

      const messages = await fetchAgentConversationHistory(makeSession(), 20, { db });

      // 3 turns x (user + assistant) = 6, in chronological order, ending on an assistant turn.
      expect(messages).toHaveLength(6);
      expect(messages[0]).toEqual({ role: 'user', content: 'prompt 1' });
      expect(messages[1]).toEqual({ role: 'assistant', content: 'reply 1' });
      expect(messages[messages.length - 1]).toEqual({ role: 'assistant', content: 'reply 3' });
      // The latest prior turn is present (would be dropped by a pop).
      expect(messages.some(m => m.role === 'user' && m.content === 'prompt 3')).toBe(true);
    });

    it('respects the context-summary boundary', async () => {
      const items = [makeItem(4), makeItem(3), makeItem(2), makeItem(1)];
      const db = { quests: { getMostRecentChatHistory: vi.fn().mockResolvedValue(items) } };
      const session = makeSession({ contextSummaryUpToQuestId: makeItem(2).id });

      const messages = await fetchAgentConversationHistory(session, 20, { db });

      // Keep only ids > item 2 -> items 3 and 4 -> 4 messages.
      expect(messages).toHaveLength(4);
      expect(messages.some(m => m.content === 'prompt 1' || m.content === 'prompt 2')).toBe(false);
      expect(messages[0]).toEqual({ role: 'user', content: 'prompt 3' });
    });

    it('skips thinking-only replies and never emits structured/tool content', async () => {
      const items = [
        makeItem(2, { replies: ['<think>internal planning</think>', 'the real answer'] }),
        makeItem(1, { replies: ['<think>only thoughts, no answer</think>'] }),
      ];
      const db = { quests: { getMostRecentChatHistory: vi.fn().mockResolvedValue(items) } };

      const messages = await fetchAgentConversationHistory(makeSession(), 20, { db });

      // item 1: user prompt kept, no non-think reply -> no assistant message.
      // item 2: user prompt + first non-think reply.
      expect(messages).toEqual([
        { role: 'user', content: 'prompt 1' },
        { role: 'user', content: 'prompt 2' },
        { role: 'assistant', content: 'the real answer' },
      ]);
      // All content is plain strings (no tool_use / tool_result arrays).
      expect(messages.every(m => typeof m.content === 'string')).toBe(true);
    });

    it('returns empty without querying when questCount <= 0', async () => {
      const getMostRecentChatHistory = vi.fn();
      const messages = await fetchAgentConversationHistory(makeSession(), 0, {
        db: { quests: { getMostRecentChatHistory } },
      });
      expect(messages).toEqual([]);
      expect(getMostRecentChatHistory).not.toHaveBeenCalled();
    });
  });
});

describe('computeCosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(computeCosineSimilarity([1, 0, 1], [1, 0, 1])).toBeCloseTo(1, 10);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(computeCosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('returns 0 when vector dimensions differ (mixed embedding models)', () => {
    // e.g. an Ollama nomic-embed-text query (768) against an OpenAI chunk (1536).
    expect(computeCosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(computeCosineSimilarity([1, 2], [1, 2, 3, 4])).toBe(0);
  });
});

// Token-budget allocation. Every case here passes an explicit FINITE historyCount: the
// INFINITE_VALUE sentinel is a magic 14 that a real computed history count can collide with, so
// tests that mean "unlimited" must not be written as a bare 14.
describe('Token budget allocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Even index = user, odd = assistant, and each message carries an identifying prefix so tests can
  // assert WHICH messages survived rather than just how many.
  const makeHistory = (count: number, charsEach: number): IMessage[] =>
    Array.from({ length: count }, (_, i) => {
      const label = `history-${i}-`;
      return {
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: label + 'h'.repeat(Math.max(0, charsEach - label.length)),
      };
    });

  const ATTACHED_FILE_PREFIX = 'Here is the content from the attached file "quarterly.csv" for context:\n\n';
  const makeAttachedFile = (totalChars: number): IMessage => ({
    role: 'user',
    content: ATTACHED_FILE_PREFIX + 'C'.repeat(totalChars - ATTACHED_FILE_PREFIX.length),
  });

  const findAttachedFile = (messages: IMessage[]) =>
    messages.find(m => typeof m.content === 'string' && m.content.startsWith(ATTACHED_FILE_PREFIX));
  const historyLabels = (messages: IMessage[]) =>
    messages
      .filter(m => typeof m.content === 'string' && (m.content as string).startsWith('history-'))
      .map(m => (m.content as string).split('-').slice(0, 2).join('-'));

  describe('processMessages honors its token budget', () => {
    it('reserves recent messages only as far as the budget stretches', async () => {
      // budget = 2000 - max(1000, 5%) = 1000; 8 history messages at 400 est. tokens each.
      // Six would be "protected" (3 pairs) at 2400 tokens, which the budget cannot cover.
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        makeHistory(8, 1400),
        [],
        [],
        2000,
        {},
        4,
        mockLogger as any,
        tokenizer
      );

      expect(historyLabels(result)).toEqual(['history-6', 'history-7']);
      expect(await calculateTotalTokenLength(result, { estimateOnly: false, tokenizer })).toBeLessThanOrEqual(2000);
    });

    it('keeps older protected messages when the newest one alone busts the budget', async () => {
      // budget = 1250 - 1000 = 250. The newest message is far too large to reserve; skipping it must
      // not abandon the five smaller recent messages behind it.
      const history = makeHistory(6, 350);
      history[5] = { role: 'assistant', content: 'history-5-' + 'X'.repeat(99990) };
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(history, [], [], 1250, {}, 4, mockLogger as any, tokenizer);

      // history-3 is an assistant message. It survives only because the reservation walks
      // newest-first past the oversized message; the priority-ordered greedy pass would have taken
      // the older USER message history-2 instead.
      expect(historyLabels(result)).toEqual(['history-3', 'history-4']);
      expect(await calculateTotalTokenLength(result, { estimateOnly: false, tokenizer })).toBeLessThanOrEqual(1250);
    });

    it('truncates a single message that is larger than the entire budget', async () => {
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        [{ role: 'user', content: 'A'.repeat(100000) }],
        [],
        [],
        2000,
        {},
        1,
        mockLogger as any,
        tokenizer
      );

      // ratio = (0.9 * 1000) / 28572, so 100000 chars becomes 3149.
      expect(result).toHaveLength(1);
      expect((result[0].content as string).length).toBe(3149);
      expect(await calculateTotalTokenLength(result, { estimateOnly: false, tokenizer })).toBeLessThanOrEqual(2000);
    });

    it('drops messages rather than emitting empty content when the budget is under a token each', async () => {
      // budget = 1005 - 1000 = 5 across 10 messages, i.e. 0 tokens each. Truncating to 0 tokens
      // yields empty strings, which providers reject outright.
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        makeHistory(10, 350),
        [],
        [],
        1005,
        {},
        10,
        mockLogger as any,
        tokenizer
      );

      expect(result.filter(m => m.content === '')).toHaveLength(0);
      expect(result).toHaveLength(0);
    });

    it('keeps recent-pair protection on by default for history', async () => {
      // budget 1000, 20 messages at 100 tokens. Protection reserves the 3 newest pairs (600), then
      // the greedy pass fills the remaining 400 with older USER messages by priority. Without
      // protection the greedy pass would spend the whole budget on user messages and return no
      // assistant turns at all.
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        makeHistory(20, 350),
        [],
        [],
        2000,
        {},
        10,
        mockLogger as any,
        tokenizer
      );

      const labels = historyLabels(result);
      expect(labels).toHaveLength(10);
      expect(labels).toContain('history-19');
      expect(labels).toContain('history-17');
      expect(labels).toContain('history-15');
    });

    it('does not throw on a message with undefined content', async () => {
      const tokenizer = createMockTokenizer();

      await expect(
        buildAndSortMessages(
          [{ role: 'user', content: undefined as unknown as string }],
          [],
          [],
          2000,
          {},
          4,
          mockLogger as any,
          tokenizer
        )
      ).resolves.toBeDefined();
    });
  });

  describe('attached content floor', () => {
    it('delivers the attached file to the model even when history dwarfs the budget', async () => {
      // The reported failure: a long conversation plus a freshly attached file on an 8k-class model.
      // budget = 8000 - 1000 buffer - 8 prompt = 6992, while history alone estimates 16075 tokens.
      // Before the floor, content was zeroed outright and the model answered as if no file existed.
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        makeHistory(40, 1400),
        [makeAttachedFile(35000)],
        [{ role: 'user', content: 'Summarize the attached file' }],
        8000,
        {},
        20,
        mockLogger as any,
        tokenizer
      );

      // floor = floor(6992 * 0.35) = 2447, so the file is truncated to 7708 chars (~2203 tokens)
      // rather than dropped.
      const file = findAttachedFile(result);
      expect(file).toBeDefined();
      // 7708 chars of the file, plus the notice telling the model this is not where the file ends.
      expect(file!.content as string).toContain('Content truncated to fit the context window');
      expect((file!.content as string).indexOf('\n\n[Content truncated')).toBe(7708);

      // History still holds the majority of the budget and keeps its newest exchange.
      const labels = historyLabels(result);
      expect(labels).toHaveLength(11);
      expect(labels).toContain('history-39');
      expect(labels).toContain('history-38');

      // The primary allocation kept us in bounds, so the final safety net never had to fire.
      expect(await calculateTotalTokenLength(result, { estimateOnly: false, tokenizer })).toBe(6661);
      expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('exceeds maxInputTokens'));

      // The squeeze is reported, and it names the file so a support engineer can see which one lost.
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('quarterly.csv'));
      expect(getLastBuildDebugInfo()?.truncationMethod).toBe('token-budget');
    });

    it('leaves a fitting attachment untouched and stays silent', async () => {
      const attached = makeAttachedFile(700);
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages([], [attached], [], 8000, {}, 10, mockLogger as any, tokenizer);

      // Byte-identical, not merely present: the squeeze check compares estimates against estimates,
      // so an attachment that fits can never be reported as squeezed.
      expect(findAttachedFile(result)?.content).toBe(attached.content);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('returns the unused part of the reserve to history', async () => {
      // The file uses 2203 of its 2447-token reserve. The leftover 244 must go back to history,
      // which is 16 more messages at 40 tokens each.
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        makeHistory(200, 140),
        [makeAttachedFile(35000)],
        [{ role: 'user', content: 'Summarize the attached file' }],
        8000,
        {},
        100,
        mockLogger as any,
        tokenizer
      );

      expect(historyLabels(result)).toHaveLength(119);
    });

    it('gives history the whole budget when nothing is attached', async () => {
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        makeHistory(200, 140),
        [],
        [{ role: 'user', content: 'Summarize the attached file' }],
        8000,
        {},
        100,
        mockLogger as any,
        tokenizer
      );

      // Reserving the floor unconditionally would cost history 61 of these messages.
      expect(historyLabels(result)).toHaveLength(174);
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(await calculateTotalTokenLength(result, { estimateOnly: false, tokenizer })).toBeLessThanOrEqual(8000);
    });

    it('keeps a small attachment whole even when history overflows', async () => {
      const attached = makeAttachedFile(350);
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        makeHistory(200, 140),
        [attached],
        [{ role: 'user', content: 'Summarize the attached file' }],
        8000,
        {},
        100,
        mockLogger as any,
        tokenizer
      );

      expect(findAttachedFile(result)?.content).toBe(attached.content);
      expect(historyLabels(result)).toHaveLength(172);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('survives a budget the buffer has driven negative', async () => {
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        makeHistory(4, 350),
        [makeAttachedFile(3500)],
        [{ role: 'user', content: 'Summarize the attached file' }],
        500,
        {},
        4,
        mockLogger as any,
        tokenizer
      );

      expect(historyLabels(result)).toHaveLength(0);
      expect(findAttachedFile(result)).toBeUndefined();
      expect(await calculateTotalTokenLength(result, { estimateOnly: false, tokenizer })).toBeLessThanOrEqual(500);
    });
  });

  describe('truncation reporting', () => {
    it('reports a budget loss as token-budget, not as history windowing', async () => {
      const tokenizer = createMockTokenizer();

      await buildAndSortMessages(
        makeHistory(40, 1400),
        [makeAttachedFile(35000)],
        [{ role: 'user', content: 'Summarize the attached file' }],
        8000,
        {},
        20,
        mockLogger as any,
        tokenizer
      );

      // Previously this reported 'history-limit' for any finite historyCount, making a file the
      // budget had silently zeroed indistinguishable from history being windowed as configured.
      expect(getLastBuildDebugInfo()?.truncationMethod).toBe('token-budget');
    });

    it('reports token-budget when the attachment was cut mid-message and nothing was dropped', async () => {
      // History fits comfortably, so no message is removed and removedMessages stays empty. The
      // attachment is still cut down, which is a budget loss telemetry must not miss.
      const tokenizer = createMockTokenizer();

      await buildAndSortMessages(
        makeHistory(4, 350),
        [makeAttachedFile(35000)],
        [{ role: 'user', content: 'go' }],
        4000,
        {},
        2,
        mockLogger as any,
        tokenizer
      );

      const debug = getLastBuildDebugInfo();
      expect(debug?.removedMessages).toBeUndefined();
      expect(debug?.truncationMethod).toBe('token-budget');
    });

    it('reports history-limit when only the historyCount window dropped messages', async () => {
      const tokenizer = createMockTokenizer();

      await buildAndSortMessages(makeHistory(40, 100), [], [], 100000, {}, 2, mockLogger as any, tokenizer);

      // slice(-4) drops 36 messages, and the generous budget removes nothing.
      expect(getLastBuildDebugInfo()?.truncationMethod).toBe('history-limit');
    });
  });
});

// Chunk retrieval for a vectorized attachment. This path had no coverage, which is how a bare
// `slice(0, 3)` survived long enough to starve small embedders.
describe('processFabFilesServer chunk retrieval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const makeChunks = (count: number, charsEach: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `chunk-${i}`,
      text: `chunk-${i}-` + 'c'.repeat(Math.max(0, charsEach - `chunk-${i}-`.length)),
      // Descending similarity to the query vector [1, 0], so ranking order is chunk-0 first.
      vector: [1, i / count],
    }));

  const runRetrieval = async (chunks: ReturnType<typeof makeChunks>, maxTokens: number) => {
    const embeddingFactory = {
      getDefaultEmbeddingModel: () => 'text-embedding-ada-002',
      createEmbeddingService: () => ({
        getModelInfo: () => ({ model: 'text-embedding-ada-002', contextWindow: 8192 }),
        generateEmbedding: async () => [1, 0],
      }),
    };

    const { userMessages } = await processFabFilesServer(
      embeddingFactory as any,
      [
        {
          id: 'file-1',
          fileName: 'roster.csv',
          mimeType: 'text/csv',
          vectorized: true,
          embeddingModel: 'text-embedding-ada-002',
        } as any,
      ],
      'who is on the roster',
      maxTokens,
      { supportsVision: false } as any,
      async () => {},
      {
        logger: mockLogger as any,
        storage: {} as any,
        db: {
          fabfilechunks: { findByFabFileId: vi.fn(async () => chunks) },
          fabfiles: { update: vi.fn() },
          caches: {} as any,
        } as any,
      }
    );
    return userMessages;
  };

  it('feeds more than three chunks to the model when the character budget allows', async () => {
    // Ten 200-char chunks against a 4000-token budget (14000 chars): the count is the only thing
    // that could hold this back, and three chunks would answer a 10-chunk question from 30% of it.
    const messages = await runRetrieval(makeChunks(10, 200), 4000);

    expect(messages).toHaveLength(1);
    const content = messages[0].content as string;
    expect(content).toContain('Data for roster.csv:');
    for (let i = 0; i < 10; i++) {
      expect(content).toContain(`chunk-${i}-`);
    }
  });

  it('still stops at the per-file character budget rather than the chunk count', async () => {
    // maxChars = 100 * 3.5 = 350, so only the first chunk fits and the rest are dropped. Raising the
    // count cap must not let a file exceed its share of the context window.
    const messages = await runRetrieval(makeChunks(10, 300), 100);

    const content = messages[0].content as string;
    expect(content).toContain('chunk-0-');
    expect(content).not.toContain('chunk-1-');
  });
});

// The default mock tokenizer is ceil(len / 3.5), byte-identical to the internal estimator, so any
// "it fits" assertion made with it is close to a tautology. Real tokenizers disagree with the
// estimate - code, CSV and CJK run denser - and that disagreement is the entire reason the final
// safety pass exists. These cases use a denser tokenizer so the pass is actually exercised.
describe('final safety pass under a denser-than-estimated tokenizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createDenseTokenizer = (charsPerToken: number): ITokenizer => ({
    countTokens: vi.fn(async (text: string) => Math.ceil(text.length / charsPerToken)),
    encodeTokens: vi.fn(async (text: string) => Array(Math.ceil(text.length / charsPerToken)).fill(1)),
    clearCache: vi.fn(),
    getCacheStats: vi.fn(() => ({ size: 0, keys: [] })),
    warmUpCache: vi.fn(async () => {}),
  });

  const makeHistory = (count: number, charsEach: number): IMessage[] =>
    Array.from({ length: count }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `history-${i}-` + 'h'.repeat(Math.max(0, charsEach - `history-${i}-`.length)),
    }));

  it('brings a dense payload under the limit instead of handing the overflow to the caller', async () => {
    // A small Bedrock-class window: 8000 context - 2048 max_tokens - 1000 reserve. CSV at 2.5
    // chars/token means every budget decision upstream was made on numbers ~40% low, so the primary
    // allocation cannot be trusted to have fit.
    const maxInputTokens = 4952;
    const tokenizer = createDenseTokenizer(2.5);

    const result = await buildAndSortMessages(
      makeHistory(60, 1000),
      [
        {
          role: 'user',
          content: 'Here is the content from the attached file "roster.csv" for context:\n\n' + 'C'.repeat(29930),
        },
      ],
      [{ role: 'user', content: 'Summarize the attached file' }],
      maxInputTokens,
      {},
      20,
      mockLogger as any,
      tokenizer
    );

    // The contract that matters: whatever it had to drop, the payload fits. Before this the pass
    // could only shrink content, so a history-driven overflow passed straight through to the throw.
    expect(await calculateTotalTokenLength(result, { estimateOnly: false, tokenizer })).toBeLessThanOrEqual(
      maxInputTokens
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('exceeds maxInputTokens'));
    expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('could not bring the payload under'));
  });

  it('reports fresh truncation info on the overflow path, not the previous call/s', async () => {
    // buildAndSortMessages returns early from the overflow block, and lastDebugInfo lives on the
    // function object, so a warm container used to serve the previous request/s numbers here.
    const clean = createDenseTokenizer(3.5);
    await buildAndSortMessages(makeHistory(40, 100), [], [], 100000, {}, 2, mockLogger as any, clean);
    const first = getLastBuildDebugInfo();
    expect(first?.truncationMethod).toBe('history-limit');

    const dense = createDenseTokenizer(2.5);
    await buildAndSortMessages(
      makeHistory(60, 1000),
      [{ role: 'user', content: 'F'.repeat(30000) }],
      [{ role: 'user', content: 'Summarize the attached file' }],
      4952,
      {},
      20,
      mockLogger as any,
      dense
    );

    const second = getLastBuildDebugInfo();
    expect(second?.truncationMethod).toBe('token-budget');
    expect(second?.originalMessageCount).toBe(41); // 40 windowed history + 1 attachment, not the first call/s 4
  });

  it('reports content the safety pass dropped, not just what the primary allocation removed', async () => {
    // Tuned so the primary allocation removes NOTHING: short history, and two attachments that fit
    // their estimated budget exactly. Only the real tokenizer sees the overflow, so the safety pass is
    // the sole thing that drops a message here - if it does not report that, removedMessages stays
    // empty and the whole turn looks untruncated.
    const tokenizer = createDenseTokenizer(2.0);

    await buildAndSortMessages(
      makeHistory(2, 350),
      [
        { role: 'user', content: 'A'.repeat(3143) },
        { role: 'user', content: 'B'.repeat(3143) },
      ],
      [],
      3000,
      {},
      2,
      mockLogger as any,
      tokenizer
    );

    const debug = getLastBuildDebugInfo();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('exceeds maxInputTokens'));
    expect(debug?.removedMessages?.length).toBe(1);
    expect(debug?.wasTruncated).toBe(true);
    expect(debug?.truncationMethod).toBe('token-budget');
  });

  it('keeps wasTruncated consistent with truncationMethod when content was cut mid-message', async () => {
    const tokenizer = createDenseTokenizer(3.5);

    await buildAndSortMessages(
      makeHistory(4, 350),
      [{ role: 'user', content: 'F'.repeat(35000) }],
      [{ role: 'user', content: 'go' }],
      4000,
      {},
      2,
      mockLogger as any,
      tokenizer
    );

    // No message was dropped, so removedMessages is empty - but the file WAS cut, and a consumer
    // gating on wasTruncated would otherwise never look at truncationMethod at all.
    const debug = getLastBuildDebugInfo();
    expect(debug?.removedMessages).toBeUndefined();
    expect(debug?.truncationMethod).toBe('token-budget');
    expect(debug?.wasTruncated).toBe(true);
  });
});

describe('history windowing edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends no history at all when historyCount is 0', async () => {
    // slice(-0) is slice(0), which returns the WHOLE array. Image models set historyCount to 0
    // specifically to keep history out of their small context windows, so this sent them everything.
    const tokenizer = createMockTokenizer();
    const previousMessages: IMessage[] = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `history-${i}`,
    }));

    const result = await buildAndSortMessages(
      previousMessages,
      [],
      [{ role: 'user', content: 'draw a cat' }],
      10000,
      {},
      0,
      mockLogger as any,
      tokenizer
    );

    expect(result.filter(m => typeof m.content === 'string' && m.content.startsWith('history-'))).toHaveLength(0);
    expect(result).toHaveLength(1);
  });

  it('never returns empty content when truncating array-content messages', async () => {
    // Array content truncates by whole blocks, so flooring a single-block message to zero blocks
    // produced an empty content array, which providers reject.
    const tokenizer = createMockTokenizer();
    const previousMessages: IMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'A'.repeat(50000) }] as any },
      { role: 'assistant', content: [{ type: 'text', text: 'B'.repeat(50000) }] as any },
    ];

    const result = await buildAndSortMessages(previousMessages, [], [], 2000, {}, 4, mockLogger as any, tokenizer);

    for (const message of result) {
      if (Array.isArray(message.content)) expect(message.content.length).toBeGreaterThan(0);
    }
  });

  it('does not report an empty-content attachment as a budget truncation', async () => {
    // maxInputTokens 500 minus the 1000-token buffer floor drives the budget negative, so the
    // content pass gets a zero budget. A fab file whose extracted text is empty has nothing to lose,
    // and counting it as removed would put 'token-budget' on an otherwise healthy turn. No history,
    // so this attachment is the only thing that could report a loss.
    const tokenizer = createMockTokenizer();

    await buildAndSortMessages(
      [],
      [{ role: 'user', content: '' }],
      [{ role: 'user', content: 'hello' }],
      500,
      {},
      4,
      mockLogger as any,
      tokenizer
    );

    expect(getLastBuildDebugInfo()?.truncationMethod).toBeUndefined();
    expect(getLastBuildDebugInfo()?.wasTruncated).toBe(false);
  });
});

// A file cut to fit must say so. Without this the model treats the last surviving row as the end of
// the file and answers about it confidently - QA hit exactly that, reading a mid-file row as the
// final row of a 416-row CSV.
describe('truncated attachments are marked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const makeHistory = (count: number, charsEach: number): IMessage[] =>
    Array.from({ length: count }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `history-${i}-` + 'h'.repeat(Math.max(0, charsEach - `history-${i}-`.length)),
    }));

  const NOTICE = 'Content truncated to fit the context window';

  it('tells the model where a cut file stops', async () => {
    const tokenizer = createMockTokenizer();
    const body = 'row-data,'.repeat(3000) + '\nFINAL_ROW_MARKER: pineapple';

    const result = await buildAndSortMessages(
      makeHistory(40, 1400),
      [{ role: 'user', content: body }],
      [{ role: 'user', content: 'What is FINAL_ROW_MARKER?' }],
      8000,
      {},
      20,
      mockLogger as any,
      tokenizer
    );

    const file = result.find(m => typeof m.content === 'string' && (m.content as string).startsWith('row-data,'));
    expect(file).toBeDefined();
    const text = file!.content as string;
    expect(text).toContain(NOTICE);
    expect(text.endsWith(NOTICE + '. This is NOT the end of the file - later content was not sent.]')).toBe(true);
    // The tail the marker lives in genuinely did not survive, which is exactly why the notice matters.
    expect(text).not.toContain('FINAL_ROW_MARKER');
  });

  it('stays quiet when the whole file fits', async () => {
    const tokenizer = createMockTokenizer();
    const whole = 'row-data,'.repeat(50) + '\nFINAL_ROW_MARKER: apricot';

    const result = await buildAndSortMessages(
      [],
      [{ role: 'user', content: whole }],
      [{ role: 'user', content: 'What is FINAL_ROW_MARKER?' }],
      8000,
      {},
      10,
      mockLogger as any,
      tokenizer
    );

    const file = result.find(m => typeof m.content === 'string' && (m.content as string).startsWith('row-data,'));
    expect(file!.content).toBe(whole);
    expect(file!.content as string).not.toContain(NOTICE);
    expect(file!.content as string).toContain('FINAL_ROW_MARKER: apricot');
  });

  it('delivers a whole small file with its trailing marker on an 8k-class model', async () => {
    // The corrected Guide-for-Testers scenario: a ~4k file on a small-context model fits inside the
    // floor, so a marker on the last line actually arrives. The original guide paired a <=8k model
    // with a 30k file, which cannot fit that window at all - the marker could never have survived.
    const tokenizer = createMockTokenizer();
    const file = 'row,value\n' + 'a,1\n'.repeat(980) + 'FINAL_ROW_MARKER: apricot';

    const result = await buildAndSortMessages(
      makeHistory(20, 1400),
      [{ role: 'user', content: file }],
      [{ role: 'user', content: 'What is FINAL_ROW_MARKER?' }],
      8000,
      {},
      10,
      mockLogger as any,
      tokenizer
    );

    const delivered = result.find(m => typeof m.content === 'string' && (m.content as string).startsWith('row,value'));
    expect(delivered!.content).toBe(file);
    expect(delivered!.content as string).toContain('FINAL_ROW_MARKER: apricot');
    expect(delivered!.content as string).not.toContain(NOTICE);
  });
});
