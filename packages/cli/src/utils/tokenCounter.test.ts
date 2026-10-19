import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TokenCounter, getTokenCounter } from './tokenCounter.js';
import type { Session } from '../storage/types.js';

describe('TokenCounter', () => {
  let counter: TokenCounter;

  beforeEach(() => {
    counter = new TokenCounter();
  });

  afterEach(() => {
    counter.dispose();
    // Clean up singleton as well
    getTokenCounter().dispose();
  });

  describe('countTokens', () => {
    it('should count tokens in a simple string', () => {
      const tokens = counter.countTokens('Hello, world!');

      // cl100k_base encoding: "Hello, world!" is typically 4 tokens
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(20);
    });

    it('should count more tokens for longer text', () => {
      const shortTokens = counter.countTokens('Hello');
      const longTokens = counter.countTokens(
        'Hello, this is a much longer piece of text that should have more tokens.'
      );

      expect(longTokens).toBeGreaterThan(shortTokens);
    });

    it('should handle empty string', () => {
      expect(counter.countTokens('')).toBe(0);
    });

    it('should count special-token literals instead of rejecting them', () => {
      // Pasted text, file content and tool output can all carry one of these. tiktoken's encode()
      // rejects them, which took the TUI down; ordinary encoding charges them as the characters
      // they are (so > 1, not the single token an admitted special token would cost).
      expect(counter.countTokens('what does <|endoftext|> mean')).toBeGreaterThan(1);
      expect(counter.countTokens('<|endofprompt|>')).toBeGreaterThan(1);
      expect(counter.countTokens('<|fim_prefix|>')).toBeGreaterThan(1);
    });
  });

  describe('count cache', () => {
    const LONG = 'The quick brown fox jumps over the lazy dog. '.repeat(20);

    // encode is private; spying on it is the only way to see whether a count re-encoded.
    const spyEncode = (target: TokenCounter) =>
      vi.spyOn(target as unknown as { encode: (text: string) => number }, 'encode');

    it('returns a repeated long text from the cache without re-encoding', () => {
      const encode = spyEncode(counter);
      const first = counter.countTokens(LONG);

      expect(counter.countTokens(LONG)).toBe(first);
      expect(encode).toHaveBeenCalledTimes(1);
    });

    it('matches an uncached count exactly', () => {
      const fresh = new TokenCounter();
      counter.countTokens(LONG);

      expect(counter.countTokens(LONG)).toBe(fresh.countTokens(LONG));
      fresh.dispose();
    });

    it('does not cache short text', () => {
      const encode = spyEncode(counter);
      counter.countTokens('short');
      counter.countTokens('short');

      expect(encode).toHaveBeenCalledTimes(2);
    });

    it('evicts the least recently used text once over its character cap', () => {
      const small = new TokenCounter(LONG.length * 2);
      const encode = spyEncode(small);
      const [a, b, c] = ['a', 'b', 'c'].map(prefix => prefix + LONG.slice(1));

      small.countTokens(a);
      small.countTokens(b);
      small.countTokens(a); // a is now the most recently used
      small.countTokens(c); // over the cap: evicts b, keeps a
      encode.mockClear();

      small.countTokens(a);
      expect(encode).not.toHaveBeenCalled();
      small.countTokens(b);
      expect(encode).toHaveBeenCalledTimes(1);
      small.dispose();
    });

    it('serves a calibrated view from the raw cache and still scales it', () => {
      const encode = spyEncode(counter);
      const raw = counter.countTokens(LONG);

      expect(counter.forModel('claude-sonnet-5').countTokens(LONG)).toBe(Math.ceil((raw * 150) / 100));
      expect(encode).toHaveBeenCalledTimes(1);
    });

    it('drops the cache on dispose', () => {
      const encode = spyEncode(counter);
      counter.countTokens(LONG);
      counter.dispose();
      counter.countTokens(LONG);

      expect(encode).toHaveBeenCalledTimes(2);
    });
  });

  describe('countSessionTokens', () => {
    function createSession(messages: Session['messages'] = []): Session {
      return {
        id: 'test-session',
        name: 'Test Session',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        model: 'claude-sonnet',
        messages,
        metadata: { totalTokens: 0, totalCost: 0, toolCallCount: 0 },
      };
    }

    it('should count tokens in session messages and system prompt', () => {
      const session = createSession([
        { id: 'msg-1', role: 'user', content: 'What is the capital of France?', timestamp: new Date().toISOString() },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'The capital of France is Paris.',
          timestamp: new Date().toISOString(),
        },
      ]);

      const result = counter.countSessionTokens(session, 'You are a helpful assistant.');

      expect(result.systemPromptTokens).toBeGreaterThan(0);
      expect(result.messageTokens).toBeGreaterThan(0);
      expect(result.totalTokens).toBe(result.systemPromptTokens + result.messageTokens);
    });

    it('should return 0 message tokens for empty session', () => {
      const session = createSession([]);
      const result = counter.countSessionTokens(session, 'System prompt');

      expect(result.messageTokens).toBe(0);
      expect(result.totalTokens).toBe(result.systemPromptTokens);
    });
  });

  describe('getContextWindow', () => {
    const models = [
      { id: 'claude-opus-4-5', name: 'Claude Opus', contextWindow: 200000 },
      { id: 'claude-sonnet', name: 'Claude Sonnet', contextWindow: 200000 },
    ];

    it('should return model context window when available', () => {
      expect(counter.getContextWindow('claude-opus-4-5', models as any)).toBe(200000);
    });

    it('should return default when model not found', () => {
      expect(counter.getContextWindow('unknown-model', models as any)).toBe(200000);
    });

    it('should return default when models array is undefined', () => {
      expect(counter.getContextWindow('claude-sonnet', undefined)).toBe(200000);
    });
  });

  describe('countToolSchemaTokens', () => {
    type ToolProperty = { type: string; description: string };

    function createTool(name: string, description: string, properties: Record<string, ToolProperty> = {}) {
      return {
        toolFn: async () => 'result',
        toolSchema: { name, description, parameters: { type: 'object' as const, properties } },
      };
    }

    it('should count tokens for tool schemas', () => {
      const tools = [
        createTool('weather', 'Get current weather for a location', {
          location: { type: 'string', description: 'City name or coordinates' },
        }),
      ];

      const tokens = counter.countToolSchemaTokens(tools);

      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(200);
    });

    it('should return 0 for empty tools array', () => {
      expect(counter.countToolSchemaTokens([])).toBe(0);
    });

    it('should count more tokens for multiple tools', () => {
      const singleTool = [createTool('tool1', 'First tool')];
      const multipleTools = [
        ...singleTool,
        createTool('tool2', 'Second tool with more parameters', {
          param1: { type: 'string', description: 'Parameter 1' },
          param2: { type: 'number', description: 'Parameter 2' },
        }),
      ];

      expect(counter.countToolSchemaTokens(multipleTools)).toBeGreaterThan(counter.countToolSchemaTokens(singleTool));
    });
  });

  describe('forModel (calibrated view)', () => {
    const TEXT = 'hello world, this is a token counting test';

    it('scales counts for a Claude model by its multiplier', () => {
      const raw = counter.countTokens(TEXT);

      expect(counter.forModel('claude-sonnet-5').countTokens(TEXT)).toBe(Math.ceil((raw * 150) / 100));
      expect(counter.forModel('claude-opus-4-6').countTokens(TEXT)).toBe(Math.ceil((raw * 109) / 100));
    });

    it('returns the raw count for non-Claude and versionless models', () => {
      const raw = counter.countTokens(TEXT);

      expect(counter.forModel('gpt-4o').countTokens(TEXT)).toBe(raw);
      expect(counter.forModel(undefined).countTokens(TEXT)).toBe(raw);
      // No version -> tokenEstimateMultiplier returns 1.
      expect(counter.forModel('claude-sonnet').countTokens(TEXT)).toBe(raw);
    });

    it('returns the counter itself when nothing needs scaling', () => {
      expect(counter.forModel('gpt-4o')).toBe(counter);
      expect(counter.forModel(undefined)).toBe(counter);
    });

    it('leaves the flat image estimate unscaled on a calibrated view', () => {
      const image = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }];

      expect(counter.countMessageContent(image as never)).toBe(1_600);
      expect(counter.forModel('claude-sonnet-5').countMessageContent(image as never)).toBe(1_600);
    });

    it('disposing the view does not free the shared encoder', () => {
      const view = counter.forModel('claude-sonnet-5');
      view.dispose();

      expect(counter.countTokens('still countable')).toBeGreaterThan(0);
    });
  });

  describe('getTokenCounter singleton', () => {
    it('should return the same instance', () => {
      const counter1 = getTokenCounter();
      const counter2 = getTokenCounter();

      expect(counter1).toBe(counter2);
    });
  });
});
