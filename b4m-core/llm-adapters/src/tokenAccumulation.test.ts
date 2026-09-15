/**
 * Per-backend regression tests for multi-turn token accumulation.
 *
 * Catches two related bugs:
 *
 * 1. Single-turn drops tokens entirely (Anthropic-only pre-fix bug - terminal
 *    cb omitted inputTokens/outputTokens, leading to a 1-credit floor for
 *    every call regardless of size).
 *
 * 2. Multi-turn under-counting (all backends pre-fix - recursive complete()
 *    calls didn't thread an accumulator, so cliCompletions' assign-not-add
 *    wrappedOnChunk only saw the terminal turn's tokens; turns 1..N-1 were
 *    silently dropped from the credit charge).
 *
 * Each backend's complete() is exercised against a mocked SDK that returns
 * canned streams. The test suite is parameterized over all four similar-shape
 * backends (Anthropic, OpenAI, xAI, Gemini). Bedrock has a different SDK
 * surface and lives in bedrockBackend.tokenAccumulation.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { Stream } from 'openai/streaming';
import type { CompletionInfo } from '@bike4mind/common';
import type { ICompletionBackend, ICompletionOptionTools } from './backend';
import { AnthropicBackend } from './anthropicBackend';
import { OpenAIBackend } from './openaiBackend';
import { XAIBackend } from './xaiBackend';
import { GeminiBackend } from './geminiBackend';

// ─── Shared helpers ────────────────────────────────────────────────

interface MockUsage {
  input: number;
  output: number;
}

interface CapturedCb {
  text: (string | null | undefined)[];
  info?: CompletionInfo;
}

/** Plain async iterable. Used by Anthropic and Gemini SDK shapes. */
function asyncIterable(events: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    controller: { abort: () => {} },
  };
}

/** OpenAI/xAI's `Stream<>` class - backends gate on `instanceof Stream`. */
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

function lastTokenEmit(calls: CapturedCb[]): CompletionInfo | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    const info = calls[i].info;
    if (info && (info.inputTokens || info.outputTokens)) return info;
  }
  return undefined;
}

/**
 * Returns the info from the *very last* cb call, regardless of whether it
 * carries tokens. Use to assert that the terminal cb itself is the one
 * carrying the running total - catches a backend that emits the right total
 * on an intermediate turn but 0 (or omits info) on the final turn, a bug
 * lastTokenEmit would mask by scanning backward.
 */
function finalCbInfo(calls: CapturedCb[]): CompletionInfo | undefined {
  return calls[calls.length - 1]?.info;
}

const ADD_TOOL: ICompletionOptionTools = {
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
  toolFn: async (params: unknown) => {
    const p = params as { a: number; b: number };
    return String(p.a + p.b);
  },
};

// ─── Backend specs ─────────────────────────────────────────────────
//
// Each spec encapsulates how to build the backend with a mockable SDK
// and how to construct chunk fixtures for the two turn shapes the tests
// need: a turn that returns a tool_use, and a turn that returns final text.

interface BackendSpec {
  name: string;
  model: string;
  /**
   * Returns a backend instance plus a setter to inject the per-test stream
   * sequence and a counter for the number of SDK calls actually made - the
   * counter guards against backends that short-circuit recursion and would
   * otherwise pass the token-sum assertions without invoking each turn.
   */
  build: () => {
    backend: ICompletionBackend;
    setMockSequence: (sequence: unknown[][]) => void;
    callCount: () => number;
  };
  turnWithToolCall: (name: string, id: string, args: Record<string, unknown>, usage: MockUsage) => unknown[];
  turnWithText: (text: string, usage: MockUsage) => unknown[];
}

// Anthropic SDK: this._api.messages.create(...) returns an async iterable
// of MessageStreamEvent objects with content_block_*, message_delta, etc.
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
    return {
      backend,
      setMockSequence: s => {
        sequence = s;
        calls = 0;
      },
      callCount: () => calls,
    };
  },
  turnWithToolCall: (name, id, args, usage) => [
    { type: 'message_start' },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) },
    },
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
};

// OpenAI SDK: this._api.chat.completions.create(...) returns a Stream of
// ChatCompletionChunk. Backend gates on `instanceof Stream`.
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
    return {
      backend,
      setMockSequence: s => {
        sequence = s;
        calls = 0;
      },
      callCount: () => calls,
    };
  },
  turnWithToolCall: (name, id, args, usage) => [
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }],
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
          delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] },
          finish_reason: null,
        },
      ],
      usage: null,
    },
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: {
        prompt_tokens: usage.input,
        completion_tokens: usage.output,
        total_tokens: usage.input + usage.output,
      },
    },
  ],
  turnWithText: (text, usage) => [
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }], usage: null },
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: usage.input,
        completion_tokens: usage.output,
        total_tokens: usage.input + usage.output,
      },
    },
  ],
};

// xAI: same SDK shape as OpenAI (uses the openai npm package against xAI's
// OpenAI-compatible API). Same chunk shape.
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
    return {
      backend,
      setMockSequence: s => {
        sequence = s;
        calls = 0;
      },
      callCount: () => calls,
    };
  },
  turnWithToolCall: openaiSpec.turnWithToolCall,
  turnWithText: openaiSpec.turnWithText,
};

// Gemini SDK: this._api.models.generateContentStream(...) returns an async
// iterable of chunks with candidates[].content.parts[]. usageMetadata on the
// final chunk carries token counts.
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
    return {
      backend,
      setMockSequence: s => {
        sequence = s;
        calls = 0;
      },
      callCount: () => calls,
    };
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
};

const SPECS: BackendSpec[] = [anthropicSpec, openaiSpec, xaiSpec, geminiSpec];

// ─── Tests ─────────────────────────────────────────────────────────

describe.each(SPECS)('$name token accumulation', spec => {
  it('single-turn no tools — terminal cb carries real input/output tokens', async () => {
    const { backend, setMockSequence, callCount } = spec.build();
    setMockSequence([spec.turnWithText('Hello, world.', { input: 50, output: 5 })]);
    const { calls, cb } = captureCb();

    await backend.complete(spec.model, [{ role: 'user', content: 'hi' }], { stream: true, tools: [] }, cb);

    expect(callCount()).toBe(1);
    const final = lastTokenEmit(calls);
    expect(final).toBeDefined();
    expect(final!.inputTokens).toBe(50);
    expect(final!.outputTokens).toBe(5);
    // The very last cb call must itself carry the totals - guards against a
    // backend that emits the right total on an intermediate cb but 0 on the
    // final cb. cliCompletions' assign-not-add wrappedOnChunk would still bill
    // correctly via the intermediate emit, but the contract is "terminal cb
    // carries the running total" and we want to enforce it here.
    const lastCb = finalCbInfo(calls);
    expect(lastCb).toBeDefined();
    expect(lastCb!.inputTokens).toBe(50);
    expect(lastCb!.outputTokens).toBe(5);
  });

  it('2-turn tool round-trip — terminal cb sees sum across both turns', async () => {
    const { backend, setMockSequence, callCount } = spec.build();
    setMockSequence([
      spec.turnWithToolCall('add', 'tool_test_01', { a: 2, b: 3 }, { input: 100, output: 20 }),
      spec.turnWithText('The result is 5.', { input: 200, output: 30 }),
    ]);
    const { calls, cb } = captureCb();

    await backend.complete(
      spec.model,
      [{ role: 'user', content: 'What is 2 + 3?' }],
      { stream: true, tools: [ADD_TOOL], executeTools: true },
      cb
    );

    // callCount guards against a backend that short-circuits the recursion -
    // such a backend could still pass the token-sum assertions if the first
    // turn's cb happened to emit the expected total directly.
    expect(callCount()).toBe(2);
    // Without the accumulator pattern, only turn 2's tokens (200/30) survive
    // and turn 1's (100/20) are silently dropped. Verify the sum is reported.
    const final = lastTokenEmit(calls);
    expect(final).toBeDefined();
    expect(final!.inputTokens).toBe(300); // 100 + 200
    expect(final!.outputTokens).toBe(50); // 20 + 30
    const lastCb = finalCbInfo(calls);
    expect(lastCb).toBeDefined();
    expect(lastCb!.inputTokens).toBe(300);
    expect(lastCb!.outputTokens).toBe(50);
  });

  it('3-turn tool chain — terminal cb sees sum across all three turns', async () => {
    const { backend, setMockSequence, callCount } = spec.build();
    setMockSequence([
      spec.turnWithToolCall('add', 'tool_t1', { a: 1, b: 1 }, { input: 80, output: 15 }),
      spec.turnWithToolCall('add', 'tool_t2', { a: 2, b: 2 }, { input: 150, output: 18 }),
      spec.turnWithText('Done.', { input: 220, output: 8 }),
    ]);
    const { calls, cb } = captureCb();

    await backend.complete(
      spec.model,
      [{ role: 'user', content: 'Run two adds.' }],
      { stream: true, tools: [ADD_TOOL], executeTools: true },
      cb
    );

    expect(callCount()).toBe(3);
    const final = lastTokenEmit(calls);
    expect(final).toBeDefined();
    expect(final!.inputTokens).toBe(450); // 80 + 150 + 220
    expect(final!.outputTokens).toBe(41); // 15 + 18 + 8
    const lastCb = finalCbInfo(calls);
    expect(lastCb).toBeDefined();
    expect(lastCb!.inputTokens).toBe(450);
    expect(lastCb!.outputTokens).toBe(41);
  });
});
