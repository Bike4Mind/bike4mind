import { describe, it, expect, vi } from 'vitest';
import { SmallLLMService, createSmallLLMService } from './SmallLLMService';
import { extractJSON } from './smallLLMHelpers';
import { z } from 'zod';
import type { SmallLLMAdapters } from '@bike4mind/common';

function createMockAdapters(responseText: string): SmallLLMAdapters {
  return {
    modelId: 'test-model',
    llm: {
      complete: vi.fn(async (_model, _messages, _options, callback) => {
        await callback([responseText], { inputTokens: 10, outputTokens: 5 });
      }),
    },
  };
}

function createFailingAdapters(error: Error): SmallLLMAdapters {
  return {
    modelId: 'test-model',
    llm: {
      complete: vi.fn(async () => {
        throw error;
      }),
    },
  };
}

function createSlowAdapters(delayMs: number, responseText: string): SmallLLMAdapters {
  return {
    modelId: 'test-model',
    llm: {
      complete: vi.fn(async (_model, _messages, _options, callback) => {
        await new Promise(resolve => setTimeout(resolve, delayMs));
        await callback([responseText], {});
      }),
    },
  };
}

describe('extractJSON', () => {
  it('extracts raw JSON object', () => {
    expect(extractJSON('{"key": "value"}')).toBe('{"key": "value"}');
  });

  it('extracts raw JSON array', () => {
    expect(extractJSON('[1, 2, 3]')).toBe('[1, 2, 3]');
  });

  it('extracts JSON from markdown code block', () => {
    const input = '```json\n{"key": "value"}\n```';
    expect(extractJSON(input)).toBe('{"key": "value"}');
  });

  it('extracts JSON from code block without language tag', () => {
    const input = '```\n{"key": "value"}\n```';
    expect(extractJSON(input)).toBe('{"key": "value"}');
  });

  it('extracts JSON embedded in text', () => {
    const input = 'Here is the result: {"score": 8, "reason": "good"} and that is all.';
    expect(extractJSON(input)).toBe('{"score": 8, "reason": "good"}');
  });

  it('extracts JSON array embedded in text', () => {
    const input = 'Results: [{"id": "a", "score": 5}]';
    expect(extractJSON(input)).toBe('[{"id": "a", "score": 5}]');
  });

  it('returns null for no JSON', () => {
    expect(extractJSON('just plain text')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(extractJSON('{not valid json}')).toBeNull();
  });

  it('handles whitespace around JSON', () => {
    expect(extractJSON('  \n  {"key": "value"}  \n  ')).toBe('{"key": "value"}');
  });
});

describe('SmallLLMService', () => {
  describe('complete()', () => {
    it('returns accumulated text from backend', async () => {
      const adapters = createMockAdapters('Hello world');
      const service = new SmallLLMService(adapters);

      const result = await service.complete('Say hello');

      expect(result.data).toBe('Hello world');
      expect(result.metrics.modelId).toBe('test-model');
      expect(result.metrics.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.metrics.inputTokens).toBe(10);
      expect(result.metrics.outputTokens).toBe(5);
    });

    it('passes system prompt and user prompt as messages', async () => {
      const adapters = createMockAdapters('response');
      const service = new SmallLLMService(adapters);

      await service.complete('user input', { systemPrompt: 'Be helpful' });

      expect(adapters.llm.complete).toHaveBeenCalledWith(
        'test-model',
        [
          { role: 'system', content: 'Be helpful' },
          { role: 'user', content: 'user input' },
        ],
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('uses default temperature 0.7 for generation tasks', async () => {
      const adapters = createMockAdapters('response');
      const service = new SmallLLMService(adapters);

      await service.complete('prompt', { taskType: 'generation' });

      expect(adapters.llm.complete).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ temperature: 0.7 }),
        expect.any(Function)
      );
    });

    it('uses temperature 0 for classification tasks', async () => {
      const adapters = createMockAdapters('response');
      const service = new SmallLLMService(adapters);

      await service.complete('prompt', { taskType: 'classification' });

      expect(adapters.llm.complete).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ temperature: 0 }),
        expect.any(Function)
      );
    });

    it('retries on failure and succeeds on second attempt', async () => {
      let callCount = 0;
      const adapters: SmallLLMAdapters = {
        modelId: 'test-model',
        llm: {
          complete: vi.fn(async (_model, _messages, _options, callback) => {
            callCount++;
            if (callCount === 1) throw new Error('First attempt failed');
            await callback(['success'], {});
          }),
        },
      };
      const service = new SmallLLMService(adapters);

      const result = await service.complete('prompt', { retries: 1 });

      expect(result.data).toBe('success');
      expect(result.metrics.retried).toBe(true);
      expect(callCount).toBe(2);
    });

    it('throws after all retries exhausted', async () => {
      const adapters = createFailingAdapters(new Error('Always fails'));
      const service = new SmallLLMService(adapters);

      await expect(service.complete('prompt', { retries: 2 })).rejects.toThrow('Always fails');
    });

    it('throws on empty response', async () => {
      const adapters = createMockAdapters('');
      const service = new SmallLLMService(adapters);

      await expect(service.complete('prompt', { retries: 0 })).rejects.toThrow('empty response');
    });

    it('times out if backend is too slow', async () => {
      const adapters = createSlowAdapters(5000, 'response');
      const service = new SmallLLMService(adapters);

      await expect(service.complete('prompt', { timeoutMs: 50, retries: 0 })).rejects.toThrow('timeout');
    });

    it('accumulates multiple chunks', async () => {
      const adapters: SmallLLMAdapters = {
        modelId: 'test-model',
        llm: {
          complete: vi.fn(async (_model, _messages, _options, callback) => {
            await callback(['Hello', ' ', 'world'], {});
          }),
        },
      };
      const service = new SmallLLMService(adapters);

      const result = await service.complete('prompt');
      expect(result.data).toBe('Hello world');
    });

    it('filters null/undefined chunks', async () => {
      const adapters: SmallLLMAdapters = {
        modelId: 'test-model',
        llm: {
          complete: vi.fn(async (_model, _messages, _options, callback) => {
            await callback(['Hello', null, undefined, ' world'], {});
          }),
        },
      };
      const service = new SmallLLMService(adapters);

      const result = await service.complete('prompt');
      expect(result.data).toBe('Hello world');
    });
  });

  describe('completeJSON()', () => {
    it('parses and validates JSON response', async () => {
      const adapters = createMockAdapters('{"name": "test", "value": 42}');
      const service = new SmallLLMService(adapters);

      const schema = z.object({ name: z.string(), value: z.number() });
      const result = await service.completeJSON('extract data', schema);

      expect(result.data).toEqual({ name: 'test', value: 42 });
    });

    it('extracts JSON from markdown-wrapped response', async () => {
      const adapters = createMockAdapters('```json\n{"score": 8}\n```');
      const service = new SmallLLMService(adapters);

      const schema = z.object({ score: z.number() });
      const result = await service.completeJSON('score this', schema);

      expect(result.data).toEqual({ score: 8 });
    });

    it('extracts JSON embedded in prose', async () => {
      const adapters = createMockAdapters('Here is the analysis: {"category": "technical"} as requested.');
      const service = new SmallLLMService(adapters);

      const schema = z.object({ category: z.string() });
      const result = await service.completeJSON('classify', schema);

      expect(result.data).toEqual({ category: 'technical' });
    });

    it('returns fallback on parse failure', async () => {
      const adapters = createMockAdapters('not valid json at all');
      const service = new SmallLLMService(adapters);
      const onFallback = vi.fn();

      const schema = z.object({ score: z.number() });
      const result = await service.completeJSON(
        'score',
        schema,
        { retries: 0 },
        {
          value: { score: 0 },
          onFallback,
        }
      );

      expect(result.data).toEqual({ score: 0 });
      expect(onFallback).toHaveBeenCalled();
    });

    it('returns fallback on Zod validation failure', async () => {
      const adapters = createMockAdapters('{"score": "not a number"}');
      const service = new SmallLLMService(adapters);

      const schema = z.object({ score: z.number() });
      const result = await service.completeJSON(
        'score',
        schema,
        { retries: 0 },
        {
          value: { score: -1 },
        }
      );

      expect(result.data).toEqual({ score: -1 });
    });

    it('throws when no fallback and validation fails', async () => {
      const adapters = createMockAdapters('not json');
      const service = new SmallLLMService(adapters);

      const schema = z.object({ score: z.number() });
      await expect(service.completeJSON('score', schema, { retries: 0 })).rejects.toThrow();
    });

    it('uses temperature 0 by default for JSON tasks', async () => {
      const adapters = createMockAdapters('{"ok": true}');
      const service = new SmallLLMService(adapters);

      const schema = z.object({ ok: z.boolean() });
      await service.completeJSON('test', schema);

      expect(adapters.llm.complete).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ temperature: 0 }),
        expect.any(Function)
      );
    });
  });

  describe('classify()', () => {
    it('returns a valid category', async () => {
      const adapters = createMockAdapters('{"category": "technical", "confidence": 0.9}');
      const service = new SmallLLMService(adapters);

      const result = await service.classify('How do I implement a binary search?', [
        'technical',
        'creative',
        'business',
      ] as const);

      expect(result.data).toBe('technical');
    });

    it('includes context in the prompt', async () => {
      const adapters = createMockAdapters('{"category": "bug", "confidence": 0.8}');
      const service = new SmallLLMService(adapters);

      await service.classify('fix the login', ['bug', 'feature', 'question'] as const, 'This is a support ticket');

      const callArgs = (adapters.llm.complete as ReturnType<typeof vi.fn>).mock.calls[0];
      const userMsg = callArgs[1].find((m: { role: string }) => m.role === 'user');
      expect(userMsg.content).toContain('This is a support ticket');
    });
  });

  describe('score()', () => {
    it('returns score and reason', async () => {
      const adapters = createMockAdapters('{"score": 7, "reason": "Good quality"}');
      const service = new SmallLLMService(adapters);

      const result = await service.score('This is a test input', 'Rate the quality');

      expect(result.data.score).toBe(7);
      expect(result.data.reason).toBe('Good quality');
    });

    it('uses custom scale', async () => {
      const adapters = createMockAdapters('{"score": 3, "reason": "Average"}');
      const service = new SmallLLMService(adapters);

      const result = await service.score('input', 'Rate it', [1, 5]);

      expect(result.data.score).toBe(3);
    });
  });

  describe('scoreBatch()', () => {
    it('scores multiple items in one call', async () => {
      const response = JSON.stringify([
        { id: 'a', score: 8, reason: 'Very relevant' },
        { id: 'b', score: 3, reason: 'Barely related' },
      ]);
      const adapters = createMockAdapters(response);
      const service = new SmallLLMService(adapters);

      const result = await service.scoreBatch(
        'machine learning',
        [
          { id: 'a', text: 'Neural networks and deep learning' },
          { id: 'b', text: 'Making a tuna sandwich' },
        ],
        'How relevant is this to the query?'
      );

      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toEqual({ id: 'a', score: 8, reason: 'Very relevant' });
      expect(result.data[1]).toEqual({ id: 'b', score: 3, reason: 'Barely related' });
    });

    it('returns empty array for empty items', async () => {
      const adapters = createMockAdapters('[]');
      const service = new SmallLLMService(adapters);

      const result = await service.scoreBatch('query', [], 'criteria');

      expect(result.data).toEqual([]);
      expect(adapters.llm.complete).not.toHaveBeenCalled();
    });

    it('makes exactly one LLM call for multiple items', async () => {
      const response = JSON.stringify([
        { id: 'a', score: 5, reason: 'ok' },
        { id: 'b', score: 6, reason: 'fine' },
        { id: 'c', score: 7, reason: 'good' },
      ]);
      const adapters = createMockAdapters(response);
      const service = new SmallLLMService(adapters);

      await service.scoreBatch(
        'query',
        [
          { id: 'a', text: 'text a' },
          { id: 'b', text: 'text b' },
          { id: 'c', text: 'text c' },
        ],
        'criteria'
      );

      expect(adapters.llm.complete).toHaveBeenCalledTimes(1);
    });
  });

  describe('createSmallLLMService()', () => {
    it('creates a functional SmallLLMService instance', async () => {
      const adapters = createMockAdapters('test response');
      const service = createSmallLLMService(adapters);

      const result = await service.complete('hello');
      expect(result.data).toBe('test response');
    });
  });
});
