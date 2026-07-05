import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  describe('getTokenCounter singleton', () => {
    it('should return the same instance', () => {
      const counter1 = getTokenCounter();
      const counter2 = getTokenCounter();

      expect(counter1).toBe(counter2);
    });
  });
});
