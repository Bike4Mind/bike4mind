/**
 * Per-backend regression tests for functionCalls[].returnValue/.success recording.
 *
 * Clones the mock-SDK harness from tokenAccumulation.test.ts (kept separate rather
 * than importing, since nothing there is exported) rather than adding a Kimi spec
 * and a fifth describe block onto that file's existing token-accumulation focus.
 * Ollama and Bedrock have their own harnesses and their own test files - see
 * ollamaBackend.test.ts and bedrockBackend/toolErrorHandling.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { Stream } from 'openai/streaming';
import type { CompletionInfo } from '@bike4mind/common';
import type { ICompletionBackend, ICompletionOptionTools } from './backend';
import { AnthropicBackend } from './anthropicBackend';
import { OpenAIBackend } from './openaiBackend';
import { XAIBackend } from './xaiBackend';
import { GeminiBackend } from './geminiBackend';
import { KimiBackend } from './kimiBackend';
import { MAX_RECORDED_TOOL_RESULT_CHARS, TOOL_RESULT_TRUNCATION_NOTICE } from './recordToolResult';

interface MockUsage {
  input: number;
  output: number;
}

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

function lastToolsUsed(calls: CapturedCb[]) {
  for (let i = calls.length - 1; i >= 0; i--) {
    const toolsUsed = calls[i].info?.toolsUsed;
    if (toolsUsed && toolsUsed.length > 0) return toolsUsed;
  }
  return undefined;
}

function makeTool(fn: (params: { a: number; b: number }) => Promise<string>): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'add',
      description: 'Add two numbers',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'number', description: 'first number' },
          b: { type: 'number', description: 'second number' },
        },
        required: ['a', 'b'],
      },
    },
    toolFn: async params => fn(params as { a: number; b: number }),
  };
}

interface BackendSpec {
  name: string;
  model: string;
  build: () => {
    backend: ICompletionBackend;
    setMockSequence: (sequence: unknown[][]) => void;
  };
  turnWithToolCall: (name: string, id: string, args: Record<string, unknown>, usage: MockUsage) => unknown[];
  turnWithText: (text: string, usage: MockUsage) => unknown[];
  /** A turn with TWO calls to the same tool, distinguished by id. */
  turnWithTwoToolCalls: (
    name: string,
    id1: string,
    id2: string,
    args: Record<string, unknown>,
    usage: MockUsage
  ) => unknown[];
  /**
   * Extracts the tool's own return value out of a recorded returnValue. Identity for most
   * backends, but Gemini records `JSON.stringify({result: ...})` (what it actually feeds back
   * to the model), not the bare string - see the "do not substitute String(result)" note on
   * the Gemini backend edit.
   */
  extractResult: (returnValue: string) => string;
}

const anthropicSpec: BackendSpec = {
  name: 'AnthropicBackend',
  model: 'claude-sonnet-4-5-20250929',
  build: () => {
    const backend = new AnthropicBackend('test-key');
    let calls = 0;
    let sequence: unknown[][] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _api: any })._api = {
      messages: {
        create: async () => {
          const events = sequence[calls++];
          if (!events) throw new Error(`No mock for call ${calls}`);
          return asyncIterable(events);
        },
      },
    };
    return { backend, setMockSequence: s => (sequence = s) };
  },
  turnWithToolCall: (name, id, args, usage) => [
    { type: 'message_start' },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', usage: { input_tokens: usage.input, output_tokens: usage.output } },
    { type: 'message_stop' },
  ],
  turnWithText: (text, usage) => [
    { type: 'message_start' },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', usage: { input_tokens: usage.input, output_tokens: usage.output } },
    { type: 'message_stop' },
  ],
  turnWithTwoToolCalls: (name, id1, id2, args, usage) => [
    { type: 'message_start' },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: id1, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: id2, name, input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', usage: { input_tokens: usage.input, output_tokens: usage.output } },
    { type: 'message_stop' },
  ],
  extractResult: v => v,
};

const openaiSpec: BackendSpec = {
  name: 'OpenAIBackend',
  model: 'gpt-4o',
  build: () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const backend = new OpenAIBackend({ openai: 'test-key' } as any);
    let calls = 0;
    let sequence: unknown[][] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _api: any })._api = {
      chat: {
        completions: {
          create: async () => {
            const events = sequence[calls++];
            if (!events) throw new Error(`No mock for call ${calls}`);
            return asOpenAIStream(events);
          },
        },
      },
    };
    return { backend, setMockSequence: s => (sequence = s) };
  },
  turnWithToolCall: (name, id, args, usage) => [
    {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] },
          finish_reason: null,
        },
      ],
      usage: null,
    },
    {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] },
          finish_reason: null,
        },
      ],
      usage: null,
    },
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
    },
  ],
  turnWithText: (text, usage) => [
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }], usage: null },
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
    },
  ],
  turnWithTwoToolCalls: (name, id1, id2, args, usage) => [
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: id1, type: 'function', function: { name, arguments: JSON.stringify(args) } },
              { index: 1, id: id2, type: 'function', function: { name, arguments: JSON.stringify(args) } },
            ],
          },
          finish_reason: null,
        },
      ],
      usage: null,
    },
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
    },
  ],
  extractResult: v => v,
};

const xaiSpec: BackendSpec = {
  name: 'XAIBackend',
  model: 'grok-3',
  build: () => {
    const backend = new XAIBackend('test-key');
    let calls = 0;
    let sequence: unknown[][] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _api: any })._api = {
      chat: {
        completions: {
          create: async () => {
            const events = sequence[calls++];
            if (!events) throw new Error(`No mock for call ${calls}`);
            return asOpenAIStream(events);
          },
        },
      },
    };
    return { backend, setMockSequence: s => (sequence = s) };
  },
  turnWithToolCall: openaiSpec.turnWithToolCall,
  turnWithText: openaiSpec.turnWithText,
  turnWithTwoToolCalls: openaiSpec.turnWithTwoToolCalls,
  extractResult: v => v,
};

const kimiSpec: BackendSpec = {
  name: 'KimiBackend',
  model: 'kimi-k2',
  build: () => {
    const backend = new KimiBackend('test-key');
    let calls = 0;
    let sequence: unknown[][] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _api: any })._api = {
      chat: {
        completions: {
          create: async () => {
            const events = sequence[calls++];
            if (!events) throw new Error(`No mock for call ${calls}`);
            return asOpenAIStream(events);
          },
        },
      },
    };
    return { backend, setMockSequence: s => (sequence = s) };
  },
  turnWithToolCall: openaiSpec.turnWithToolCall,
  turnWithText: openaiSpec.turnWithText,
  turnWithTwoToolCalls: openaiSpec.turnWithTwoToolCalls,
  extractResult: v => v,
};

const geminiSpec: BackendSpec = {
  name: 'GeminiBackend',
  model: 'gemini-2.5-flash',
  build: () => {
    const backend = new GeminiBackend('test-key');
    let calls = 0;
    let sequence: unknown[][] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _api: any })._api = {
      models: {
        generateContentStream: async () => {
          const events = sequence[calls++];
          if (!events) throw new Error(`No mock for call ${calls}`);
          return asyncIterable(events);
        },
      },
    };
    return { backend, setMockSequence: s => (sequence = s) };
  },
  turnWithToolCall: (name, _id, args, usage) => [
    {
      candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }],
      usageMetadata: { promptTokenCount: usage.input, candidatesTokenCount: usage.output },
    },
  ],
  turnWithText: (text, usage) => [
    {
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: usage.input, candidatesTokenCount: usage.output },
    },
  ],
  turnWithTwoToolCalls: (name, _id1, _id2, args, usage) => [
    {
      candidates: [{ content: { parts: [{ functionCall: { name, args } }, { functionCall: { name, args } }] } }],
      usageMetadata: { promptTokenCount: usage.input, candidatesTokenCount: usage.output },
    },
  ],
  extractResult: v => JSON.parse(v).result,
};

const SPECS: BackendSpec[] = [anthropicSpec, openaiSpec, xaiSpec, kimiSpec, geminiSpec];

describe.each(SPECS)('$name tool result recording', spec => {
  it('records returnValue and success:true on a successful round-trip', async () => {
    const { backend, setMockSequence } = spec.build();
    const tool = makeTool(async ({ a, b }) => String(a + b));
    setMockSequence([
      spec.turnWithToolCall('add', 'call_1', { a: 2, b: 3 }, { input: 10, output: 5 }),
      spec.turnWithText('The result is 5.', { input: 20, output: 5 }),
    ]);
    const { calls, cb } = captureCb();

    await backend.complete(
      spec.model,
      [{ role: 'user', content: 'add' }],
      { stream: true, tools: [tool], executeTools: true },
      cb
    );

    const toolsUsed = lastToolsUsed(calls);
    expect(toolsUsed).toBeDefined();
    expect(toolsUsed![0].success).toBe(true);
    expect(spec.extractResult(toolsUsed![0].returnValue ?? '')).toBe('5');
  });

  it('records success:false with the error text on a failing tool', async () => {
    const { backend, setMockSequence } = spec.build();
    const tool = makeTool(async () => {
      throw new Error('boom');
    });
    setMockSequence([
      spec.turnWithToolCall('add', 'call_1', { a: 2, b: 3 }, { input: 10, output: 5 }),
      spec.turnWithText('Sorry, that failed.', { input: 20, output: 5 }),
    ]);
    const { calls, cb } = captureCb();

    await backend.complete(
      spec.model,
      [{ role: 'user', content: 'add' }],
      { stream: true, tools: [tool], executeTools: true },
      cb
    );

    const toolsUsed = lastToolsUsed(calls);
    expect(toolsUsed).toBeDefined();
    expect(toolsUsed![0].success).toBe(false);
    expect(toolsUsed![0].returnValue).toContain('boom');
  });

  it('truncates an over-cap result to the cap plus notice length', async () => {
    const { backend, setMockSequence } = spec.build();
    const longResult = 'x'.repeat(MAX_RECORDED_TOOL_RESULT_CHARS + 500);
    const tool = makeTool(async () => longResult);
    setMockSequence([
      spec.turnWithToolCall('add', 'call_1', { a: 2, b: 3 }, { input: 10, output: 5 }),
      spec.turnWithText('Done.', { input: 20, output: 5 }),
    ]);
    const { calls, cb } = captureCb();

    await backend.complete(
      spec.model,
      [{ role: 'user', content: 'add' }],
      { stream: true, tools: [tool], executeTools: true },
      cb
    );

    const toolsUsed = lastToolsUsed(calls);
    expect(toolsUsed).toBeDefined();
    expect(toolsUsed![0].returnValue?.length).toBe(
      MAX_RECORDED_TOOL_RESULT_CHARS + TOOL_RESULT_TRUNCATION_NOTICE.length
    );
    expect(toolsUsed![0].returnValue?.endsWith(TOOL_RESULT_TRUNCATION_NOTICE)).toBe(true);
  });

  it('gives two calls to the same tool in one turn distinct returnValues', async () => {
    const { backend, setMockSequence } = spec.build();
    let callIndex = 0;
    const results = ['3', '7'];
    const tool = makeTool(async () => results[callIndex++]);
    setMockSequence([
      spec.turnWithTwoToolCalls('add', 'call_1', 'call_2', { a: 1, b: 2 }, { input: 10, output: 5 }),
      spec.turnWithText('Done.', { input: 20, output: 5 }),
    ]);
    const { calls, cb } = captureCb();

    await backend.complete(
      spec.model,
      [{ role: 'user', content: 'add twice' }],
      { stream: true, tools: [tool], executeTools: true },
      cb
    );

    const toolsUsed = lastToolsUsed(calls);
    expect(toolsUsed).toBeDefined();
    expect(toolsUsed!.length).toBe(2);
    // Positional, not sorted: sorting before comparing would pass even if the correlation swapped
    // call_1 and call_2's results, since ['3','7'].sort() equals ['7','3'].sort(). Gemini's
    // function-call parts carry no caller-supplied id (only a backend-minted one), so submission
    // order - not id lookup - is the one correlation every spec here shares.
    const returnValues = toolsUsed!.map(t => spec.extractResult(t.returnValue ?? ''));
    expect(returnValues).toEqual(['3', '7']);
  });
});

describe('malformed tool arguments are stamped, not left unrecorded', () => {
  // Regression: the malformed-arguments skip path pushes a toolsUsed entry (id+name) before the
  // JSON.parse that fails, so it enters replayableToolCalls in utils.ts once a sibling call in the
  // same turn has a real returnValue - it must carry success:false, or it replays as an
  // indistinguishable TOOL_RESULT_NOT_RECORDED marker instead of "this call never ran".

  it('AnthropicBackend records success:false when tool_use JSON is malformed (streaming)', async () => {
    const backend = new AnthropicBackend('test-key');
    let calls = 0;
    const sequence: unknown[][] = [
      [
        { type: 'message_start' },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_1', name: 'add', input: {} },
        },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{not valid json' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', usage: { input_tokens: 10, output_tokens: 5 } },
        { type: 'message_stop' },
      ],
      [
        { type: 'message_start' },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sorry, that failed.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', usage: { input_tokens: 20, output_tokens: 5 } },
        { type: 'message_stop' },
      ],
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _api: any })._api = {
      messages: { create: async () => asyncIterable(sequence[calls++]) },
    };
    const tool = makeTool(async ({ a, b }) => String(a + b));
    const { calls: cbCalls, cb } = captureCb();

    await backend.complete(
      'claude-sonnet-4-5-20250929',
      [{ role: 'user', content: 'add' }],
      { stream: true, tools: [tool], executeTools: true },
      cb
    );

    const toolsUsed = lastToolsUsed(cbCalls);
    expect(toolsUsed).toBeDefined();
    expect(toolsUsed![0].success).toBe(false);
    expect(toolsUsed![0].returnValue).toContain('corrupted');
  });

  it('OpenAIBackend records success:false when tool_calls JSON is malformed (streaming)', async () => {
    const backend = new OpenAIBackend({ openai: 'test-key' } as never);
    let calls = 0;
    const sequence: unknown[][] = [
      [
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'add', arguments: '' } }],
              },
              finish_reason: null,
            },
          ],
          usage: null,
        },
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '{not valid' } }] },
              finish_reason: null,
            },
          ],
          usage: null,
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ],
      [
        { choices: [{ index: 0, delta: { content: 'Sorry, that failed.' }, finish_reason: null }], usage: null },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        },
      ],
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _api: any })._api = {
      chat: { completions: { create: async () => asOpenAIStream(sequence[calls++]) } },
    };
    const tool = makeTool(async ({ a, b }) => String(a + b));
    const { calls: cbCalls, cb } = captureCb();

    await backend.complete(
      'gpt-4o',
      [{ role: 'user', content: 'add' }],
      { stream: true, tools: [tool], executeTools: true },
      cb
    );

    const toolsUsed = lastToolsUsed(cbCalls);
    expect(toolsUsed).toBeDefined();
    expect(toolsUsed![0].success).toBe(false);
    expect(toolsUsed![0].returnValue).toContain('malformed');
  });
});
