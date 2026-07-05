/**
 * Tests for response_format and cache-token accounting wiring across
 * backends. Mirrors the SDK-mocking pattern from tokenAccumulation.test.ts.
 *
 * Coverage:
 *  - Anthropic: json_schema -> tool_use synthesis with forced tool_choice
 *  - Anthropic: per-message `cache: true` -> cache_control: ephemeral + beta header
 *  - Anthropic: cache_read_input_tokens / cache_creation_input_tokens forwarded to cb
 *  - OpenAI: json_schema -> native response_format passthrough
 *  - Bedrock/Gemini/xAI: best-effort JSON instruction injected; mode reported
 *  - getTextModelCost: applies 0.1x / 1.25x multipliers
 */

import { describe, it, expect } from 'vitest';
import { Stream } from 'openai/streaming';
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  ChatModels,
  type CompletionInfo,
  getTextModelCost,
  ModelBackend,
  type ModelInfo,
  type ResponseFormat,
} from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import { OpenAIBackend } from './openaiBackend';
import { GeminiBackend } from './geminiBackend';
import { XAIBackend } from './xaiBackend';
import {
  buildJsonSchemaInstruction,
  injectJsonSchemaInstruction,
  isBestEffortJsonSchema,
} from './responseFormatHelpers';

// ─── helpers ───────────────────────────────────────────────────────

interface CapturedCb {
  text: (string | null | undefined)[];
  info?: CompletionInfo;
}

function asyncIterable(events: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    controller: { abort: () => {} },
  };
}

function asOpenAIStream(events: unknown[]): Stream<unknown> {
  const s = asyncIterable(events);
  Object.setPrototypeOf(s, Stream.prototype);
  return s as unknown as Stream<unknown>;
}

function captureCb(): {
  calls: CapturedCb[];
  cb: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>;
} {
  const calls: CapturedCb[] = [];
  return {
    calls,
    cb: async (text, info) => {
      calls.push({ text, info });
    },
  };
}

const SAMPLE_SCHEMA: ResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'extract_user',
    description: 'Extract user info',
    schema: {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'integer' } },
      required: ['name'],
      additionalProperties: false,
    },
    strict: true,
  },
};

// ─── responseFormatHelpers ──────────────────────────────────────────

describe('responseFormatHelpers', () => {
  it('buildJsonSchemaInstruction returns null for text mode', () => {
    expect(buildJsonSchemaInstruction({ type: 'text' })).toBeNull();
  });

  it('buildJsonSchemaInstruction includes name, description, and schema', () => {
    const out = buildJsonSchemaInstruction(SAMPLE_SCHEMA)!;
    expect(out).toContain('extract_user');
    expect(out).toContain('Extract user info');
    expect(out).toContain('"name"');
    expect(out).toContain('"age"');
  });

  it('injectJsonSchemaInstruction prepends a system message', () => {
    const messages = [{ role: 'user', content: 'hi' } as const];
    const out = injectJsonSchemaInstruction(messages, SAMPLE_SCHEMA);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('system');
    expect(out[0].content).toContain('extract_user');
    expect(out[1]).toBe(messages[0]);
  });

  it('injectJsonSchemaInstruction is a no-op when responseFormat is undefined', () => {
    const messages = [{ role: 'user', content: 'hi' } as const];
    const out = injectJsonSchemaInstruction(messages, undefined);
    expect(out).toBe(messages);
  });

  it('isBestEffortJsonSchema is true only for json_schema', () => {
    expect(isBestEffortJsonSchema(SAMPLE_SCHEMA)).toBe(true);
    expect(isBestEffortJsonSchema({ type: 'text' })).toBe(false);
    expect(isBestEffortJsonSchema(undefined)).toBe(false);
  });
});

// ─── getTextModelCost cache multipliers ─────────────────────────────

describe('getTextModelCost cache accounting', () => {
  const model: ModelInfo = {
    id: ChatModels.CLAUDE_4_5_SONNET,
    type: 'text',
    name: 'test',
    backend: ModelBackend.Anthropic,
    contextWindow: 200_000,
    max_tokens: 8192,
    supportsImageVariation: false,
    pricing: {
      // input $3/M, output $15/M (Anthropic Sonnet)
      200_000: { input: 3 / 1_000_000, output: 15 / 1_000_000 },
    },
  };

  it('charges 0.1× input for cache_read tokens', () => {
    const justRead = getTextModelCost(model, 0, 0, 1_000, 0);
    const expected = (3 / 1_000_000) * CACHE_READ_MULTIPLIER * 1_000;
    expect(justRead).toBeCloseTo(expected, 12);
  });

  it('charges 1.25× input for cache_creation tokens', () => {
    const justWrite = getTextModelCost(model, 0, 0, 0, 1_000);
    const expected = (3 / 1_000_000) * CACHE_WRITE_MULTIPLIER * 1_000;
    expect(justWrite).toBeCloseTo(expected, 12);
  });

  it('sums input/output/cache_read/cache_creation', () => {
    const total = getTextModelCost(model, 1_000, 500, 2_000, 100);
    const expected =
      (3 / 1_000_000) * 1_000 +
      (15 / 1_000_000) * 500 +
      (3 / 1_000_000) * CACHE_READ_MULTIPLIER * 2_000 +
      (3 / 1_000_000) * CACHE_WRITE_MULTIPLIER * 100;
    expect(total).toBeCloseTo(expected, 12);
  });

  it('honors explicit cache_read / cache_write rates when provided', () => {
    const overrideModel: ModelInfo = {
      ...model,
      pricing: {
        200_000: {
          input: 3 / 1_000_000,
          output: 15 / 1_000_000,
          cache_read: 7 / 1_000_000,
          cache_write: 11 / 1_000_000,
        },
      },
    };
    const cost = getTextModelCost(overrideModel, 0, 0, 1_000, 1_000);
    const expected = (7 / 1_000_000) * 1_000 + (11 / 1_000_000) * 1_000;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it('is backwards compatible — no cache args gives same answer as before', () => {
    const before = getTextModelCost(model, 1_000, 500);
    const expected = (3 / 1_000_000) * 1_000 + (15 / 1_000_000) * 500;
    expect(before).toBeCloseTo(expected, 12);
  });
});

// ─── AnthropicBackend: response_format synthesis ─────────────────────

describe('AnthropicBackend response_format', () => {
  function buildBackend() {
    const backend = new AnthropicBackend('test-key');
    let lastApiParams: any = null;
    let mockEvents: unknown[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _api: any })._api = {
      messages: {
        create: async (params: unknown) => {
          lastApiParams = params;
          return asyncIterable(mockEvents);
        },
      },
    };
    return {
      backend,
      getApiParams: () => lastApiParams,
      setMockEvents: (e: unknown[]) => {
        mockEvents = e;
      },
    };
  }

  it('synthesizes a tool from json_schema and forces tool_choice', async () => {
    const { backend, getApiParams, setMockEvents } = buildBackend();
    setMockEvents([
      { type: 'message_start' },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'extract_user', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"name":"Erik","age":42}' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', usage: { input_tokens: 100, output_tokens: 20 } },
      { type: 'message_stop' },
    ]);

    const { calls, cb } = captureCb();
    await backend.complete(
      'claude-sonnet-4-5-20250929',
      [{ role: 'user', content: 'extract user' }],
      { stream: true, executeTools: false, responseFormat: SAMPLE_SCHEMA },
      cb
    );

    const apiParams = getApiParams();
    expect(apiParams.tools).toHaveLength(1);
    expect(apiParams.tools[0]).toMatchObject({ name: 'extract_user' });
    expect(apiParams.tools[0].input_schema).toEqual(SAMPLE_SCHEMA.json_schema.schema);
    expect(apiParams.tool_choice).toEqual({ type: 'tool', name: 'extract_user' });

    // Streamed text should contain the raw JSON
    const allText = calls.flatMap(c => c.text.filter((t): t is string => typeof t === 'string')).join('');
    expect(allText).toContain('"name":"Erik"');
    expect(allText).toContain('"age":42');

    // Terminal cb reports tool_use mode
    const last = calls[calls.length - 1];
    expect(last?.info?.responseFormatMode).toBe('tool_use');
  });

  it('does not synthesize a tool when caller already provided tools', async () => {
    const { backend, getApiParams, setMockEvents } = buildBackend();
    setMockEvents([
      { type: 'message_start' },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 } },
      { type: 'message_stop' },
    ]);

    const { cb } = captureCb();
    const callerTool = {
      toolSchema: {
        name: 'add',
        description: 'Add',
        parameters: { type: 'object' as const, properties: { a: { type: 'number', description: 'a' } } },
      },
      toolFn: async () => '0',
    };
    await backend.complete(
      'claude-sonnet-4-5-20250929',
      [{ role: 'user', content: 'hi' }],
      { stream: true, executeTools: false, tools: [callerTool], responseFormat: SAMPLE_SCHEMA },
      cb
    );

    const apiParams = getApiParams();
    // Caller's tool is the only one; no synthesized tool, no forced tool_choice
    expect(apiParams.tools).toHaveLength(1);
    expect(apiParams.tools[0].name).toBe('add');
    expect(apiParams.tool_choice).toBeUndefined();
  });
});

// ─── AnthropicBackend: per-message cache flag ────────────────────────

describe('AnthropicBackend cache: true', () => {
  function buildCacheTestBackend() {
    const backend = new AnthropicBackend('test-key');
    let lastApiParams: any = null;
    let lastRequestOptions: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _api: any })._api = {
      messages: {
        create: async (params: unknown, opts: unknown) => {
          lastApiParams = params;
          lastRequestOptions = opts;
          return asyncIterable([
            { type: 'message_start' },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 } },
            { type: 'message_stop' },
          ]);
        },
      },
    };
    return {
      backend,
      getApiParams: () => lastApiParams,
      getRequestOptions: () => lastRequestOptions,
    };
  }

  it('attaches cache_control to last block of a user message with cache: true', async () => {
    const { backend, getApiParams, getRequestOptions } = buildCacheTestBackend();

    const { cb } = captureCb();
    await backend.complete(
      'claude-sonnet-4-5-20250929',
      [
        { role: 'user', content: 'big context block', cache: true },
        { role: 'user', content: 'follow up' },
      ],
      { stream: true, executeTools: false },
      cb
    );

    const apiParams = getApiParams();
    const cachedMessage = apiParams.messages[0];
    // String content was normalized to a single-block array with cache_control
    expect(Array.isArray(cachedMessage.content)).toBe(true);
    const lastBlock = cachedMessage.content[cachedMessage.content.length - 1];
    expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' });

    // The "betas" body field is NOT set (it would be a no-op on the SDK).
    expect((apiParams as { betas?: unknown }).betas).toBeUndefined();
    // Header IS set on the request options - that's what the SDK actually forwards.
    const opts = getRequestOptions();
    expect(opts?.headers?.['anthropic-beta']).toBe('prompt-caching-2024-07-31');
  });

  it('attaches cache_control to a system message with cache: true (P1 #2)', async () => {
    const { backend, getApiParams, getRequestOptions } = buildCacheTestBackend();

    const { cb } = captureCb();
    await backend.complete(
      'claude-sonnet-4-5-20250929',
      [
        { role: 'system', content: 'You are an expert. <huge dictionary>...', cache: true },
        { role: 'user', content: 'go' },
      ],
      { stream: true, executeTools: false },
      cb
    );

    const apiParams = getApiParams();
    // System param is the array form when any system message has cache: true
    expect(Array.isArray(apiParams.system)).toBe(true);
    const sysBlocks = apiParams.system as Array<{ type: string; text: string; cache_control?: unknown }>;
    const cachedSystem = sysBlocks.find(b => b.cache_control);
    expect(cachedSystem).toBeTruthy();
    expect(cachedSystem!.cache_control).toEqual({ type: 'ephemeral' });
    expect(cachedSystem!.text).toContain('huge dictionary');

    // Beta header still set for system caching too
    expect(getRequestOptions()?.headers?.['anthropic-beta']).toBe('prompt-caching-2024-07-31');
  });

  it('preserves cache_control through filterRelevantMessages sanitization (P1 #1)', async () => {
    const { backend, getApiParams } = buildCacheTestBackend();

    const { cb } = captureCb();
    // Mix: an empty assistant turn (will trigger sanitization) + a cached user message
    await backend.complete(
      'claude-sonnet-4-5-20250929',
      [
        { role: 'user', content: 'big context block', cache: true },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'follow up' },
      ],
      { stream: true, executeTools: false },
      cb
    );

    const apiParams = getApiParams();
    // Despite sanitization potentially cloning the message, the cache_control survives
    // because we stamped it onto the original content blocks BEFORE filtering.
    const cachedMessage = apiParams.messages.find(
      (m: { content: unknown }) =>
        Array.isArray(m.content) && (m.content as Array<{ cache_control?: unknown }>).some(b => b.cache_control)
    );
    expect(cachedMessage).toBeTruthy();
  });

  it('does not set the prompt-caching beta header when no message has cache: true', async () => {
    const { backend, getRequestOptions } = buildCacheTestBackend();

    const { cb } = captureCb();
    await backend.complete(
      'claude-sonnet-4-5-20250929',
      [{ role: 'user', content: 'hi' }],
      { stream: true, executeTools: false },
      cb
    );

    expect(getRequestOptions()?.headers?.['anthropic-beta']).toBeUndefined();
  });
});

// ─── AnthropicBackend: cache token forwarding ───────────────────────

describe('AnthropicBackend cache token forwarding', () => {
  it('forwards cache_read_input_tokens and cache_creation_input_tokens on terminal cb', async () => {
    const backend = new AnthropicBackend('test-key');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _api: any })._api = {
      messages: {
        create: async () =>
          asyncIterable([
            { type: 'message_start' },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              usage: {
                input_tokens: 100,
                output_tokens: 20,
                cache_read_input_tokens: 50_000,
                cache_creation_input_tokens: 1_500,
              },
            },
            { type: 'message_stop' },
          ]),
      },
    };

    const { calls, cb } = captureCb();
    await backend.complete(
      'claude-sonnet-4-5-20250929',
      [{ role: 'user', content: 'hi' }],
      { stream: true, executeTools: false },
      cb
    );

    const last = calls[calls.length - 1];
    expect(last?.info?.cacheReadInputTokens).toBe(50_000);
    expect(last?.info?.cacheCreationInputTokens).toBe(1_500);
  });
});

// ─── OpenAIBackend: native response_format passthrough ──────────────

describe('OpenAIBackend response_format', () => {
  it('passes response_format through to OpenAI natively and reports native mode', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const backend = new OpenAIBackend({ openai: 'test-key' } as any);
    let lastParams: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _api: any })._api = {
      chat: {
        completions: {
          create: async (params: unknown) => {
            lastParams = params;
            return asOpenAIStream([
              {
                choices: [{ index: 0, delta: { content: '{"name":"Erik"}' }, finish_reason: null }],
                usage: null,
              },
              {
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              },
            ]);
          },
        },
      },
    };

    const { calls, cb } = captureCb();
    await backend.complete(
      'gpt-4o',
      [{ role: 'user', content: 'extract' }],
      { stream: true, executeTools: false, responseFormat: SAMPLE_SCHEMA },
      cb
    );

    expect(lastParams.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'extract_user', strict: true },
    });
    expect(lastParams.response_format.json_schema.schema).toEqual(SAMPLE_SCHEMA.json_schema.schema);

    // Last cb has responseFormatMode: native
    const last = calls[calls.length - 1];
    expect(last?.info?.responseFormatMode).toBe('native');
  });
});

// ─── Best-effort backends: schema instruction injected ──────────────

describe('XAIBackend best-effort response_format', () => {
  it('injects a system-level schema instruction and reports best-effort mode', async () => {
    const backend = new XAIBackend('test-key');
    let lastParams: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _api: any })._api = {
      chat: {
        completions: {
          create: async (params: unknown) => {
            lastParams = params;
            return asOpenAIStream([
              { choices: [{ index: 0, delta: { content: '{"name":"x"}' }, finish_reason: null }], usage: null },
              {
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
              },
            ]);
          },
        },
      },
    };

    const { calls, cb } = captureCb();
    await backend.complete(
      'grok-3',
      [{ role: 'user', content: 'extract' }],
      { stream: true, executeTools: false, responseFormat: SAMPLE_SCHEMA },
      cb
    );

    // System message with schema instruction was prepended
    const systemMsg = lastParams.messages.find((m: { role: string }) => m.role === 'system');
    expect(systemMsg).toBeTruthy();
    expect(systemMsg.content).toContain('extract_user');
    expect(systemMsg.content).toContain('JSON Schema');

    const lastInfo = calls[calls.length - 1]?.info;
    expect(lastInfo?.responseFormatMode).toBe('best-effort');
  });
});

describe('GeminiBackend best-effort response_format', () => {
  it('injects schema instruction into systemInstruction and reports best-effort', async () => {
    const backend = new GeminiBackend('test-key');
    let lastConfig: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _api: any })._api = {
      models: {
        generateContentStream: async (cfg: unknown) => {
          lastConfig = cfg;
          return asyncIterable([
            {
              candidates: [{ content: { parts: [{ text: '{"name":"x"}' }] } }],
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
            },
          ]);
        },
      },
    };

    const { calls, cb } = captureCb();
    await backend.complete(
      'gemini-2.5-flash',
      [{ role: 'user', content: 'extract' }],
      { stream: true, executeTools: false, responseFormat: SAMPLE_SCHEMA },
      cb
    );

    expect(lastConfig.systemInstruction).toContain('extract_user');
    expect(lastConfig.systemInstruction).toContain('JSON Schema');

    const last = calls[calls.length - 1];
    expect(last?.info?.responseFormatMode).toBe('best-effort');
  });
});
