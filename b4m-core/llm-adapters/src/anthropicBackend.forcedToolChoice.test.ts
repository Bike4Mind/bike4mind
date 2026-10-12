/**
 * Claude Opus 5.5, Sonnet 5.5, Fable 5.1 and Mythos 5.1 return 400 for a forced tool_choice
 * (`any` / `tool`). AnthropicBackend must never send one to them: json_schema goes through
 * `output_config.format`, and a caller's 'required' / named choice becomes `auto` + `strict` +
 * a system instruction. Every other model keeps the synthesized forced tool unchanged.
 */

import { describe, it, expect, vi } from 'vitest';
import { ChatModels, supportsForcedToolChoice, type ModelInfo, type ResponseFormat } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import type { CompletionInfo, ICompletionOptions, ICompletionOptionTools } from './backend';
import { buildStructuredOutputFormat, buildToolUseInstruction, isStrictCompatibleSchema } from './forcedToolChoice';

type Params = Record<string, unknown> & {
  tools?: Array<Record<string, unknown>>;
  tool_choice?: { type: string; name?: string };
  output_config?: Record<string, unknown>;
  system?: unknown;
};

const NO_FORCED_MODELS = [
  ChatModels.CLAUDE_5_5_OPUS,
  ChatModels.CLAUDE_5_5_OPUS_BEDROCK,
  ChatModels.CLAUDE_5_5_SONNET_BEDROCK,
  ChatModels.CLAUDE_FABLE_5_1_BEDROCK,
  'claude-sonnet-5-5',
  'claude-fable-5-1',
  'claude-mythos-5-1',
];

const FORCED_MODELS = [
  ChatModels.CLAUDE_4_5_SONNET,
  ChatModels.CLAUDE_4_8_OPUS,
  ChatModels.CLAUDE_5_SONNET,
  ChatModels.CLAUDE_5_OPUS,
  ChatModels.CLAUDE_FABLE_5,
];

const SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' }, age: { type: 'integer' } },
  required: ['name'],
  additionalProperties: false,
};

const RESPONSE_FORMAT: ResponseFormat = {
  type: 'json_schema',
  json_schema: { name: 'extract_user', description: 'Extract user info', schema: SCHEMA, strict: true },
};

const RESULT = { name: 'Erik', age: 42 };

function asyncIterable(events: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    controller: { abort: () => {} },
  };
}

function buildBackend(respond: (params: Params, turn: number) => unknown) {
  const backend = new AnthropicBackend('test-key');
  const captured: Params[] = [];
  (backend as unknown as { _api: unknown })._api = {
    messages: {
      create: async (params: Params) => {
        captured.push(structuredClone(params));
        return respond(params, captured.length);
      },
    },
  };
  return { backend, captured };
}

function capture() {
  const calls: Array<{ text: (string | null | undefined)[]; info?: CompletionInfo }> = [];
  return {
    calls,
    cb: async (text: (string | null | undefined)[], info: CompletionInfo) => {
      calls.push({ text, info });
    },
    text: () => calls.flatMap(c => c.text.filter((t): t is string => typeof t === 'string')).join(''),
    mode: () => calls[calls.length - 1]?.info?.responseFormatMode,
  };
}

const textResponse = (text: string) => ({
  content: [{ type: 'text', text }],
  usage: { input_tokens: 10, output_tokens: 5 },
});

const toolUseResponse = (name: string, input: unknown) => ({
  content: [{ type: 'tool_use', id: 'tu_1', name, input }],
  usage: { input_tokens: 10, output_tokens: 5 },
});

function textStream(json: string) {
  return asyncIterable([
    { type: 'message_start' },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: json.slice(0, 10) } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: json.slice(10) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]);
}

function toolUseStream(name: string, json: string) {
  return asyncIterable([
    { type: 'message_start' },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]);
}

function weatherTool(parameters: ICompletionOptionTools['toolSchema']['parameters']): ICompletionOptionTools {
  return {
    toolSchema: { name: 'get_weather', description: 'Get the weather for a city.', parameters },
    toolFn: async () => 'sunny',
    _isMcpTool: true,
  };
}

const STRICT_PARAMS = {
  type: 'object' as const,
  properties: { city: { type: 'string', description: 'City name' } },
  required: ['city'],
  additionalProperties: false,
};

const LOOSE_PARAMS = {
  type: 'object' as const,
  properties: { city: { type: 'string', description: 'City name' } },
  required: ['city'],
};

const otherTool: ICompletionOptionTools = {
  toolSchema: {
    name: 'get_time',
    description: 'Get the time.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  toolFn: async () => 'noon',
  _isMcpTool: true,
};

async function run(backend: AnthropicBackend, model: string, options: Partial<ICompletionOptions>, cb = capture().cb) {
  await backend.complete(model, [{ role: 'user', content: 'go' }], options, cb);
}

function systemText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map(b => (b as { text: string }).text).join('\n');
  return '';
}

function expectNoForcedChoice(params: Params) {
  expect(['any', 'tool']).not.toContain(params.tool_choice?.type);
}

describe('supportsForcedToolChoice', () => {
  it.each(NO_FORCED_MODELS)('is false for %s', model => {
    expect(supportsForcedToolChoice(model)).toBe(false);
  });

  it.each([
    'us.anthropic.claude-opus-5-5',
    'eu.anthropic.claude-sonnet-5-5',
    'anthropic.claude-fable-5-1',
    'apac.anthropic.claude-sonnet-5-5',
    'us-gov.anthropic.claude-fable-5-1',
    'us.anthropic.claude-opus-5-5-v1:0',
    'claude-opus-5-5-20261001',
    'claude-opus-5-5[1m]',
    'anthropic/claude-sonnet-5-5',
  ])('is false for the id spelling %s', model => {
    expect(supportsForcedToolChoice(model)).toBe(false);
  });

  it.each([
    ...FORCED_MODELS,
    ChatModels.CLAUDE_5_SONNET_BEDROCK,
    ChatModels.CLAUDE_FABLE_5_BEDROCK,
    ChatModels.CLAUDE_5_5_HAIKU,
    ChatModels.CLAUDE_5_5_HAIKU_BEDROCK,
    'anthropic.claude-haiku-5-5',
    'gpt-5',
    'claude-opus-5-50',
    'claude-fable-5-10',
    'claude-mythos-preview',
    'claude-sonnet-5-introductory-pricing',
    'xclaude-opus-5-5',
  ])('is true for %s', model => {
    expect(supportsForcedToolChoice(model)).toBe(true);
  });
});

describe('AnthropicBackend json_schema on models without forced tool use', () => {
  it.each(NO_FORCED_MODELS)('uses output_config.format, never a forced tool, for %s (non-streaming)', async model => {
    const { backend, captured } = buildBackend(() => textResponse(JSON.stringify(RESULT)));
    const out = capture();
    await run(backend, model, { stream: false, responseFormat: RESPONSE_FORMAT }, out.cb);

    expect(captured).toHaveLength(1);
    const params = captured[0];
    expectNoForcedChoice(params);
    expect(params).not.toHaveProperty('tool_choice');
    expect(params).not.toHaveProperty('tools');
    expect(params).not.toHaveProperty('output_format');
    expect(params.output_config).toEqual({ format: { type: 'json_schema', schema: SCHEMA } });

    expect(JSON.parse(out.text())).toEqual(RESULT);
    expect(out.mode()).toBe('native');
  });

  it.each(NO_FORCED_MODELS)('streams the JSON text to the caller for %s', async model => {
    const { backend, captured } = buildBackend(() => textStream(JSON.stringify(RESULT)));
    const out = capture();
    await run(backend, model, { stream: true, executeTools: false, responseFormat: RESPONSE_FORMAT }, out.cb);

    expectNoForcedChoice(captured[0]);
    expect(captured[0].output_config).toEqual({ format: { type: 'json_schema', schema: SCHEMA } });
    expect(JSON.parse(out.text())).toEqual(RESULT);
    expect(out.mode()).toBe('native');
  });

  it('delivers the same parsed result as the synthesized-tool path on an older model', async () => {
    const json = JSON.stringify(RESULT);
    const older = buildBackend(() => toolUseStream('extract_user', json));
    const olderOut = capture();
    await run(older.backend, ChatModels.CLAUDE_5_OPUS, { stream: true, responseFormat: RESPONSE_FORMAT }, olderOut.cb);

    const newer = buildBackend(() => textStream(json));
    const newerOut = capture();
    await run(
      newer.backend,
      ChatModels.CLAUDE_5_5_OPUS,
      { stream: true, responseFormat: RESPONSE_FORMAT },
      newerOut.cb
    );

    expect(JSON.parse(newerOut.text())).toEqual(JSON.parse(olderOut.text()));
    expect(newerOut.calls.some(c => c.info?.toolsUsed?.length)).toBe(false);
  });

  it('closes objects the caller left open, as structured outputs require', async () => {
    const { backend, captured } = buildBackend(() => textResponse('{"name":"Erik"}'));
    const openSchema = { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] };
    await run(backend, ChatModels.CLAUDE_5_5_OPUS, {
      stream: false,
      responseFormat: { type: 'json_schema', json_schema: { name: 'n', schema: openSchema, strict: true } },
    });

    const format = captured[0].output_config?.format as { schema: Record<string, unknown> };
    expect(format.schema.additionalProperties).toBe(false);
    expect(JSON.stringify(format.schema)).not.toContain('"minLength"');
  });

  it('merges effort into output_config instead of overwriting the format', async () => {
    const { backend, captured } = buildBackend(() => textResponse(JSON.stringify(RESULT)));
    const record: ModelInfo = {
      id: ChatModels.CLAUDE_5_5_OPUS,
      type: 'text',
      name: 'Claude Opus 5.5',
      backend: 'anthropic',
      contextWindow: 1_000_000,
      max_tokens: 128_000,
      can_think: true,
      thinkingStyle: 'adaptive',
      supportsImageVariation: false,
      pricing: {},
    };
    backend.setDispatchModel(record);
    await run(backend, ChatModels.CLAUDE_5_5_OPUS, {
      stream: false,
      maxTokens: 8000,
      responseFormat: RESPONSE_FORMAT,
      thinking: { enabled: true, budget_tokens: 4000 },
    });

    expect(captured[0].thinking).toEqual({ type: 'adaptive' });
    expect(captured[0].output_config).toEqual({
      format: { type: 'json_schema', schema: SCHEMA },
      effort: 'high',
    });
  });

  it('tags every streamed JSON chunk with the native mode', async () => {
    const { backend } = buildBackend(() => textStream(JSON.stringify(RESULT)));
    const out = capture();
    await run(backend, ChatModels.CLAUDE_5_5_OPUS, { stream: true, responseFormat: RESPONSE_FORMAT }, out.cb);

    const textFrames = out.calls.filter(c => c.text.some(t => typeof t === 'string' && t.length > 0));
    expect(textFrames.length).toBeGreaterThan(1);
    for (const frame of textFrames) expect(frame.info?.responseFormatMode).toBe('native');
  });

  it.each([
    [
      'a recursive $defs schema',
      {
        type: 'object',
        properties: { root: { $ref: '#/$defs/node' } },
        required: ['root'],
        $defs: { node: { type: 'object', properties: { child: { $ref: '#/$defs/node' } } } },
      },
    ],
    ['a root self-reference', { type: 'object', properties: { next: { $ref: '#' } } }],
    ['a free-form object', { type: 'object', properties: { meta: { type: 'object' } } }],
    ['a typeless node', { type: 'object', properties: { anything: {} } }],
  ])('falls back to the prompt instruction for %s instead of a 400', async (_label, schema) => {
    const { backend, captured } = buildBackend(() => textResponse(JSON.stringify(RESULT)));
    const out = capture();
    await run(
      backend,
      ChatModels.CLAUDE_5_5_OPUS,
      { stream: false, responseFormat: { type: 'json_schema', json_schema: { name: 'n', schema } } },
      out.cb
    );

    expectNoForcedChoice(captured[0]);
    expect(captured[0]).not.toHaveProperty('output_config');
    expect(systemText(captured[0].system)).toContain('Schema name: n');
    expect(out.mode()).toBe('best-effort');
  });
});

describe('buildStructuredOutputFormat', () => {
  it('keeps enum, const and definitions refs that the SDK transform would drop or dangle', () => {
    const schema = {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['a', 'b'] },
        version: { const: 2 },
        choice: { enum: ['x', 'y'] },
        owner: { $ref: '#/definitions/person' },
      },
      required: ['kind'],
      definitions: { person: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    };
    const before = structuredClone(schema);

    const format = buildStructuredOutputFormat(schema);

    expect(schema).toEqual(before);
    expect(format).toEqual({
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['a', 'b'] },
          version: { const: 2 },
          choice: { enum: ['x', 'y'] },
          owner: { $ref: '#/definitions/person' },
        },
        required: ['kind'],
        definitions: {
          person: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    });
  });

  it('turns oneOf into anyOf and moves unsupported constraints into the description', () => {
    const format = buildStructuredOutputFormat({
      type: 'object',
      properties: {
        n: { type: 'integer', minimum: 1, description: 'count' },
        v: { oneOf: [{ type: 'string', pattern: '^a' }, { type: 'null' }] },
        tags: { type: 'array', items: { type: 'string' }, minItems: 3 },
      },
      additionalProperties: false,
    });

    expect(format?.schema).toEqual({
      type: 'object',
      properties: {
        n: { type: 'integer', description: 'count\n\n{minimum: 1}' },
        v: { anyOf: [{ type: 'string', description: '{pattern: "^a"}' }, { type: 'null' }] },
        tags: { type: 'array', items: { type: 'string' }, description: '{minItems: 3}' },
      },
      additionalProperties: false,
    });
  });

  it('closes a nullable object type', () => {
    const format = buildStructuredOutputFormat({ type: ['object', 'null'], properties: { a: { type: 'string' } } });
    expect(format?.schema).toEqual({
      type: ['object', 'null'],
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    });
  });
});

describe('AnthropicBackend caller tool_choice on models without forced tool use', () => {
  it.each(NO_FORCED_MODELS)('downgrades a named choice to auto + strict + instruction for %s', async model => {
    const { backend, captured } = buildBackend(() => textResponse('ok'));
    await run(backend, model, {
      stream: false,
      tools: [weatherTool(STRICT_PARAMS), otherTool],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    });

    const params = captured[0];
    expect(params.tool_choice).toEqual({ type: 'auto' });
    expect(params.tools?.find(t => t.name === 'get_weather')?.strict).toBe(true);
    expect(params.tools?.find(t => t.name === 'get_time')).not.toHaveProperty('strict');
    expect(systemText(params.system)).toContain(buildToolUseInstruction({ toolName: 'get_weather' }));
  });

  it.each(NO_FORCED_MODELS)("downgrades 'required' to auto + instruction for %s", async model => {
    const { backend, captured } = buildBackend(() => textResponse('ok'));
    await run(backend, model, { stream: false, tools: [weatherTool(STRICT_PARAMS)], tool_choice: 'required' });

    const params = captured[0];
    expect(params.tool_choice).toEqual({ type: 'auto' });
    expect(params.tools?.[0]).not.toHaveProperty('strict');
    expect(systemText(params.system)).toContain(buildToolUseInstruction({ toolName: null }));
  });

  it('leaves strict off a named tool whose schema strict mode would reject', async () => {
    const { backend, captured } = buildBackend(() => textResponse('ok'));
    await run(backend, ChatModels.CLAUDE_5_5_OPUS, {
      stream: false,
      tools: [weatherTool(LOOSE_PARAMS)],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    });

    expect(captured[0].tool_choice).toEqual({ type: 'auto' });
    expect(captured[0].tools?.[0]).not.toHaveProperty('strict');
  });

  it('keeps tools and system identical on the post-tool turn and warns once', async () => {
    const { backend, captured } = buildBackend((_params, turn) =>
      turn === 1 ? toolUseResponse('get_weather', { city: 'NYC' }) : textResponse('done')
    );
    const warn = vi.spyOn((backend as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger, 'warn');
    await run(backend, ChatModels.CLAUDE_5_5_OPUS, {
      stream: false,
      tools: [weatherTool(STRICT_PARAMS)],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    });

    expect(captured).toHaveLength(2);
    for (const params of captured) expectNoForcedChoice(params);
    expect(captured[1].tool_choice).toEqual({ type: 'auto' });
    // Preserved thinking compares system and tools across turns, so neither may drift.
    expect(captured[1].tools).toEqual(captured[0].tools);
    expect(captured[1].system).toEqual(captured[0].system);
    const downgradeWarnings = warn.mock.calls.filter(([msg]) => String(msg).includes('Forced tool_choice'));
    expect(downgradeWarnings).toHaveLength(1);
  });

  it("leaves 'auto' untouched", async () => {
    const { backend, captured } = buildBackend(() => textResponse('ok'));
    await run(backend, ChatModels.CLAUDE_5_5_OPUS, {
      stream: false,
      tools: [weatherTool(STRICT_PARAMS)],
      tool_choice: 'auto',
    });

    expect(captured[0].tool_choice).toEqual({ type: 'auto' });
    expect(captured[0].tools?.[0]).not.toHaveProperty('strict');
    expect(systemText(captured[0].system)).not.toContain(buildToolUseInstruction({ toolName: null }));
  });
});

describe('AnthropicBackend on models with forced tool use (unchanged)', () => {
  it.each(FORCED_MODELS)('synthesizes the forced json_schema tool for %s', async model => {
    const { backend, captured } = buildBackend(() => toolUseResponse('extract_user', RESULT));
    const out = capture();
    await run(backend, model, { stream: false, responseFormat: RESPONSE_FORMAT }, out.cb);

    const params = captured[0];
    expect(params.tools).toEqual([{ name: 'extract_user', description: 'Extract user info', input_schema: SCHEMA }]);
    expect(params.tool_choice).toEqual({ type: 'tool', name: 'extract_user' });
    expect(params).not.toHaveProperty('output_config');
    expect(JSON.parse(out.text())).toEqual(RESULT);
    expect(out.mode()).toBe('tool_use');
  });

  it.each(FORCED_MODELS)('forwards required and named choices as any / tool for %s', async model => {
    const named = buildBackend(() => textResponse('ok'));
    await run(named.backend, model, {
      stream: false,
      tools: [weatherTool(STRICT_PARAMS)],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    });
    const required = buildBackend(() => textResponse('ok'));
    await run(required.backend, model, { stream: false, tools: [weatherTool(STRICT_PARAMS)], tool_choice: 'required' });
    const auto = buildBackend(() => textResponse('ok'));
    await run(auto.backend, model, { stream: false, tools: [weatherTool(STRICT_PARAMS)], tool_choice: 'auto' });

    expect(named.captured[0].tool_choice).toEqual({ type: 'tool', name: 'get_weather' });
    expect(required.captured[0].tool_choice).toEqual({ type: 'any' });
    for (const params of [named.captured[0], required.captured[0]]) {
      expect(params.tools?.[0]).not.toHaveProperty('strict');
      // Same system text as an auto request: no instruction is added.
      expect(params.system).toEqual(auto.captured[0].system);
    }
  });
});

describe('AnthropicBackend json_schema with document citations', () => {
  it('puts the schema in the prompt instead of output_config.format, which citations reject', async () => {
    const { backend, captured } = buildBackend(() => textResponse(JSON.stringify(RESULT)));
    const out = capture();
    await backend.complete(
      ChatModels.CLAUDE_5_5_OPUS,
      [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'text', media_type: 'text/plain', data: 'Erik is 42.' },
              citations: { enabled: true },
            },
            { type: 'text', text: 'extract the user' },
          ] as unknown as string,
        },
      ],
      { stream: false, responseFormat: RESPONSE_FORMAT },
      out.cb
    );

    expectNoForcedChoice(captured[0]);
    expect(captured[0]).not.toHaveProperty('output_config');
    expect(systemText(captured[0].system)).toContain('Schema name: extract_user');
    expect(JSON.parse(out.text())).toEqual(RESULT);
    expect(out.mode()).toBe('best-effort');
  });
});

describe('isStrictCompatibleSchema', () => {
  it('accepts a closed schema with required lists at every level', () => {
    expect(
      isStrictCompatibleSchema({
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
              additionalProperties: false,
            },
          },
        },
        required: ['items'],
        additionalProperties: false,
      })
    ).toBe(true);
  });

  it.each([
    ['an open object', { type: 'object', properties: {}, required: [] }],
    ['an object with no required list', { type: 'object', properties: {}, additionalProperties: false }],
    [
      'a nested open object',
      {
        type: 'object',
        properties: { inner: { type: 'object', properties: {}, required: [] } },
        required: [],
        additionalProperties: false,
      },
    ],
    [
      'a numeric constraint',
      {
        type: 'object',
        properties: { n: { type: 'integer', minimum: 1 } },
        required: [],
        additionalProperties: false,
      },
    ],
    ['a $ref', { $ref: '#/$defs/node' }],
  ])('rejects %s', (_label, schema) => {
    expect(isStrictCompatibleSchema(schema)).toBe(false);
  });
});
