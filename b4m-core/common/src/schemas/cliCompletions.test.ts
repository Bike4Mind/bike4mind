/**
 * Schema-validation tests for the /api/ai/v1/completions request shape.
 * Covers response_format, typed tools[], and per-message cache flag.
 */

import { describe, it, expect } from 'vitest';
import {
  COMPLETION_SSE_ERROR_CODES,
  CompletionRequestSchema,
  CompletionSseErrorEventSchema,
  CompletionStreamEventSchema,
  CompletionToolSchema,
  isCompletionServerTool,
  isToolChangeBlockType,
  isToolChangeMessage,
  ToolChangeBlockSchema,
  ToolChangeMessageContentSchema,
  ResponseFormatSchema,
  normalizeCompletionRequest,
} from './cliCompletions';
import { QUEST_ERROR_CODES } from '../types/entities/SessionTypes';

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

describe('CompletionToolSchema tool search', () => {
  const customTool = {
    toolSchema: { name: 'get_weather', description: 'Weather', parameters: { type: 'object' } },
  };

  it('keeps defer_loading and cache_control on a custom tool', () => {
    const parsed = CompletionToolSchema.parse({
      toolSchema: { ...customTool.toolSchema, defer_loading: true, cache_control: { type: 'ephemeral' } },
    });
    expect(parsed).toEqual({
      toolSchema: { ...customTool.toolSchema, defer_loading: true, cache_control: { type: 'ephemeral' } },
    });
    expect(isCompletionServerTool(parsed)).toBe(false);
  });

  it('parses a plain custom tool to the same shape as before', () => {
    expect(CompletionToolSchema.parse(customTool)).toEqual(customTool);
  });

  it.each([
    ['tool_search_tool_regex_20251119', 'tool_search_tool_regex'],
    ['tool_search_tool_bm25_20251119', 'tool_search_tool_bm25'],
  ])('accepts the %s server tool', (type, name) => {
    const parsed = CompletionToolSchema.parse({ serverTool: { type, name } });
    expect(parsed).toEqual({ serverTool: { type, name } });
    expect(isCompletionServerTool(parsed)).toBe(true);
  });

  it.each([
    ['an unknown server tool type', { type: 'web_search_20260209', name: 'web_search' }],
    ['a name that does not match the type', { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_bm25' }],
    ['a missing name', { type: 'tool_search_tool_bm25_20251119' }],
  ])('rejects %s', (_label, serverTool) => {
    expect(CompletionToolSchema.safeParse({ serverTool }).success).toBe(false);
  });

  it('rejects a non-boolean defer_loading', () => {
    expect(
      CompletionToolSchema.safeParse({ toolSchema: { ...customTool.toolSchema, defer_loading: 'yes' } }).success
    ).toBe(false);
  });

  it('accepts a mixed tools[] in the request body', () => {
    const out = CompletionRequestSchema.parse({
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { toolSchema: { ...customTool.toolSchema, defer_loading: true } },
        { serverTool: { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' } },
      ],
    });
    expect(out.tools).toHaveLength(2);
  });
});

describe('CompletionStreamEventSchema provider_block', () => {
  const block = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_regex', input: { query: 'x' } };

  it('accepts a provider_block frame', () => {
    expect(CompletionStreamEventSchema.parse({ type: 'provider_block', provider: 'anthropic', block })).toEqual({
      type: 'provider_block',
      provider: 'anthropic',
      block,
    });
  });

  it('rejects a provider_block frame from an unknown provider or without a block', () => {
    expect(CompletionStreamEventSchema.safeParse({ type: 'provider_block', provider: 'openai', block }).success).toBe(
      false
    );
    expect(CompletionStreamEventSchema.safeParse({ type: 'provider_block', provider: 'anthropic' }).success).toBe(
      false
    );
  });
});

describe('CompletionRequestSchema', () => {
  it('rejects an empty messages array', () => {
    const result = CompletionRequestSchema.safeParse({ model: 'claude-sonnet-4-5-20250929', messages: [] });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ code: 'too_small', path: ['messages'], minimum: 1 }),
    ]);
  });

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

describe('CompletionRequestSchema model length', () => {
  const messages = [{ role: 'user', content: 'hi' }];

  it('accepts a model id of exactly 256 characters', () => {
    expect(CompletionRequestSchema.safeParse({ model: 'm'.repeat(256), messages }).success).toBe(true);
  });

  it('rejects a model id over 256 characters on the model field', () => {
    const result = CompletionRequestSchema.safeParse({ model: 'm'.repeat(257), messages });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map(i => i.path)).toEqual([['model']]);
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

  // Locks in the fix from the destructuring rewrite: a field that was never sent must stay
  // absent from the result, not become an explicit `undefined` own-property (the latter would
  // make e.g. `'tools' in normalized` true for a request that never sent tools).
  it('does not add own-keys for fields that were never sent', () => {
    const parsed = CompletionRequestSchema.parse({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const normalized = normalizeCompletionRequest(parsed);
    expect(Object.keys(normalized)).toEqual(['model', 'messages', 'options']);
    expect(Object.hasOwn(normalized, 'tools')).toBe(false);
    expect(Object.hasOwn(normalized, 'temperature')).toBe(false);
    expect(Object.hasOwn(normalized, 'max_tokens')).toBe(false);
    expect(Object.hasOwn(normalized, 'response_format')).toBe(false);
  });

  it('hoists temperature: 0 and max_tokens: 0 (falsy-but-defined, not mistaken for absent)', () => {
    const parsed = CompletionRequestSchema.parse({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
      max_tokens: 0,
    });
    const normalized = normalizeCompletionRequest(parsed);
    expect(normalized.options?.temperature).toBe(0);
    expect(normalized.options?.maxTokens).toBe(0);
  });
});

describe('CompletionRequestSchema options.reasoningEffort', () => {
  const base = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

  it('keeps reasoningEffort on options', () => {
    const parsed = CompletionRequestSchema.parse({ ...base, options: { reasoningEffort: 'low' } });
    expect(parsed.options?.reasoningEffort).toBe('low');
  });

  it('leaves reasoningEffort absent when not sent', () => {
    const parsed = CompletionRequestSchema.parse({ ...base, options: { temperature: 0.2 } });
    expect(parsed.options).not.toHaveProperty('reasoningEffort');
  });

  it('rejects an unknown effort value', () => {
    expect(() => CompletionRequestSchema.parse({ ...base, options: { reasoningEffort: 'turbo' } })).toThrow();
  });
});

describe('CompletionRequestSchema options.thinking', () => {
  const base = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

  // Zod strips unknown keys, so before this field existed the option vanished here and a
  // Claude turn never reached the adapter branch that applies reasoningEffort.
  it('keeps thinking on options', () => {
    const parsed = CompletionRequestSchema.parse({ ...base, options: { thinking: { enabled: true } } });
    expect(parsed.options?.thinking).toEqual({ enabled: true });
  });

  it('rejects a budget below the API minimum of 1024', () => {
    expect(() =>
      CompletionRequestSchema.parse({ ...base, options: { thinking: { enabled: true, budget_tokens: 1023 } } })
    ).toThrow();
    expect(
      CompletionRequestSchema.parse({ ...base, options: { thinking: { enabled: true, budget_tokens: 1024 } } }).options
        ?.thinking
    ).toEqual({ enabled: true, budget_tokens: 1024 });
  });
});

describe('CompletionSseErrorEventSchema', () => {
  it('accepts the provider classifiers alongside the billing ones', () => {
    for (const code of [
      'insufficient_credits',
      'spend_cap_exceeded',
      'invalid_request',
      'provider_error',
      'provider_rejected',
      'content_blocked',
    ]) {
      expect(CompletionSseErrorEventSchema.safeParse({ type: 'error', message: 'm', code }).success).toBe(true);
    }
  });

  it('rejects a code outside the frame vocabulary', () => {
    const frame = { type: 'error', message: 'm', code: 'provider_not_configured' };
    expect(CompletionSseErrorEventSchema.safeParse(frame).success).toBe(false);
  });

  // QUEST_ERROR_CODES is persisted on quests; the frame widens its own copy instead.
  it('leaves the persisted quest vocabulary unwidened', () => {
    expect([...QUEST_ERROR_CODES]).toEqual(['insufficient_credits', 'spend_cap_exceeded']);
    expect([...COMPLETION_SSE_ERROR_CODES]).toEqual([
      ...QUEST_ERROR_CODES,
      'invalid_request',
      'provider_error',
      'provider_rejected',
      'content_blocked',
      'output_budget_exhausted',
    ]);
  });
});

describe('CompletionRequestSchema thinking budget', () => {
  it('rejects a thinking budget past MAX_THINKING_BUDGET_TOKENS', () => {
    const parsed = CompletionRequestSchema.safeParse({
      model: 'claude',
      messages: [{ role: 'user', content: 'hi' }],
      options: { thinking: { enabled: true, budget_tokens: 10_000_000 } },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('ToolChangeBlockSchema', () => {
  const ref = { type: 'tool_reference', name: 'get_weather' };

  it('accepts a tool_addition and a tool_removal naming a tool', () => {
    expect(ToolChangeBlockSchema.safeParse({ type: 'tool_addition', tool: ref }).success).toBe(true);
    expect(ToolChangeBlockSchema.safeParse({ type: 'tool_removal', tool: ref }).success).toBe(true);
  });

  it.each([
    ['an inline definition', { type: 'tool_addition', tool: { ...ref, description: 'x', input_schema: {} } }],
    ['an MCP reference', { type: 'tool_addition', tool: { type: 'mcp_tool_reference', name: 'get_weather' } }],
    ['an empty name', { type: 'tool_addition', tool: { type: 'tool_reference', name: '' } }],
    ['the tool_search tool_name spelling', { type: 'tool_addition', tool: { type: 'tool_reference', tool_name: 'a' } }],
    ['an unknown block type', { type: 'tool_swap', tool: ref }],
    ['an extra block key', { type: 'tool_addition', tool: ref, cache_control: { type: 'ephemeral' } }],
  ])('rejects %s', (_label, block) => {
    expect(ToolChangeBlockSchema.safeParse(block).success).toBe(false);
  });

  it('requires a non-empty array of blocks for a message', () => {
    expect(ToolChangeMessageContentSchema.safeParse([]).success).toBe(false);
    expect(ToolChangeMessageContentSchema.safeParse([{ type: 'text', text: 'hi' }]).success).toBe(false);
    expect(ToolChangeMessageContentSchema.safeParse([{ type: 'tool_removal', tool: ref }]).success).toBe(true);
  });

  it('recognises a tool change block by type alone', () => {
    expect(isToolChangeBlockType({ type: 'tool_addition' })).toBe(true);
    expect(isToolChangeBlockType({ type: 'text' })).toBe(false);
    expect(isToolChangeBlockType(null)).toBe(false);
    expect(isToolChangeBlockType('tool_addition')).toBe(false);
  });
});

describe('isToolChangeMessage', () => {
  const content = [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'get_weather' } }];

  it('is true only for a system message holding tool change blocks', () => {
    expect(isToolChangeMessage({ role: 'system', content })).toBe(true);
    expect(isToolChangeMessage({ role: 'user', content })).toBe(false);
    expect(isToolChangeMessage({ role: 'system', content: 'be brief' })).toBe(false);
    expect(isToolChangeMessage({ role: 'system', content: [{ type: 'text', text: 'be brief' }] })).toBe(false);
  });
});
