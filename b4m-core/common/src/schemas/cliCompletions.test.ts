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
});
