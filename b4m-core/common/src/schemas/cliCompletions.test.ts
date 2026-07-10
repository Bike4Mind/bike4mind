/**
 * Schema-validation tests for the /api/ai/v1/completions request shape.
 * Covers response_format, typed tools[], and per-message cache flag.
 */

import { describe, it, expect } from 'vitest';
import {
  CompletionRequestSchema,
  CompletionToolSchema,
  ResponseFormatSchema,
  normalizeCompletionRequest,
} from './cliCompletions';

describe('ResponseFormatSchema', () => {
  it('accepts text mode', () => {
    expect(ResponseFormatSchema.parse({ type: 'text' })).toEqual({ type: 'text' });
  });

  it('accepts json_schema with name + schema, defaults strict to true', () => {
    const parsed = ResponseFormatSchema.parse({
      type: 'json_schema',
      json_schema: { name: 'foo', schema: { type: 'object' } },
    });
    expect(parsed).toEqual({
      type: 'json_schema',
      json_schema: { name: 'foo', schema: { type: 'object' }, strict: true },
    });
  });

  it('rejects unknown response_format types', () => {
    expect(() => ResponseFormatSchema.parse({ type: 'xml' })).toThrow();
  });

  it('rejects json_schema without name', () => {
    expect(() =>
      ResponseFormatSchema.parse({
        type: 'json_schema',
        json_schema: { schema: { type: 'object' } },
      })
    ).toThrow();
  });
});

describe('CompletionToolSchema', () => {
  it('accepts a typed tool', () => {
    expect(
      CompletionToolSchema.parse({
        toolSchema: {
          name: 'add',
          description: 'Add two numbers',
          parameters: {
            type: 'object',
            properties: { a: { type: 'number' }, b: { type: 'number' } },
            required: ['a', 'b'],
          },
        },
      })
    ).toMatchObject({ toolSchema: { name: 'add' } });
  });

  it('rejects a tool with missing name', () => {
    expect(() =>
      CompletionToolSchema.parse({
        toolSchema: { description: 'broken', parameters: { type: 'object' } },
      })
    ).toThrow();
  });

  it('rejects a tool with non-object parameters', () => {
    expect(() =>
      CompletionToolSchema.parse({
        toolSchema: { name: 'add', description: '', parameters: { type: 'string' } },
      })
    ).toThrow();
  });
});

describe('CompletionRequestSchema', () => {
  it('parses a minimal request', () => {
    const out = CompletionRequestSchema.parse({
      model: 'claude-sonnet-4-5-20250929',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.model).toBe('claude-sonnet-4-5-20250929');
    expect(out.messages).toHaveLength(1);
  });

  it('parses a request with response_format and cache flags', () => {
    const out = CompletionRequestSchema.parse({
      model: 'claude-sonnet-4-5-20250929',
      messages: [
        { role: 'user', content: 'big system block', cache: true },
        { role: 'user', content: 'follow up' },
      ],
      options: {
        stream: true,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'extract', schema: { type: 'object' } },
        },
      },
    });
    expect(out.messages[0].cache).toBe(true);
    expect(out.options?.response_format?.type).toBe('json_schema');
  });

  it('rejects malformed tools[] (caught at schema layer instead of runtime)', () => {
    expect(() =>
      CompletionRequestSchema.parse({
        model: 'claude-sonnet-4-5-20250929',
        messages: [{ role: 'user', content: 'hi' }],
        // Missing parameters object - would have passed through z.array(z.any())
        // before tools were typed.
        options: { tools: [{ toolSchema: { name: 'broken' } }] },
      })
    ).toThrow();
  });

  it('accepts requests without options for backwards compatibility', () => {
    const out = CompletionRequestSchema.parse({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.options).toBeUndefined();
  });

  // k2kanji and other OpenAI-shape consumers send response_format
  // at the top level. The schema must accept both surfaces; the handler then
  // collapses them via normalizeCompletionRequest().
  it('accepts top-level response_format (OpenAI-compatible shape)', () => {
    const out = CompletionRequestSchema.parse({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'extract', schema: { type: 'object' } },
      },
    });
    expect(out.response_format?.type).toBe('json_schema');
  });

  // OpenAI-shape consumers write stream/tools/temperature/max_tokens at the top level too;
  // the schema must accept all of them there, not just response_format.
  it('accepts stream, tools, temperature, and max_tokens at the top level', () => {
    const out = CompletionRequestSchema.parse({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      temperature: 0.2,
      max_tokens: 512,
      tools: [
        {
          toolSchema: {
            name: 'add',
            description: 'Add two numbers',
            parameters: { type: 'object', properties: { a: { type: 'number' } } },
          },
        },
      ],
    });
    expect(out.stream).toBe(false);
    expect(out.temperature).toBe(0.2);
    expect(out.max_tokens).toBe(512);
    expect(out.tools).toHaveLength(1);
  });
});

describe('normalizeCompletionRequest', () => {
  it('hoists top-level response_format into options.response_format', () => {
    const parsed = CompletionRequestSchema.parse({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'extract', schema: { type: 'object' } },
      },
    });
    const normalized = normalizeCompletionRequest(parsed);
    expect(normalized.response_format).toBeUndefined();
    expect(normalized.options?.response_format?.type).toBe('json_schema');
    expect(normalized.options?.response_format?.json_schema?.name).toBe('extract');
  });

  it('leaves nested options.response_format untouched', () => {
    const parsed = CompletionRequestSchema.parse({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }],
      options: {
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'extract', schema: { type: 'object' } },
        },
      },
    });
    const normalized = normalizeCompletionRequest(parsed);
    expect(normalized.options?.response_format?.json_schema?.name).toBe('extract');
  });

  it('top-level wins when both surfaces are populated (OpenAI spec parity)', () => {
    const parsed = CompletionRequestSchema.parse({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'top_level_wins', schema: { type: 'object' } },
      },
      options: {
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'nested_loses', schema: { type: 'object' } },
        },
      },
    });
    const normalized = normalizeCompletionRequest(parsed);
    expect(normalized.options?.response_format?.json_schema?.name).toBe('top_level_wins');
  });

  it('is a no-op when no response_format is present', () => {
    const parsed = CompletionRequestSchema.parse({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const normalized = normalizeCompletionRequest(parsed);
    expect(normalized.options).toBeUndefined();
    expect(normalized.response_format).toBeUndefined();
  });

  it('hoists top-level stream into options.stream (false is not mistaken for absent)', () => {
    const parsed = CompletionRequestSchema.parse({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    const normalized = normalizeCompletionRequest(parsed);
    expect(normalized.stream).toBeUndefined();
    expect(normalized.options?.stream).toBe(false);
  });

  it('hoists top-level tools into options.tools', () => {
    const parsed = CompletionRequestSchema.parse({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          toolSchema: {
            name: 'add',
            description: 'Add two numbers',
            parameters: { type: 'object', properties: { a: { type: 'number' } } },
          },
        },
      ],
    });
    const normalized = normalizeCompletionRequest(parsed);
    expect(normalized.tools).toBeUndefined();
    expect(normalized.options?.tools).toHaveLength(1);
    expect(normalized.options?.tools?.[0].toolSchema.name).toBe('add');
  });

  it('hoists top-level temperature into options.temperature', () => {
    const parsed = CompletionRequestSchema.parse({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
    });
    const normalized = normalizeCompletionRequest(parsed);
    expect(normalized.temperature).toBeUndefined();
    expect(normalized.options?.temperature).toBe(0.7);
  });

  it('hoists top-level max_tokens into options.maxTokens (OpenAI naming alias)', () => {
    const parsed = CompletionRequestSchema.parse({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1024,
    });
    const normalized = normalizeCompletionRequest(parsed);
    expect(normalized.max_tokens).toBeUndefined();
    expect(normalized.options?.maxTokens).toBe(1024);
  });

  it('leaves nested options.maxTokens untouched when no top-level max_tokens is sent', () => {
    const parsed = CompletionRequestSchema.parse({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }],
      options: { maxTokens: 256 },
    });
    const normalized = normalizeCompletionRequest(parsed);
    expect(normalized.options?.maxTokens).toBe(256);
  });

  it('top-level max_tokens wins over nested options.maxTokens', () => {
    const parsed = CompletionRequestSchema.parse({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1024,
      options: { maxTokens: 256 },
    });
    const normalized = normalizeCompletionRequest(parsed);
    expect(normalized.options?.maxTokens).toBe(1024);
  });

  it('top-level stream/temperature win over nested options when both are populated', () => {
    const parsed = CompletionRequestSchema.parse({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      temperature: 0.9,
      options: { stream: false, temperature: 0.1 },
    });
    const normalized = normalizeCompletionRequest(parsed);
    expect(normalized.options?.stream).toBe(true);
    expect(normalized.options?.temperature).toBe(0.9);
  });

  it('normalizes all five top-level fields at once, preserving unrelated nested options', () => {
    const parsed = CompletionRequestSchema.parse({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      temperature: 0.5,
      max_tokens: 2048,
      response_format: { type: 'text' },
      tools: [
        {
          toolSchema: {
            name: 'lookup',
            description: 'Look something up',
            parameters: { type: 'object' },
          },
        },
      ],
    });
    const normalized = normalizeCompletionRequest(parsed);
    expect(normalized.stream).toBeUndefined();
    expect(normalized.temperature).toBeUndefined();
    expect(normalized.max_tokens).toBeUndefined();
    expect(normalized.response_format).toBeUndefined();
    expect(normalized.tools).toBeUndefined();
    expect(normalized.options).toMatchObject({
      stream: true,
      temperature: 0.5,
      maxTokens: 2048,
      response_format: { type: 'text' },
    });
    expect(normalized.options?.tools?.[0].toolSchema.name).toBe('lookup');
  });
});
