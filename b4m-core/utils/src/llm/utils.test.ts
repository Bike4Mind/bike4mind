import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildAndSortMessages,
  calculateTotalTokenLength,
  processFabFilesServer,
  computeCosineSimilarity,
  getLastBuildDebugInfo,
  fetchAndProcessPreviousMessages,
  fetchAgentConversationHistory,
  includeHardcodedSystemMessage,
  includeImagePromptSystemMessage,
  TOOL_RESULT_NOT_RECORDED,
  ATTACHMENT_DELIVERED_NOTICE,
} from './utils';
import { ensureToolPairingIntegrity, stripAllToolBlocks } from '@bike4mind/llm-adapters';
import { DEFAULT_HISTORY_FETCH_LIMIT, FORMAT_PROMPT_TEMPLATE, UNLIMITED_HISTORY_COUNT } from '@bike4mind/common';
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
        14,
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

    it('should keep the whole history when no window is set', async () => {
      const previousMessages: IMessage[] = Array(10)
        .fill(null)
        .map((_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i}`,
        }));

      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages(
        previousMessages,
        [],
        [{ role: 'user', content: 'Current prompt' }],
        10000,
        {},
        UNLIMITED_HISTORY_COUNT,
        mockLogger as any,
        tokenizer
      );

      const historyInResult = result
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .filter(m => m.content !== 'Current prompt');

      expect(historyInResult).toHaveLength(previousMessages.length);
      expect(getLastBuildDebugInfo()?.truncationMethod).not.toBe('history-limit');
    });

    // The pair below is the allocation policy the old in-range sentinel could flip by accident:
    // same oversubscribed inputs, and the only difference is whether a window was requested.
    const oversubscribed = () => ({
      previousMessages: Array(20)
        .fill(null)
        .map((_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Previous message ${i} ${'H'.repeat(330)}`,
        })) as IMessage[],
      fabMessages: [{ role: 'user', content: 'File content: ' + 'X'.repeat(1390) }] as IMessage[],
      maxInputTokens: 1100,
    });

    const hasFileContent = (messages: IMessage[]) =>
      messages.some(m => typeof m.content === 'string' && m.content.includes('File content:'));

    it('should split the budget between files and history when no window is set', async () => {
      const { previousMessages, fabMessages } = oversubscribed();

      // 2100 rather than the fixture's 1100: after the 1000-token reserve the latter leaves ~96 tokens
      // for a 401-token file, which is now declared undeliverable rather than sent as an unusable
      // fragment, so there is no split left to observe. At 2100 the file fits inside its 70% share and
      // history takes the rest, which is the division this test is named for.
      const result = await buildAndSortMessages(
        previousMessages,
        fabMessages,
        [{ role: 'user', content: 'Current prompt' }],
        2100,
        {},
        UNLIMITED_HISTORY_COUNT,
        mockLogger as any,
        createMockTokenizer()
      );

      const historyKept = result.filter(
        m => typeof m.content === 'string' && m.content.startsWith('Previous message')
      ).length;
      expect(hasFileContent(result)).toBe(true);
      expect(historyKept).toBeGreaterThan(0);
      expect(historyKept).toBeLessThan(previousMessages.length);
    });

    it('should treat a history count of 14 as an ordinary window, not a request for unlimited history', async () => {
      // 14 is what a 128k model's simple-query ceiling computes to, and it used to mean "unlimited".
      // Asserted on how much history survives rather than on whether file content does: with a budget
      // large enough that nothing is squeezed, a window is observable as the 14*2 message cap and
      // nothing else, which keeps this independent of how the branches divide a tight budget.
      const previousMessages = Array(40)
        .fill(null)
        .map((_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Previous message ${i}`,
        })) as IMessage[];
      const fabMessages = [{ role: 'user', content: 'File content: ' + 'X'.repeat(200) }] as IMessage[];

      const windowed = await buildAndSortMessages(
        previousMessages,
        fabMessages,
        [{ role: 'user', content: 'Current prompt' }],
        100000,
        {},
        14,
        mockLogger as any,
        createMockTokenizer()
      );
      const unlimited = await buildAndSortMessages(
        previousMessages,
        fabMessages,
        [{ role: 'user', content: 'Current prompt' }],
        100000,
        {},
        UNLIMITED_HISTORY_COUNT,
        mockLogger as any,
        createMockTokenizer()
      );

      const historyCountIn = (messages: IMessage[]) =>
        messages.filter(m => typeof m.content === 'string' && m.content.startsWith('Previous message')).length;
      expect(historyCountIn(windowed)).toBe(28);
      expect(historyCountIn(unlimited)).toBe(40);
      // The file is small and the budget generous, so a window costs it nothing.
      expect(hasFileContent(windowed)).toBe(true);
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

    describe('history window resolution', () => {
      it('pages unlimited history at the default limit instead of reading it as "no history"', async () => {
        const items = [makeItem(3), makeItem(2), makeItem(1)];
        const getMostRecentChatHistory = vi.fn().mockResolvedValue(items);

        const [messages, count] = await fetchAndProcessPreviousMessages(makeSession(), UNLIMITED_HISTORY_COUNT, {
          db: { quests: { getMostRecentChatHistory } },
        });

        // The marker is negative, so an ordering slip would take the "<= 0 means no history" path.
        expect(count).toBe(2);
        expect(messages).toHaveLength(4);
        expect(getMostRecentChatHistory).toHaveBeenCalledWith('session1', DEFAULT_HISTORY_FETCH_LIMIT + 1);
      });

      it('still returns no history for a zero window', async () => {
        const getMostRecentChatHistory = vi.fn();

        const [messages, count] = await fetchAndProcessPreviousMessages(makeSession(), 0, {
          db: { quests: { getMostRecentChatHistory } },
        });

        expect(count).toBe(0);
        expect(messages).toHaveLength(0);
        expect(getMostRecentChatHistory).not.toHaveBeenCalled();
      });

      it('pages a bounded window at that window', async () => {
        const getMostRecentChatHistory = vi.fn().mockResolvedValue([]);

        await fetchAndProcessPreviousMessages(makeSession(), 30, {
          db: { quests: { getMostRecentChatHistory } },
        });

        expect(getMostRecentChatHistory).toHaveBeenCalledWith('session1', 31);
      });
    });

    describe('verbatim token-bounding', () => {
      // Each item's prompt is ~4000 chars -> ~1146 estimated tokens (chars/3.5).
      const BIG = 'x'.repeat(4000);
      const makeBigItem = (n: number) => makeItem(n, { prompt: BIG, reply: `reply ${n}`, replies: [`reply ${n}`] });

      it('keeps only the newest turns that fit the budget and reports the excluded count', async () => {
        // newest-first input [4,3,2,1] -> reverse [1,2,3,4] -> pop 4 -> [1,2,3] (each ~1146 tokens)
        const items = [makeBigItem(4), makeBigItem(3), makeBigItem(2), makeBigItem(1)];
        const db = { quests: { getMostRecentChatHistory: vi.fn().mockResolvedValue(items) } };

        // Budget ~1500 fits only the single newest kept turn (item 3); 2 would be ~2292.
        const [, count, meta] = await fetchAndProcessPreviousMessages(makeSession(), 10, {
          db,
          verbatimTokenBudget: 1500,
        });

        expect(count).toBe(1);
        expect(meta.oldestIncludedQuestId).toBe(makeItem(3).id);
        expect(meta.excludedOlderQuestCount).toBe(2);
      });

      it('keeps multiple turns when the budget allows and excludes the rest', async () => {
        const items = [makeBigItem(4), makeBigItem(3), makeBigItem(2), makeBigItem(1)];
        const db = { quests: { getMostRecentChatHistory: vi.fn().mockResolvedValue(items) } };

        // ~2500 fits two turns (~2292) but not three (~3438).
        const [, count, meta] = await fetchAndProcessPreviousMessages(makeSession(), 10, {
          db,
          verbatimTokenBudget: 2500,
        });

        expect(count).toBe(2);
        expect(meta.oldestIncludedQuestId).toBe(makeItem(2).id);
        expect(meta.excludedOlderQuestCount).toBe(1);
      });

      it('counts replayed tool calls, whose serialized parameters can dwarf the text reply', async () => {
        // A small prompt whose replayable tool call carries a large parameters payload. Ignoring
        // it would let the turn look cheap and blow the real budget once Priority 2 expands it.
        const heavyToolItem = (n: number) =>
          makeItem(n, {
            prompt: `prompt ${n}`,
            structuredReplies: undefined,
            promptMeta: {
              functionCalls: [
                { id: `toolu_${n}`, name: 'web_search', parameters: { blob: 'y'.repeat(4000) }, returnValue: 'ok' },
              ],
            },
          });

        const items = [makeItem(3), heavyToolItem(2), heavyToolItem(1)];
        const db = { quests: { getMostRecentChatHistory: vi.fn().mockResolvedValue(items) } };

        // Budget fits one heavy turn (~1150 tokens of parameters) but not two.
        const [, count, meta] = await fetchAndProcessPreviousMessages(makeSession(), 10, {
          db,
          verbatimTokenBudget: 1500,
        });

        expect(count).toBe(1);
        expect(meta.excludedOlderQuestCount).toBe(1);
      });

      it('always keeps the most recent turn even if it alone exceeds the budget', async () => {
        const items = [makeBigItem(3), makeBigItem(2), makeBigItem(1)];
        const db = { quests: { getMostRecentChatHistory: vi.fn().mockResolvedValue(items) } };

        // Tiny budget: still keep exactly the newest kept turn, never zero.
        const [, count, meta] = await fetchAndProcessPreviousMessages(makeSession(), 10, {
          db,
          verbatimTokenBudget: 1,
        });

        expect(count).toBe(1);
        expect(meta.oldestIncludedQuestId).toBe(makeItem(2).id);
        expect(meta.excludedOlderQuestCount).toBe(1);
      });

      it('excludes nothing (excludedOlderQuestCount 0) when history fits the budget', async () => {
        const items = [makeBigItem(3), makeBigItem(2), makeBigItem(1)];
        const db = { quests: { getMostRecentChatHistory: vi.fn().mockResolvedValue(items) } };

        const [, , meta] = await fetchAndProcessPreviousMessages(makeSession(), 10, {
          db,
          verbatimTokenBudget: 1_000_000,
        });

        expect(meta.oldestIncludedQuestId).toBe(makeItem(1).id);
        expect(meta.excludedOlderQuestCount).toBe(0);
      });

      it('is a no-op when no budget is provided (legacy behavior)', async () => {
        const items = [makeBigItem(3), makeBigItem(2), makeBigItem(1)];
        const db = { quests: { getMostRecentChatHistory: vi.fn().mockResolvedValue(items) } };

        const [, count, meta] = await fetchAndProcessPreviousMessages(makeSession(), 10, { db });

        expect(count).toBe(2);
        expect(meta.oldestIncludedQuestId).toBe(makeItem(1).id);
        expect(meta.excludedOlderQuestCount).toBe(0);
      });
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

    // Priority 2 rebuilds tool_use/tool_result pairs from promptMeta.functionCalls when
    // structuredReplies is absent. It was unreachable for as long as the Mongoose subschema
    // dropped functionCalls[].id, so these pin the shape Anthropic requires.
    describe('Priority 2 tool-pairing reconstruction', () => {
      const call = (overrides: Record<string, unknown> = {}) => ({
        id: 'toolu_1',
        name: 'web_search',
        parameters: { query: 'weather' },
        returnValue: 'sunny',
        ...overrides,
      });

      const makeToolItem = (n: number, functionCalls: Record<string, unknown>[]) =>
        makeItem(n, { structuredReplies: undefined, promptMeta: { functionCalls } });

      const runWith = async (item: Record<string, unknown>) => {
        // item 2 is the current prompt and gets popped, so the turn under test is item 1
        const db = { quests: { getMostRecentChatHistory: vi.fn().mockResolvedValue([makeItem(2), item]) } };
        const [messages] = await fetchAndProcessPreviousMessages(makeSession(), 10, { db });
        return messages;
      };

      it('pairs each tool_use with a tool_result carrying the same id, in order', async () => {
        const messages = await runWith(
          makeToolItem(1, [call(), call({ id: 'toolu_2', name: 'get_time', returnValue: '10:00' })])
        );

        const [, assistant, toolResults] = messages;
        expect(assistant.role).toBe('assistant');
        expect(assistant.content).toEqual([
          { type: 'text', text: 'reply 1' },
          { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'weather' } },
          { type: 'tool_use', id: 'toolu_2', name: 'get_time', input: { query: 'weather' } },
        ]);
        expect(toolResults.role).toBe('user');
        expect(toolResults.content).toEqual([
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny', is_error: false },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: '10:00', is_error: false },
        ]);
      });

      it('never emits an empty tool_result, which the API rejects', async () => {
        const messages = await runWith(
          makeToolItem(1, [call(), call({ id: 'toolu_2', name: 'get_time', returnValue: undefined })])
        );

        const contents = (messages[2].content as { content: string }[]).map(block => block.content);
        expect(contents).toEqual(['sunny', TOOL_RESULT_NOT_RECORDED]);
        expect(contents.every(Boolean)).toBe(true);
      });

      it('marks a failed call as an error', async () => {
        const messages = await runWith(
          makeToolItem(1, [call(), call({ id: 'toolu_2', returnValue: undefined, success: false })])
        );

        expect(messages[2].content).toEqual([
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny', is_error: false },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'Tool execution failed', is_error: true },
        ]);
      });

      it('falls back to the text reply when no call recorded a result', async () => {
        // The whole turn is otherwise replaced by tool invocations with nothing to show for them.
        const messages = await runWith(makeToolItem(1, [call({ returnValue: undefined })]));

        expect(messages[1]).toEqual({ role: 'assistant', content: 'reply 1' });
      });

      it('drops incomplete and duplicate calls rather than emitting unpairable blocks', async () => {
        const messages = await runWith(
          makeToolItem(1, [
            call(),
            call({ name: undefined, id: 'toolu_2' }),
            call({ id: undefined }),
            call({ returnValue: 'a duplicate id the API rejects' }),
          ])
        );

        expect(messages[1].content).toEqual([
          { type: 'text', text: 'reply 1' },
          { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'weather' } },
        ]);
        expect(messages[2].content).toHaveLength(1);
      });

      it('coerces non-object parameters, since Anthropic requires an object input', async () => {
        const messages = await runWith(makeToolItem(1, [call({ parameters: 'not-an-object' })]));

        // index 0 is the text reply; the tool_use follows it
        expect((messages[1].content as { input: unknown }[])[1].input).toEqual({});
      });

      it('keeps preferring structuredReplies when both are present', async () => {
        const item = makeItem(1, {
          structuredReplies: [{ role: 'assistant', content: [{ type: 'text', text: 'from structured' }] }],
          promptMeta: { functionCalls: [call()] },
        });

        const messages = await runWith(item);

        expect(messages[1].content).toEqual([{ type: 'text', text: 'from structured' }]);
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

  // The delivered-content notice (see ATTACHMENT_DELIVERED_NOTICE) rides ahead of the file's own
  // framing, so the message no longer starts with ATTACHED_FILE_PREFIX - it contains it.
  const findAttachedFile = (messages: IMessage[]) =>
    messages.find(m => typeof m.content === 'string' && m.content.includes(ATTACHED_FILE_PREFIX));
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
      // rather than dropped. Offset by the delivered-content notice, which rides ahead of the file.
      const file = findAttachedFile(result);
      expect(file).toBeDefined();
      // 7708 chars of the file, plus the notice telling the model this is not where the file ends.
      expect(file!.content as string).toContain('Content truncated to fit the context window');
      expect((file!.content as string).indexOf('\n\n[Content truncated')).toBe(
        7708 + ATTACHMENT_DELIVERED_NOTICE.length
      );

      // History still holds the majority of the budget and keeps its newest exchange.
      const labels = historyLabels(result);
      expect(labels).toHaveLength(11);
      expect(labels).toContain('history-39');
      expect(labels).toContain('history-38');

      // The primary allocation kept us in bounds, so the final safety net never had to fire. 6661 plus
      // the delivered-content and anti-inference notices' own real token cost (both fixed, both counted).
      expect(await calculateTotalTokenLength(result, { estimateOnly: false, tokenizer })).toBe(6723);
      expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('exceeds maxInputTokens'));

      // The squeeze is reported, and it names the file so a support engineer can see which one lost.
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('quarterly.csv'));
      expect(getLastBuildDebugInfo()?.truncationMethod).toBe('token-budget');
    });

    it('leaves a fitting attachment untouched and stays silent', async () => {
      const attached = makeAttachedFile(700);
      const tokenizer = createMockTokenizer();

      const result = await buildAndSortMessages([], [attached], [], 8000, {}, 10, mockLogger as any, tokenizer);

      // Byte-identical past the delivered-content notice, not merely present: the squeeze check
      // compares estimates against estimates, so an attachment that fits can never be reported as squeezed.
      expect(findAttachedFile(result)?.content).toBe(ATTACHMENT_DELIVERED_NOTICE + attached.content);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('returns the unused part of the reserve to history', async () => {
      // The file uses most of its 2447-token reserve; the leftover flows back to history, which at 40
      // tokens per message is worth another 15 of them. The truncation notice is part of what content
      // consumed, so history is sized after it - that is why this is 118 and not 119.
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

      expect(historyLabels(result)).toHaveLength(118);
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

      expect(findAttachedFile(result)?.content).toBe(ATTACHMENT_DELIVERED_NOTICE + attached.content);
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

  /**
   * Keyset-paging stand-in for the chunk repository, implementing the REAL cursor arithmetic rather
   * than returning a canned page per call: a page-keyed mock structurally cannot observe a wrong
   * cursor, which is the defect paging introduces. Ids are zero-padded so lexicographic order matches
   * insertion order, the same property a real 24-char ObjectId string has.
   */
  const pagedChunkRepo = (rows: Array<{ id: string; text: string; vector: number[] }>) => ({
    findVectorsByFabFileIds: vi.fn(async (_ids: string[], opts?: { limit?: number; afterChunkId?: string }) =>
      rows
        .filter(r => r.vector && r.vector.length > 0)
        .filter(r => (opts?.afterChunkId ? r.id > opts.afterChunkId : true))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, opts?.limit ?? rows.length)
        .map(r => ({ id: r.id, fabFileId: 'file-1', text: r.text, vector: r.vector }))
    ),
    // The FILE's chunk count, vectorless included - what the caller compares "delivered" against.
    countByFabFileId: vi.fn(async () => rows.length),
  });

  const makeChunks = (count: number, charsEach: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `chunk-${String(i).padStart(4, '0')}`,
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
          fabfilechunks: pagedChunkRepo(chunks),
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

  it("tells the model a filename's digits are not a row count on the vectorized body header", async () => {
    const messages = await runRetrieval(makeChunks(3, 200), 4000);

    const content = messages[0].content as string;
    expect(content).toContain('Data for roster.csv:');
    expect(content).toContain(
      'Digits in the file name are part of the name, not a count of its rows, records, or sections.'
    );
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
      5200,
      {},
      20,
      mockLogger as any,
      dense
    );

    // originalMessageCount is not asserted here: the safety pass can now shrink history itself, so
    // the fixed "40 windowed history + 1 attachment" arithmetic no longer holds.
    const second = getLastBuildDebugInfo();
    expect(second?.truncationMethod).toBe('token-budget');
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
    // A re-measuring loop may cut more than one message per round rather than dropping exactly one.
    expect(debug?.removedMessages?.length).toBeGreaterThanOrEqual(1);
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

describe('array-content fabMessages that carry no image block', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const warnings = () => mockLogger.warn.mock.calls.map(call => String(call[0])).join('\n');

  it('delivers a text-only array-content message to the model (fails against the old two-filter split)', async () => {
    const fab: IMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'MARKER-TEXT-BLOCK from the caller' }] }];

    const result = await buildAndSortMessages(
      [],
      fab,
      [{ role: 'user', content: 'ASK-MARKER' }],
      10000,
      {},
      5,
      mockLogger as any,
      createMockTokenizer()
    );

    const blocks = result.flatMap(m => (Array.isArray(m.content) ? m.content : []));
    expect(
      blocks.some(block => block.type === 'text' && (block as { text: string }).text.includes('MARKER-TEXT-BLOCK'))
    ).toBe(true);
    // Assembled ahead of the prompt, like any other content message.
    const contentIndex = result.findIndex(m => Array.isArray(m.content));
    const promptIndex = result.findIndex(m => m.content === 'ASK-MARKER');
    expect(contentIndex).toBeGreaterThanOrEqual(0);
    expect(contentIndex).toBeLessThan(promptIndex);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('drops a tool_result-bearing array-content message with a warning naming what and why', async () => {
    const fab: IMessage[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'TOOL-PAYLOAD-DO-NOT-LOG' }] },
    ];

    const result = await buildAndSortMessages(
      [],
      fab,
      [{ role: 'user', content: 'ASK-MARKER' }],
      10000,
      {},
      5,
      mockLogger as any,
      createMockTokenizer()
    );

    const blocks = result.flatMap(m => (Array.isArray(m.content) ? m.content : []));
    expect(blocks.some(block => block.type === 'tool_result')).toBe(false);
    expect(warnings()).toContain('tool_result');
    expect(warnings()).toContain('Dropped 1');
    expect(warnings()).toContain('message 1');
    expect(warnings()).not.toContain('TOOL-PAYLOAD-DO-NOT-LOG');
    expect(result.some(m => m.content === 'ASK-MARKER')).toBe(true);
  });

  it('drops a mixed text+tool_result message whole, not just the tool_result block', async () => {
    const fab: IMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'PARTNER-TEXT' },
          { type: 'tool_result', tool_use_id: 'toolu_y', content: 'irrelevant' },
        ],
      },
    ];

    const result = await buildAndSortMessages([], fab, [], 10000, {}, 5, mockLogger as any, createMockTokenizer());

    const text = result
      .flatMap(m => (Array.isArray(m.content) ? m.content : []))
      .filter(block => block.type === 'text')
      .map(block => (block as { text: string }).text)
      .join('');
    expect(text).not.toContain('PARTNER-TEXT');
    expect(warnings()).toContain('text');
    expect(warnings()).toContain('tool_result');
  });

  it('keeps image priority when an image block shares an array with a tool_result block', async () => {
    const fab: IMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'tool_result', tool_use_id: 'toolu_z', content: 'irrelevant' },
        ],
      },
    ];

    const result = await buildAndSortMessages([], fab, [], 10000, {}, 5, mockLogger as any, createMockTokenizer());

    // Classified as an image message (not dropped as "undeliverable blocks") - the image-priority
    // check runs before the allowlist/drop check. The tool_result block riding alongside it is then
    // stripped by ensureToolPairingIntegrity's orphan cleanup at the very end (no tool_use exists
    // anywhere in this call to pair it with), which is correct and separate from classification.
    const imageMessage = result.find(
      m => Array.isArray(m.content) && m.content.some(block => (block as { type?: string }).type === 'image')
    );
    expect(imageMessage).toBeDefined();
    expect(warnings()).not.toContain('Dropped');
  });

  it('drops empty array content with a warning, never as a blank message', async () => {
    const fab: IMessage[] = [{ role: 'user', content: [] }];

    const result = await buildAndSortMessages([], fab, [], 10000, {}, 5, mockLogger as any, createMockTokenizer());

    expect(result.every(m => !Array.isArray(m.content) || m.content.length > 0)).toBe(true);
    expect(warnings()).toContain('Ignored 1');
    expect(warnings()).toContain('empty content array');
  });

  it('drops a thinking-only array-content message with a named warning', async () => {
    const fab: IMessage[] = [{ role: 'user', content: [{ type: 'thinking', thinking: 'internal reasoning' }] }];

    const result = await buildAndSortMessages([], fab, [], 10000, {}, 5, mockLogger as any, createMockTokenizer());

    const blocks = result.flatMap(m => (Array.isArray(m.content) ? m.content : []));
    expect(blocks.some(block => block.type === 'thinking')).toBe(false);
    expect(warnings()).toContain('thinking');
    expect(warnings()).toContain('Dropped 1');
  });

  it('delivers two qualifying text-only array-content messages in order', async () => {
    const fab: IMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'MARKER-A' }] },
      { role: 'user', content: [{ type: 'text', text: 'MARKER-B' }] },
    ];

    const result = await buildAndSortMessages([], fab, [], 10000, {}, 5, mockLogger as any, createMockTokenizer());

    const text = (m: IMessage) => (Array.isArray(m.content) ? ((m.content[0] as { text?: string }).text ?? '') : '');
    const indexA = result.findIndex(m => text(m).includes('MARKER-A'));
    const indexB = result.findIndex(m => text(m).includes('MARKER-B'));
    expect(indexA).toBeGreaterThanOrEqual(0);
    expect(indexB).toBeGreaterThanOrEqual(0);
    expect(indexA).toBeLessThan(indexB);
  });

  it('ignores a non-user-role fabMessage with a named warning (the split-filter hole beyond user array content)', async () => {
    const fab: IMessage[] = [{ role: 'assistant', content: 'ROLE-MARKER should never reach the model this way' }];

    const result = await buildAndSortMessages([], fab, [], 10000, {}, 5, mockLogger as any, createMockTokenizer());

    expect(result.some(m => typeof m.content === 'string' && m.content.includes('ROLE-MARKER'))).toBe(false);
    expect(warnings()).toContain('Ignored 1');
    expect(warnings()).toContain('role assistant');
  });

  it('does not throw on an untyped content block', async () => {
    const fab: IMessage[] = [{ role: 'user', content: [{}] as any }];

    await expect(
      buildAndSortMessages([], fab, [], 10000, {}, 5, mockLogger as any, createMockTokenizer())
    ).resolves.toBeDefined();
    expect(warnings()).toContain('untyped');
    expect(warnings()).toContain('Dropped 1');
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

  const createDenseTokenizer = (charsPerToken: number): ITokenizer => ({
    countTokens: vi.fn(async (text: string) => Math.ceil(text.length / charsPerToken)),
    encodeTokens: vi.fn(async (text: string) => Array(Math.ceil(text.length / charsPerToken)).fill(1)),
    clearCache: vi.fn(),
    getCacheStats: vi.fn(() => ({ size: 0, keys: [] })),
    warmUpCache: vi.fn(async () => {}),
  });

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

    const file = result.find(m => typeof m.content === 'string' && (m.content as string).includes('row-data,'));
    expect(file).toBeDefined();
    const text = file!.content as string;
    expect(text).toContain(NOTICE);
    expect(
      text.endsWith(
        'later content was not sent. Do not infer a total row, record, or section count, or a final row, from what is above.]'
      )
    ).toBe(true);
    // The tail the marker lives in genuinely did not survive, which is exactly why the notice matters.
    expect(text).not.toContain('FINAL_ROW_MARKER');
  });

  it('marks by what was actually cut, not by whether some sibling shares the bytes', async () => {
    // Two collision directions, both broken by inferring truncation from a prefix comparison:
    //  - a whole small file whose content is a prefix of a larger sibling looked truncated;
    //  - a large file cut to exactly a smaller sibling's bytes looked whole.
    // The notice is applied where the cut happens, so neither can happen.
    const tokenizer = createMockTokenizer();
    const small = 'id,name\nrow,1\n';
    const large = small + 'row,2\nrow,3\n';

    const result = await buildAndSortMessages(
      [],
      [
        { role: 'user', content: small },
        { role: 'user', content: large },
      ],
      [{ role: 'user', content: 'summarize' }],
      8000,
      {},
      10,
      mockLogger as any,
      tokenizer
    );

    const delivered = result.filter(m => typeof m.content === 'string' && (m.content as string).includes('id,name'));
    expect(delivered).toHaveLength(2);
    expect(delivered.map(m => m.content)).toEqual(
      expect.arrayContaining([ATTACHMENT_DELIVERED_NOTICE + small, ATTACHMENT_DELIVERED_NOTICE + large])
    );
    for (const m of delivered) expect(m.content as string).not.toContain(NOTICE);
  });

  it('never leaves more than one truncation notice, even when the safety pass cuts twice', async () => {
    // A dense tokenizer forces the safety pass to run after the primary pass already cut and marked the
    // file. Cutting notice-carrying content again lands mid-notice, so appending another one would leave
    // a mangled fragment followed by a whole notice. Budget nudged up from the original 4952: the fixed
    // per-file overhead (the delivered-content and anti-inference notices) now costs more under this
    // dense 2.0-chars/token tokenizer, and the old figure squeezed the file below the useful-content
    // floor entirely rather than leaving it cut-but-delivered.
    const tokenizer = createDenseTokenizer(2.0);
    const body = 'row-data,'.repeat(4000) + '\nFINAL_ROW_MARKER: pineapple';

    const result = await buildAndSortMessages(
      makeHistory(60, 1000),
      [{ role: 'user', content: body }],
      [{ role: 'user', content: 'What is FINAL_ROW_MARKER?' }],
      5200,
      {},
      20,
      mockLogger as any,
      tokenizer
    );

    const file = result.find(m => typeof m.content === 'string' && (m.content as string).includes('row-data,'));
    expect(file).toBeDefined();
    const text = file!.content as string;
    expect(text.split(NOTICE)).toHaveLength(2); // exactly one occurrence
    expect(
      text.endsWith(
        'later content was not sent. Do not infer a total row, record, or section count, or a final row, from what is above.]'
      )
    ).toBe(true);
    // No fragment of a notice stranded earlier in the payload.
    expect(text.slice(0, text.indexOf(NOTICE))).not.toContain('[Content truncated');
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

    const file = result.find(m => typeof m.content === 'string' && (m.content as string).includes('row-data,'));
    expect(file!.content).toBe(ATTACHMENT_DELIVERED_NOTICE + whole);
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

    const delivered = result.find(m => typeof m.content === 'string' && (m.content as string).includes('row,value'));
    expect(delivered!.content).toBe(ATTACHMENT_DELIVERED_NOTICE + file);
    expect(delivered!.content as string).toContain('FINAL_ROW_MARKER: apricot');
    expect(delivered!.content as string).not.toContain(NOTICE);
  });
});

// A model handed real content still opens some replies by denying it can read attachments. The notice
// must ride on content that genuinely survived to the final payload, never on a message that says
// content was dropped - that exact false claim is why an earlier, differently-placed attempt at this
// was reverted.
describe('attachment access notice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks a delivered attachment as readable', async () => {
    const result = await buildAndSortMessages(
      [],
      [{ role: 'user', content: 'id,fruit\nr,apple\n' }],
      [{ role: 'user', content: 'summarize' }],
      8000,
      {},
      10,
      mockLogger as any,
      createMockTokenizer()
    );

    const delivered = result.find(m => typeof m.content === 'string' && (m.content as string).includes('id,fruit'));
    expect(delivered!.content as string).toMatch(
      new RegExp(`^${ATTACHMENT_DELIVERED_NOTICE.replace(/[[\]().]/g, '\\$&')}`)
    );
  });

  it('never marks the note that says content could not be delivered', async () => {
    const tokenizer: ITokenizer = {
      countTokens: vi.fn(async (text: string) => Math.ceil(text.length / 3.5)),
      encodeTokens: vi.fn(async (text: string) => Array(Math.ceil(text.length / 3.5)).fill(1)),
      clearCache: vi.fn(),
      getCacheStats: vi.fn(() => ({ size: 0, keys: [] })),
      warmUpCache: vi.fn(async () => {}),
    };
    const history = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `history-${i}-` + 'h'.repeat(240),
    }));

    const result = await buildAndSortMessages(
      history,
      [
        { role: 'system', content: 'S'.repeat(1500 * 3.5) },
        { role: 'user', content: 'alpha,col\n' + 'r,1\n'.repeat(3000) },
        { role: 'user', content: 'bravo,col\n' + 'r,1\n'.repeat(3000) },
      ],
      [{ role: 'user', content: 'What do the attached files contain?' }],
      2200,
      {},
      20,
      mockLogger as any,
      tokenizer
    );

    const note = result.find(
      m => typeof m.content === 'string' && (m.content as string).includes('could not be included')
    );
    expect(note).toBeDefined();
    expect(note!.content as string).not.toContain(ATTACHMENT_DELIVERED_NOTICE.trim());
  });

  it('marks one delivered file while its dropped sibling is only named in the undelivered note', async () => {
    const tokenizer: ITokenizer = {
      countTokens: vi.fn(async (text: string) => Math.ceil(text.length / 3.5)),
      encodeTokens: vi.fn(async (text: string) => Array(Math.ceil(text.length / 3.5)).fill(1)),
      clearCache: vi.fn(),
      getCacheStats: vi.fn(() => ({ size: 0, keys: [] })),
      warmUpCache: vi.fn(async () => {}),
    };

    const result = await buildAndSortMessages(
      [],
      [
        { role: 'user', content: 'small,file\nrow,1\n' },
        { role: 'system', content: 'S'.repeat(1500 * 3.5) },
        { role: 'user', content: 'big,file\n' + 'row,1\n'.repeat(3000) },
      ],
      [{ role: 'user', content: 'summarize both' }],
      2200,
      {},
      20,
      mockLogger as any,
      tokenizer
    );

    const small = result.find(m => typeof m.content === 'string' && (m.content as string).includes('small,file'));
    const note = result.find(
      m => typeof m.content === 'string' && (m.content as string).includes('could not be included')
    );
    expect(small!.content as string).toContain(ATTACHMENT_DELIVERED_NOTICE.trim());
    expect(note).toBeDefined();
    expect(result.some(m => typeof m.content === 'string' && (m.content as string).includes('big,file'))).toBe(false);
  });
});

// Production always carries system instructions - date context, artifact guidance, help-centre
// awareness - and they are subtracted from the budget BEFORE content and history are allocated. Every
// other case in this file runs with no system messages at all, which is why two rounds of QA found
// budget behaviour these tests could not see. These use an 8k-class window plus a realistic system load.
describe('allocation under a production-shaped system-prompt load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Llama 4 Maverick 8K context / 2K output: 8192 - 2048 - 1000 emergency buffer.
  const LLAMA_8K_INPUT_BUDGET = 5144;
  // GPT-4 8K context / 4K output leaves far less room for anything else.
  const GPT4_8K_INPUT_BUDGET = 3096;
  const SYSTEM_TOKENS = 1500;

  const systemLoad = (): IMessage => ({ role: 'system', content: 'S'.repeat(SYSTEM_TOKENS * 3.5) });
  const history = (count: number): IMessage[] =>
    Array.from({ length: count }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `history-${i}-` + 'h'.repeat(240),
    }));
  const csv = (chars: number): IMessage => ({
    role: 'user',
    content:
      'id,fruit,color\n' +
      'r,apple,red\n'.repeat(Math.max(0, Math.floor((chars - 40) / 12))) +
      'FINAL_ROW_MARKER: apricot',
  });
  const question: IMessage[] = [
    { role: 'user', content: 'What is the value of FINAL_ROW_MARKER in the attached file?' },
  ];
  const NOTICE = 'Content truncated to fit the context window';

  it('delivers a 2k file whole on an 8k model, marker included', async () => {
    // This is the size the Guide for Testers now specifies, derived from this budget rather than guessed.
    const tokenizer = createMockTokenizer();
    const file = csv(2052);

    const result = await buildAndSortMessages(
      history(18),
      [systemLoad(), file],
      question,
      LLAMA_8K_INPUT_BUDGET,
      {},
      20,
      mockLogger as any,
      tokenizer
    );

    const delivered = result.find(
      m => typeof m.content === 'string' && (m.content as string).includes('id,fruit,color')
    );
    expect(delivered!.content).toBe(ATTACHMENT_DELIVERED_NOTICE + file.content);
    expect(delivered!.content as string).toContain('FINAL_ROW_MARKER: apricot');
    expect(delivered!.content as string).not.toContain(NOTICE);
    expect(await calculateTotalTokenLength(result, { estimateOnly: false, tokenizer })).toBeLessThanOrEqual(
      LLAMA_8K_INPUT_BUDGET
    );
  });

  it('delivers a 4k file whole on an 8k model under a full system load', async () => {
    // QA attached exactly this and expected the trailing marker. It used to be unreachable: the content
    // floor was a share of what survived the system stack, about 900 tokens, so ~2.9k of 4k characters
    // was the ceiling. The floor is now a share of the pre-system budget - ~1,445 tokens against the
    // file's ~1,143 - so the whole file fits and the marker arrives.
    const tokenizer = createMockTokenizer();

    const result = await buildAndSortMessages(
      history(40),
      [systemLoad(), csv(4004)],
      question,
      LLAMA_8K_INPUT_BUDGET,
      {},
      20,
      mockLogger as any,
      tokenizer
    );

    const delivered = result.find(
      m => typeof m.content === 'string' && (m.content as string).includes('id,fruit,color')
    );
    expect(delivered).toBeDefined();
    const text = delivered!.content as string;
    expect(text).toContain('FINAL_ROW_MARKER: apricot');
    expect(text).not.toContain(NOTICE);
    // The system load fits alongside it rather than being traded away for the file.
    expect(result.some(m => m.role === 'system')).toBe(true);
    // Nothing was lost, so nothing should be reported as lost.
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(await calculateTotalTokenLength(result, { estimateOnly: false, tokenizer })).toBeLessThanOrEqual(
      LLAMA_8K_INPUT_BUDGET
    );
  });

  it('sheds system instructions rather than the file when both cannot fit', async () => {
    // GPT-4's 4k output reserve leaves ~2,081 tokens to divide. The file's floor is 35% of that, and
    // system instructions are capped at the remaining 65% (~1,353), which this 1,500-token load exceeds
    // - so it is dropped deliberately and the file still arrives usefully cut rather than being
    // declared undeliverable. The trade is the point: the user attached the file.
    const tokenizer = createMockTokenizer();

    const result = await buildAndSortMessages(
      history(40),
      [systemLoad(), csv(4004)],
      question,
      GPT4_8K_INPUT_BUDGET,
      {},
      20,
      mockLogger as any,
      tokenizer
    );

    const delivered = result.find(
      m => typeof m.content === 'string' && (m.content as string).includes('id,fruit,color')
    );
    expect(delivered).toBeDefined();
    // Cut, and said so - a silent cut is the failure this area exists to prevent.
    expect(delivered!.content as string).toContain(NOTICE);
    // Not the pre-fix outcome, where the file's share collapsed and it was declared undeliverable.
    expect(
      result.some(m => typeof m.content === 'string' && (m.content as string).includes('could not be included'))
    ).toBe(false);
    expect(result.some(m => m.role === 'system')).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('No system instructions fit the budget'));
    expect(await calculateTotalTokenLength(result, { estimateOnly: false, tokenizer })).toBeLessThanOrEqual(
      GPT4_8K_INPUT_BUDGET
    );
  });
});

// Which system messages survive a squeeze, and in what order they are sent. Before this the answer to
// both was "assembly position", so a caller's org prompt lost to whatever happened to precede it.
describe('system-message retention under a capped budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const sysOf = (tokens: number, tag: string): IMessage => ({
    role: 'system',
    content: `${tag}:` + 'S'.repeat(Math.max(0, tokens * 3.5 - tag.length - 1)),
  });
  const ask: IMessage[] = [{ role: 'user', content: 'hello' }];
  const tagsIn = (result: IMessage[]) =>
    result.filter(m => m.role === 'system').map(m => (m.content as string).split(':')[0]);

  it('sends survivors in assembly order, not in priority order', async () => {
    const first = sysOf(100, 'first');
    const second = sysOf(100, 'second');
    const third = sysOf(100, 'third');
    // Priorities deliberately disagree with assembly order; all three fit, so nothing is dropped and
    // only the ordering is under test. Reordering the payload would cost the Anthropic cached prefix.
    const priority = new Map<IMessage, number>([
      [first, 2],
      [second, 0],
      [third, 1],
    ]);

    const result = await buildAndSortMessages(
      [],
      [first, second, third],
      ask,
      20_000,
      {},
      20,
      mockLogger as any,
      createMockTokenizer(),
      { verbose: false, systemMessagePriority: m => priority.get(m) }
    );

    expect(tagsIn(result)).toEqual(['first', 'second', 'third']);
  });

  it('skips an oversized prompt and still admits a smaller one behind it', async () => {
    const oversized = sysOf(6000, 'oversized');
    const small = sysOf(50, 'small');
    // Priority puts the oversized one first, which is exactly the case the old `break` mishandled: it
    // stopped at the first message over budget and discarded everything after it.
    const priority = new Map<IMessage, number>([
      [oversized, 0],
      [small, 1],
    ]);

    const result = await buildAndSortMessages(
      [],
      [oversized, small],
      ask,
      6000,
      {},
      20,
      mockLogger as any,
      createMockTokenizer(),
      { verbose: false, systemMessagePriority: m => priority.get(m) }
    );

    expect(tagsIn(result)).toEqual(['small']);
  });

  it('drops the lowest-priority prompt first when they cannot all fit', async () => {
    const keep = sysOf(2000, 'keep');
    const shed = sysOf(2000, 'shed');
    const priority = new Map<IMessage, number>([
      [keep, 10],
      [shed, 30],
    ]);

    // Room for one of the two, so the choice between them is the whole assertion.
    const result = await buildAndSortMessages(
      [],
      [shed, keep],
      ask,
      3600,
      {},
      20,
      mockLogger as any,
      createMockTokenizer(),
      { verbose: false, systemMessagePriority: m => priority.get(m) }
    );

    expect(tagsIn(result)).toEqual(['keep']);
  });

  // Array content is legal on a system message and arrives that way from extraContextMessages, a public
  // request field. Sized by a bare `content as string` cast, an array's ELEMENT COUNT was divided by
  // CHARS_PER_TOKEN, so one huge block measured ~1 token: it cleared the cap for free and the file paid
  // for it at the safety pass, which shrinks content but never system messages.
  it('measures a system message with array content by its text, not its block count', async () => {
    const huge: IMessage = { role: 'system', content: [{ type: 'text', text: 'S'.repeat(25_000) }] as any };
    const marker = 'FINAL_ROW_MARKER: apricot';
    const csv = 'id,fruit,color\n' + 'r,apple,red\n'.repeat(100) + marker;

    const result = await buildAndSortMessages(
      [],
      [huge, { role: 'user', content: csv }],
      ask,
      6000,
      {},
      20,
      mockLogger as any,
      createMockTokenizer()
    );

    // ~7,150 real tokens against a cap near 3,250: too big to admit, so it is dropped deliberately.
    expect(result.some(m => m.role === 'system')).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('No system instructions fit the budget'));
    // And the attachment keeps its budget rather than paying for an unmeasured block.
    const delivered = result.find(m => typeof m.content === 'string' && m.content.includes('id,fruit,color'));
    expect(delivered?.content as string).toContain(marker);
  });

  it('still admits a small array-content system message', async () => {
    const small: IMessage = { role: 'system', content: [{ type: 'text', text: 'be brief' }] as any };

    const result = await buildAndSortMessages([], [small], ask, 6000, {}, 20, mockLogger as any, createMockTokenizer());

    expect(result.some(m => m.role === 'system')).toBe(true);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  // The unlimited-history path splits the budget 70/30 instead of using the floor, and 70% of what
  // survived a heavy system stack is LESS than 35% of the budget before it. Without the floor on this
  // branch too, the same file that arrives whole on a windowed turn was cut on an unwindowed one.
  it('honours the content floor on an unwindowed request as well', async () => {
    const heavy = sysOf(2600, 'heavy');
    const csv = 'id,fruit,color\n' + 'r,apple,red\n'.repeat(330) + 'FINAL_ROW_MARKER: apricot';

    const result = await buildAndSortMessages(
      Array.from({ length: 40 }, (_, i) => ({
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `history-${i}-` + 'h'.repeat(240),
      })),
      [heavy, { role: 'user', content: csv }],
      ask,
      5144,
      {},
      // UNLIMITED_HISTORY_COUNT, so allocation takes the 70/30 branch rather than the windowed floor.
      // It is -1, not a large count: the in-range sentinel it replaced could collide with a real one.
      -1,
      mockLogger as any,
      createMockTokenizer()
    );

    const delivered = result.find(
      m => typeof m.content === 'string' && (m.content as string).includes('id,fruit,color')
    );
    expect(delivered).toBeDefined();
    expect(delivered!.content as string).toContain('FINAL_ROW_MARKER: apricot');
  });

  // The reserve only exists to protect an attachment, so a turn without one must not pay for it. This
  // is the pair of assertions that pins the condition in both directions.
  it('caps system instructions only when the turn carries an attachment', async () => {
    const heavy = () => sysOf(4000, 'heavy');
    const run = (fabMessages: IMessage[]) =>
      buildAndSortMessages([], fabMessages, ask, 6000, {}, 20, mockLogger as any, createMockTokenizer());

    const withoutAttachment = await run([heavy()]);
    const withAttachment = await run([heavy(), { role: 'user', content: 'id,fruit\n' + 'r,apple\n'.repeat(50) }]);

    // ~4,990 of pre-system budget, so 4,000 tokens of instructions fit when nothing is reserved.
    expect(tagsIn(withoutAttachment)).toEqual(['heavy']);
    // With a file present the cap falls to ~3,244 and the same stack no longer fits.
    expect(tagsIn(withAttachment)).toEqual([]);
  });
});

// Two attachments each cut to an unusable fragment: summing them hides the case, because the total
// clears the threshold while neither file individually says anything.
describe('unusable attachments are judged one at a time', () => {
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

  it('replaces two per-file slivers whose combined size clears the threshold', async () => {
    const tokenizer = createDenseTokenizer(3.5);
    const history = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `history-${i}-` + 'h'.repeat(240),
    }));
    const bigCsv = (tag: string) => ({ role: 'user' as const, content: `${tag},col\n` + 'r,1\n'.repeat(3000) });

    // 2200 rather than the 3096 this used at first: raising the content floor to a share of the
    // pre-system budget lifted both files clear of the usability threshold, so the sliver case this
    // test exists for now needs a genuinely smaller window to reach.
    const result = await buildAndSortMessages(
      history,
      [{ role: 'system', content: 'S'.repeat(1500 * 3.5) }, bigCsv('alpha'), bigCsv('bravo')],
      [{ role: 'user', content: 'What do the attached files contain?' }],
      2200,
      {},
      20,
      mockLogger as any,
      tokenizer
    );

    const note = result.find(
      m => typeof m.content === 'string' && (m.content as string).includes('could not be included')
    );
    expect(note).toBeDefined();
    expect(note!.content as string).toContain('2 attached file(s)');
    // Neither useless fragment is sent alongside the explanation.
    expect(result.some(m => typeof m.content === 'string' && (m.content as string).startsWith('alpha,col'))).toBe(
      false
    );
    expect(result.some(m => typeof m.content === 'string' && (m.content as string).startsWith('bravo,col'))).toBe(
      false
    );
  });
});

describe('the safety pass on paths the primary allocation does not reach', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const CONTENT_TRUNCATION_NOTICE =
    '\n\n[Content truncated to fit the context window. This is NOT the end of the file - later content was not sent.]';

  const tokenizerAt = (charsPerToken: number): ITokenizer => ({
    countTokens: vi.fn(async (text: string) => Math.ceil(text.length / charsPerToken)),
    encodeTokens: vi.fn(async (text: string) => Array(Math.ceil(text.length / charsPerToken)).fill(1)),
    clearCache: vi.fn(),
    getCacheStats: vi.fn(() => ({ size: 0, keys: [] })),
    warmUpCache: vi.fn(async () => {}),
  });

  const history = (count: number, charsEach: number): IMessage[] =>
    Array.from({ length: count }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `h${i}-`.padEnd(charsEach, 'x'),
    }));

  const attachment = (fileName: string, chars: number): IMessage => ({
    role: 'user',
    content: `Here is the content from the attached file "${fileName}" for context:\n\n` + 'C'.repeat(chars),
  });

  const delivered = (messages: IMessage[]): string =>
    messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('');

  const warnings = (): string => (mockLogger.warn.mock.calls as unknown[][]).map(call => String(call[0])).join('\n');

  it('trims proportionally on an image turn instead of asking content for everything', async () => {
    // The estimator used to JSON-stringify base64 image data as text while the real tokenizer charged
    // a flat 1600, so the ratio converting the overage between the two units collapsed and round 1
    // zeroed the attachment when a ~200-token trim was enough.
    const tokenizer = tokenizerAt(3.5);
    const result = await buildAndSortMessages(
      history(10, 500),
      [
        attachment('roster.csv', 10000),
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(300000) } },
          ] as unknown as IMessage['content'],
        },
      ],
      [{ role: 'user', content: 'Summarize the attached file' }],
      5700,
      {},
      5,
      mockLogger as any,
      tokenizer
    );

    // Most of the file still reaches the model, and it is never reduced to the could-not-be-included note.
    expect(delivered(result)).toContain('C'.repeat(7000));
    expect(delivered(result)).not.toContain('could not be included');
    expect(await calculateTotalTokenLength(result, { estimateOnly: false, tokenizer })).toBeLessThanOrEqual(5700);
  });

  it('declares an attachment the safety pass drops, not just one the allocation drops', async () => {
    // The allocation delivers the file, then the safety pass drops it whole. The note is applied before
    // that pass, so the file used to vanish with nothing said and the model denied it was ever attached.
    const result = await buildAndSortMessages(
      history(40, 1000),
      [attachment('roster.csv', 3000)],
      [{ role: 'user', content: 'Summarize the attached file' }],
      12000,
      {},
      20,
      mockLogger as any,
      tokenizerAt(1.5)
    );

    expect(delivered(result)).toContain('could not be included in this request');
    expect(delivered(result)).toContain('do not tell the user that no file was provided');
    // Names no file: which one was lost is not knowable once processMessages has replaced the objects,
    // and listing them all let the model disclaim a file it did receive.
    expect(delivered(result)).not.toContain('roster.csv');
  });

  it('keeps a history reduction that frees tokens without changing the message count', async () => {
    // processMessages' fallback shrinks messages in place. The pass compared message counts, so it read
    // "same count" as "cannot shrink", discarded a valid reduction and handed the caller an oversized
    // payload for its hard throw.
    // 20k window so the 1000-token reserve stays small next to it, one history message the allocation
    // can afford whole, and 2.0 chars/token so only the real count overflows.
    const maxInputTokens = 20000;
    const tokenizer = tokenizerAt(2.0);
    const result = await buildAndSortMessages(
      [{ role: 'user', content: 'H'.repeat(63000) }],
      [],
      [{ role: 'user', content: 'Carry on' }],
      maxInputTokens,
      {},
      3,
      mockLogger as any,
      tokenizer
    );

    expect(await calculateTotalTokenLength(result, { estimateOnly: false, tokenizer })).toBeLessThanOrEqual(
      maxInputTokens
    );
    expect(warnings()).not.toContain('could not bring the payload under');
  });

  it('reports a mid-message cut made by the safety pass as a budget truncation', async () => {
    // The allocation delivers the file whole and removes nothing, so allRemovedMessages stays empty and
    // only the safety pass's cut is evidence of loss. Telemetry used to call this turn untruncated.
    // Sized so the allocation delivers the file whole (17143 est. tokens against an 18881 content
    // budget) and only the 2.5-chars/token real count overflows, so the pass's cut is the sole loss.
    await buildAndSortMessages(
      history(2, 200),
      [attachment('roster.csv', 60000)],
      [{ role: 'user', content: 'Summarize' }],
      20000,
      {},
      5,
      mockLogger as any,
      tokenizerAt(2.5)
    );

    const debug = getLastBuildDebugInfo();
    expect(debug?.wasTruncated).toBe(true);
    expect(debug?.truncationMethod).toBe('token-budget');
  });

  it('keeps fetched page content out of the warning it logs', async () => {
    // A URL-derived attachment's first line is raw fetched body, not a filename header, so logging the
    // first 120 chars of it put page content into warn-level logs.
    await buildAndSortMessages(
      history(10, 500),
      [{ role: 'user', content: 'For context: ' + 'PAGEBODY-'.repeat(2000) }],
      [{ role: 'user', content: 'Summarize it' }],
      1500,
      {},
      5,
      mockLogger as any,
      createMockTokenizer()
    );

    expect(warnings()).toContain('squeezed to fit the token budget');
    expect(warnings()).not.toContain('PAGEBODY');
    expect(warnings()).toContain('attachment 1');
  });

  it('declares a dropped file even when an empty attachment survives in its place', async () => {
    // droppedCount compared the delivered message count against attachments that had content. An
    // attachment with nothing extractable is absent from the second set but still present in the
    // first, so it stood in for the dropped sibling one-for-one and the drop went undeclared.
    const result = await buildAndSortMessages(
      history(20, 3000),
      [{ role: 'user', content: '' }, attachment('roster.csv', 40000)],
      [{ role: 'user', content: 'Summarize the attached file' }],
      20000,
      {},
      15,
      mockLogger as any,
      createMockTokenizer()
    );

    expect(delivered(result)).toContain('could not be included in this request');
  });

  it('does not mistake a file ending in the notice text for a cut one', async () => {
    // Truncation was detected by sniffing for the appended notice, so a small file whose own last line
    // happened to be that sentence was judged an unusable sliver and replaced - losing a file that fit.
    const result = await buildAndSortMessages(
      history(2, 100),
      [
        {
          role: 'user',
          content:
            'Here is the content from the attached file "small.csv" for context:\n\n' +
            'row-a\nrow-b\nrow-c\n' +
            CONTENT_TRUNCATION_NOTICE,
        },
      ],
      [{ role: 'user', content: 'What is in the file' }],
      100000,
      {},
      5,
      mockLogger as any,
      createMockTokenizer()
    );

    expect(delivered(result)).toContain('row-a\nrow-b\nrow-c');
    expect(delivered(result)).not.toContain('could not be included');
  });

  it('shrinks a tool-call turn without orphaning the pairing', async () => {
    // A tool-call turn takes the other assembly order, and the pass now rewrites both the content and
    // the history that order is applied to. Nothing else in this suite drives an overflow through that
    // branch, so this is the only cover for it.
    const maxInputTokens = 6000;
    const tokenizer = tokenizerAt(1.5);
    const toolUseHistory: IMessage[] = [
      ...history(6, 800),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} }] as unknown as IMessage['content'],
      },
    ];
    const result = await buildAndSortMessages(
      toolUseHistory,
      [attachment('roster.csv', 20000)],
      [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] as unknown as IMessage['content'],
        },
        { role: 'user', content: 'ASK-MARKER summarize the attached file' },
      ],
      maxInputTokens,
      {},
      10,
      mockLogger as any,
      tokenizer
    );

    const blocks = result.flatMap(message => (Array.isArray(message.content) ? message.content : []));
    const toolUseIds = new Set(blocks.filter((block: any) => block.type === 'tool_use').map((block: any) => block.id));
    // Whatever survived, no tool_result may reference a tool_use that did not.
    for (const block of blocks.filter((b: any) => b.type === 'tool_result')) {
      expect(toolUseIds.has((block as any).tool_use_id)).toBe(true);
    }

    // The question still reaches the model: an overflow that silently ate the prompt would be worse than
    // the overflow.
    expect(result.some(m => typeof m.content === 'string' && m.content.includes('ASK-MARKER'))).toBe(true);
    expect(await calculateTotalTokenLength(result, { estimateOnly: false, tokenizer })).toBeLessThanOrEqual(
      maxInputTokens
    );
  });

  it('declares the loss once, however many rounds the pass spends', async () => {
    // The pass re-declares every round so the note tracks what it has dropped so far, which only works if
    // the call replaces the previous note instead of appending another. Appending is worse than a stale
    // note: each copy costs about 100 tokens the pass is trying to free, and a stale note itself passes
    // the delivered-attachment predicate, so every extra copy claims one fewer lost file than the last -
    // ending with the model told one file is missing when three are.
    const result = await buildAndSortMessages(
      history(40, 1000),
      [attachment('a.csv', 3000), attachment('b.csv', 3000), attachment('c.csv', 3000)],
      [{ role: 'user', content: 'Summarize the attached files' }],
      12000,
      {},
      20,
      mockLogger as any,
      tokenizerAt(1.5)
    );

    const text = delivered(result);
    expect(text.split('could not be included in this request').length - 1).toBe(1);
    // The surviving note has to state the real number, not what is left after stale copies were counted
    // as delivered files.
    expect(text).toContain('3 attached file(s) could not be included');
  });

  it('logs the composition when nothing left is droppable, rather than returning quietly', async () => {
    // Images are assembled in at a flat rate and neither branch can touch them, so an overflow made of
    // images cannot be shrunk. The caller's hard throw is reachable from more than the composer, so the
    // one thing this path must not do is hand back an oversized payload with nothing said.
    const result = await buildAndSortMessages(
      [],
      Array.from({ length: 8 }, () => ({
        role: 'user' as const,
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(200) } },
        ] as unknown as IMessage['content'],
      })),
      [{ role: 'user', content: 'What do these show?' }],
      1200,
      {},
      5,
      mockLogger as any,
      tokenizerAt(3.5)
    );

    expect(warnings()).toContain('could not bring the payload under maxInputTokens');
    expect(warnings()).toContain('image message(s)');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('includeHardcodedSystemMessage - format prompt scoping', () => {
  it('prepends the shared default when no template is stored', () => {
    const result = includeHardcodedSystemMessage([{ role: 'user', content: 'hi' }], '');
    expect(result[0]).toEqual({ role: 'system', content: FORMAT_PROMPT_TEMPLATE });
    expect(result[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('uses the stored template verbatim when provided, prepended ahead of existing messages', () => {
    const existing: IMessage[] = [{ role: 'system', content: 'other block' }];
    const result = includeHardcodedSystemMessage(existing, 'Custom template.');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'system', content: 'Custom template.' });
    expect(result[1]).toEqual(existing[0]);
  });

  it('keeps the default scoped to formatting so it cannot bleed into whether to answer', () => {
    // The prior wording ("Adhere to specific formatting requests...") read as general compliance
    // and roughly halved refusal quality when it was the only system content.
    expect(FORMAT_PROMPT_TEMPLATE).toMatch(/^Formatting only - nothing here decides whether or how fully to answer/);
    expect(FORMAT_PROMPT_TEMPLATE).not.toMatch(/adhere to/i);
  });
});

const IMAGE_PROMPT_MATCH = /MUST use the image_generation tool/;
const hasImagePrompt = (messages: IMessage[]) =>
  messages.some(m => typeof m.content === 'string' && IMAGE_PROMPT_MATCH.test(m.content));

describe('includeImagePromptSystemMessage - tool availability gate', () => {
  it('injects nothing when image_generation is not on the turn, even on an explicit image request', () => {
    expect(includeImagePromptSystemMessage([], 'draw me a picture of a cat', false)).toEqual([]);
  });

  it('injects the instruction when the tool is available', () => {
    const result = includeImagePromptSystemMessage([], 'draw me a picture of a cat', true);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('system');
    expect(result[0].content as string).toMatch(IMAGE_PROMPT_MATCH);
  });

  it('prepends ahead of the messages it is given', () => {
    const existing: IMessage[] = [{ role: 'system', content: 'other block' }];
    const result = includeImagePromptSystemMessage(existing, 'a painting of a fox', true);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual(existing[0]);
  });

  it('leaves the messages untouched when the prompt asks for no image at all', () => {
    const existing: IMessage[] = [{ role: 'user', content: 'what is the capital of France' }];
    expect(includeImagePromptSystemMessage(existing, 'what is the capital of France', true)).toEqual(existing);
  });
});

describe('includeImagePromptSystemMessage - request trigger', () => {
  const fires = (prompt: string) => includeImagePromptSystemMessage([], prompt, true).length === 1;

  // The substring scan matched these as `visual`, `graphic` and `diagram`, so a MUST-generate-an-image
  // instruction landed on prompts that only talked about visualizing or diagrams.
  it.each([
    'help me visualize this data',
    'a visualization of the deploy pipeline',
    'the graphical output is wrong',
    'can you explain what this diagram means',
    'draw a diagram of the auth flow',
    'give me a snapshot of the metrics table',
  ])('does not fire on %j', prompt => {
    expect(fires(prompt)).toBe(false);
  });

  it.each([
    'draw me a picture of a cat',
    'an image of a cat',
    'generate some photos of the coast',
    'An Illustration Of A Fox',
    'a comic book cover for this story',
    'paint a watercolour of the harbour',
  ])('fires on %j', prompt => {
    expect(fires(prompt)).toBe(true);
  });

  // A `g` flag on the module-scope pattern would carry lastIndex between calls, making the result
  // depend on whatever prompt came before.
  it('matches the same prompt on repeated calls', () => {
    expect(fires('a picture of a cat')).toBe(true);
    expect(fires('a picture of a cat')).toBe(true);
  });
});

describe('buildAndSortMessages - image prompt threading', () => {
  const buildWithOptions = (options?: { verbose: boolean; imageGenerationAvailable?: boolean }) =>
    buildAndSortMessages(
      [],
      [],
      [{ role: 'user', content: 'draw me a picture of a cat' }],
      100000,
      { UseImagePrompt: 'true' },
      0,
      mockLogger,
      createMockTokenizer(),
      options
    );

  it('injects the image prompt when the caller reports the tool available', async () => {
    expect(hasImagePrompt(await buildWithOptions({ verbose: false, imageGenerationAvailable: true }))).toBe(true);
  });

  it('injects nothing when the caller reports the tool unavailable', async () => {
    expect(hasImagePrompt(await buildWithOptions({ verbose: false, imageGenerationAvailable: false }))).toBe(false);
  });

  // Fails closed: a caller that never threads availability through gets no instruction, rather than
  // one aimed at a tool the model may not hold.
  it('injects nothing when the caller passes no options at all', async () => {
    expect(hasImagePrompt(await buildWithOptions())).toBe(false);
  });

  // The two options are independent: skipping the admin templates removes the image prompt whatever
  // availability says, so a raw-mode turn must not carry it even with the tool attached.
  it('injects nothing when the admin templates are skipped, even with the tool available', async () => {
    expect(
      hasImagePrompt(
        await buildWithOptions({
          verbose: false,
          imageGenerationAvailable: true,
          skipAdminPromptTemplates: true,
        } as any)
      )
    ).toBe(false);
  });
});

describe('admin prompt templates', () => {
  const FORMAT_TEMPLATE = 'Adhere to specific formatting requests such as TypeScript.';
  const settings = { UseFormatPrompt: 'true', FormatPromptTemplate: FORMAT_TEMPLATE };

  const build = async (options?: { verbose: boolean; skipAdminPromptTemplates?: boolean }) =>
    buildAndSortMessages(
      [],
      [],
      [{ role: 'user', content: 'hello' }],
      100000,
      settings,
      0,
      mockLogger as any,
      createMockTokenizer(),
      options
    );

  const carriesFormatTemplate = (messages: IMessage[]) =>
    messages.some(m => typeof m.content === 'string' && m.content.includes(FORMAT_TEMPLATE));

  it('injects the admin format template by default, since in-app completions expect it', async () => {
    expect(carriesFormatTemplate(await build())).toBe(true);
  });

  // This template is invisible from ChatCompletionProcess - it is appended here - and it measurably
  // suppressed the model's willingness to refuse an underspecified request. A caller asking for an
  // unadorned completion has to be able to reach it.
  it('omits the admin format template when the caller opts out', async () => {
    expect(carriesFormatTemplate(await build({ verbose: false, skipAdminPromptTemplates: true }))).toBe(false);
  });
});
