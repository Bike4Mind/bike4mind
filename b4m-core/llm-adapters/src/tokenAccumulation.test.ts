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
import { getTurnsCost, type CompletionInfo, type ModelInfo } from '@bike4mind/common';
import type { ICompletionBackend, ICompletionOptionTools } from './backend';
import { AnthropicBackend } from './anthropicBackend';
import { OpenAIBackend } from './openaiBackend';
import { XAIBackend } from './xaiBackend';
import { GeminiBackend } from './geminiBackend';

// ─── Shared helpers ────────────────────────────────────────────────

interface MockUsage {
  input: number;
  output: number;
  /** Emitted in the provider's native reasoning field only when set. */
  reasoning?: number;
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

function anthropicUsage(usage: MockUsage) {
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    ...(usage.reasoning !== undefined ? { output_tokens_details: { thinking_tokens: usage.reasoning } } : {}),
  };
}

function openaiChatUsage(usage: MockUsage) {
  return {
    prompt_tokens: usage.input,
    completion_tokens: usage.output,
    total_tokens: usage.input + usage.output,
    ...(usage.reasoning !== undefined ? { completion_tokens_details: { reasoning_tokens: usage.reasoning } } : {}),
  };
}

function geminiMockUsage(usage: MockUsage) {
  return {
    promptTokenCount: usage.input,
    candidatesTokenCount: usage.output,
    ...(usage.reasoning !== undefined ? { thoughtsTokenCount: usage.reasoning } : {}),
  };
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
    { type: 'message_delta', usage: anthropicUsage(usage) },
    { type: 'message_stop' },
  ],
  turnWithText: (text, usage) => [
    { type: 'message_start' },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', usage: anthropicUsage(usage) },
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
      usage: openaiChatUsage(usage),
    },
  ],
  turnWithText: (text, usage) => [
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }], usage: null },
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: openaiChatUsage(usage),
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
      usageMetadata: geminiMockUsage(usage),
    },
  ],
  turnWithText: (text, usage) => [
    {
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: geminiMockUsage(usage),
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

// Adapters that report per-request usage (CompletionInfo.turnUsage). Gemini and xAI are covered below.
describe.each([anthropicSpec, openaiSpec])('$name per-request usage', spec => {
  it('reports one turnUsage entry per round-trip, summing to the aggregates', async () => {
    const { backend, setMockSequence } = spec.build();
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

    const lastCb = finalCbInfo(calls);
    expect(lastCb!.turnUsage).toEqual([
      { inputTokens: 80, outputTokens: 15 },
      { inputTokens: 150, outputTokens: 18 },
      { inputTokens: 220, outputTokens: 8 },
    ]);
    expect(lastCb!.inputTokens).toBe(450);
    expect(lastCb!.outputTokens).toBe(41);
  });

  it('reports the call as a turn when tool calls are passed through (executeTools: false)', async () => {
    const { backend, setMockSequence } = spec.build();
    setMockSequence([spec.turnWithToolCall('add', 'tool_t1', { a: 1, b: 1 }, { input: 80, output: 15 })]);
    const { calls, cb } = captureCb();

    await backend.complete(
      spec.model,
      [{ role: 'user', content: 'Add.' }],
      { stream: true, tools: [ADD_TOOL], executeTools: false },
      cb
    );

    expect(finalCbInfo(calls)!.turnUsage).toEqual([{ inputTokens: 80, outputTokens: 15 }]);
  });
});

// --- Per-request usage: Gemini and xAI ---
//
// Both report cache-INCLUSIVE prompt counts. Each provider request must land as its own turnUsage
// entry carrying that request's values (cached part split out), and the cache split may only happen
// on a model that publishes a cache_read rate.

interface CachedTurnUsage extends MockUsage {
  cached: number;
  /** xAI only: completion_tokens_details.reasoning_tokens, reported apart from completion_tokens. */
  reasoning?: number;
}

interface TurnUsageSpec {
  name: string;
  /** Publishes cache_read on every tier, so cached tokens are forwarded. */
  cachedModel: string;
  /** Publishes no cache_read, so cached tokens must stay in inputTokens. */
  uncachedModel: string;
  build: (stream: boolean) => { backend: ICompletionBackend; setMockSequence: (s: unknown[]) => void };
  toolTurn: (stream: boolean, id: string, args: Record<string, unknown>, usage: CachedTurnUsage) => unknown;
  textTurn: (stream: boolean, text: string, usage: CachedTurnUsage) => unknown;
  /** Visible text plus a call to an end-of-turn tool, so the loop ends without another request. */
  endTurn: (stream: boolean, id: string, text: string, usage: CachedTurnUsage) => unknown;
}

const geminiUsage = (u: CachedTurnUsage) => ({
  promptTokenCount: u.input,
  candidatesTokenCount: u.output,
  cachedContentTokenCount: u.cached,
});

const geminiTurnUsageSpec: TurnUsageSpec = {
  name: 'GeminiBackend',
  cachedModel: 'gemini-2.5-flash',
  uncachedModel: 'gemini-3-pro-preview',
  build: () => {
    const backend = new GeminiBackend('test-key');
    let calls = 0;
    let sequence: unknown[] = [];
    const next = () => {
      const response = sequence[calls++];
      if (!response) throw new Error(`No mock for call ${calls}`);
      return response;
    };
    (backend as unknown as { _api: unknown })._api = {
      models: {
        generateContentStream: async () => asyncIterable(next() as unknown[]),
        generateContent: async () => next(),
      },
    };
    return {
      backend,
      setMockSequence: s => {
        sequence = s;
        calls = 0;
      },
    };
  },
  toolTurn: (stream, _id, args, usage) => {
    const chunk = {
      candidates: [{ content: { parts: [{ functionCall: { name: 'add', args } }] } }],
      usageMetadata: geminiUsage(usage),
    };
    return stream ? [chunk] : chunk;
  },
  textTurn: (stream, text, usage) => {
    const chunk = { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: geminiUsage(usage) };
    return stream ? [chunk] : chunk;
  },
  endTurn: (stream, _id, text, usage) => {
    const chunk = {
      candidates: [{ content: { parts: [{ text }, { functionCall: { name: 'finish', args: {} } }] } }],
      usageMetadata: geminiUsage(usage),
    };
    return stream ? [chunk] : chunk;
  },
};

const xaiUsage = (u: CachedTurnUsage) => ({
  prompt_tokens: u.input,
  completion_tokens: u.output,
  total_tokens: u.input + u.output + (u.reasoning ?? 0),
  prompt_tokens_details: { cached_tokens: u.cached },
  completion_tokens_details: { reasoning_tokens: u.reasoning ?? 0 },
});

const xaiTurnUsageSpec: TurnUsageSpec = {
  name: 'XAIBackend',
  cachedModel: 'grok-4.5',
  uncachedModel: 'grok-3',
  build: stream => {
    const backend = new XAIBackend('test-key');
    let calls = 0;
    let sequence: unknown[] = [];
    (backend as unknown as { _api: unknown })._api = {
      chat: {
        completions: {
          create: async () => {
            const response = sequence[calls++];
            if (!response) throw new Error(`No mock for call ${calls}`);
            return stream ? asOpenAIStream(response as unknown[]) : response;
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
    };
  },
  toolTurn: (stream, id, args, usage) => {
    if (!stream) {
      return {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id, type: 'function', function: { name: 'add', arguments: JSON.stringify(args) } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: xaiUsage(usage),
      };
    }
    const [first, second, last] = openaiSpec.turnWithToolCall('add', id, args, usage) as Record<string, unknown>[];
    return [first, second, { ...last, usage: xaiUsage(usage) }];
  },
  textTurn: (stream, text, usage) => {
    if (!stream) {
      return {
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: xaiUsage(usage),
      };
    }
    const [first, last] = openaiSpec.turnWithText(text, usage) as Record<string, unknown>[];
    return [first, { ...last, usage: xaiUsage(usage) }];
  },
  endTurn: (stream, id, text, usage) => {
    const toolCall = { id, type: 'function', function: { name: 'finish', arguments: '{}' } };
    if (!stream) {
      return {
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text, tool_calls: [toolCall] },
            finish_reason: 'tool_calls',
          },
        ],
        usage: xaiUsage(usage),
      };
    }
    return [
      { choices: [{ index: 0, delta: { content: text }, finish_reason: null }], usage: null },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null }], usage: null },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: xaiUsage(usage) },
    ];
  },
};

const FINISH_TOOL: ICompletionOptionTools = {
  toolSchema: {
    name: 'finish',
    description: 'End the turn',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  toolFn: async () => 'ok',
  endsTurnAfterText: true,
};

/**
 * What settlement sees: cliCompletions' wrappedOnChunk keeps each field from the last emit that
 * carries it, so a terminal emit that drops turnUsage leaves an earlier, shorter breakdown in force.
 */
function latchedUsage(calls: CapturedCb[]): CompletionInfo {
  const latched: CompletionInfo = {} as CompletionInfo;
  for (const { info } of calls) {
    if (info?.inputTokens) latched.inputTokens = info.inputTokens;
    if (info?.outputTokens) latched.outputTokens = info.outputTokens;
    if (info?.cacheReadInputTokens) latched.cacheReadInputTokens = info.cacheReadInputTokens;
    if (info?.turnUsage?.length) latched.turnUsage = info.turnUsage;
  }
  return latched;
}

type PricingTier = ModelInfo['pricing'][number];

describe.each([geminiTurnUsageSpec, xaiTurnUsageSpec])('$name per-request usage', spec => {
  const runChain = async (stream: boolean, model: string, reprice?: (tier: PricingTier) => PricingTier) => {
    const { backend, setMockSequence } = spec.build(stream);
    if (reprice) {
      // Stand in for a price-catalog row: getLlmByModel hands the backend the overlaid record.
      const literal = (await backend.getModelInfo()).find(m => m.id === model)!;
      const pricing = Object.fromEntries(Object.entries(literal.pricing).map(([key, tier]) => [key, reprice(tier)]));
      backend.setDispatchModel?.({ ...literal, pricing } as ModelInfo);
    }
    setMockSequence([
      spec.toolTurn(stream, 'tool_t1', { a: 1, b: 1 }, { input: 80, output: 15, cached: 0 }),
      spec.toolTurn(stream, 'tool_t2', { a: 2, b: 2 }, { input: 150, output: 18, cached: 60 }),
      spec.textTurn(stream, 'Done.', { input: 220, output: 8, cached: 140 }),
    ]);
    const { calls, cb } = captureCb();
    await backend.complete(
      model,
      [{ role: 'user', content: 'Run two adds.' }],
      { stream, tools: [ADD_TOOL], executeTools: true },
      cb
    );
    return finalCbInfo(calls)!;
  };

  it.each([true, false])(
    'reports one entry per request with its own values, cached part split out (stream: %s)',
    async stream => {
      const final = await runChain(stream, spec.cachedModel);

      expect(final.turnUsage).toEqual([
        { inputTokens: 80, outputTokens: 15 },
        { inputTokens: 90, cacheReadInputTokens: 60, outputTokens: 18 },
        { inputTokens: 80, cacheReadInputTokens: 140, outputTokens: 8 },
      ]);
      // The aggregates are the sum of the entries.
      expect(final.inputTokens).toBe(250);
      expect(final.cacheReadInputTokens).toBe(200);
      expect(final.outputTokens).toBe(41);
    }
  );

  it.each([true, false])(
    'keeps cached tokens in inputTokens on a model with no published cache rate (stream: %s)',
    async stream => {
      const final = await runChain(stream, spec.uncachedModel);

      expect(final.turnUsage).toEqual([
        { inputTokens: 80, outputTokens: 15 },
        { inputTokens: 150, outputTokens: 18 },
        { inputTokens: 220, outputTokens: 8 },
      ]);
      expect(final.inputTokens).toBe(450);
      expect(final.cacheReadInputTokens).toBeUndefined();
      expect(final.outputTokens).toBe(41);
    }
  );

  it.each([true, false])(
    'gates on the catalog record: a row without cache_read keeps cached tokens in inputTokens (stream: %s)',
    async stream => {
      const final = await runChain(stream, spec.cachedModel, ({ cache_read: _dropped, ...tier }) => tier);

      expect(final.turnUsage).toEqual([
        { inputTokens: 80, outputTokens: 15 },
        { inputTokens: 150, outputTokens: 18 },
        { inputTokens: 220, outputTokens: 8 },
      ]);
      expect(final.inputTokens).toBe(450);
      expect(final.cacheReadInputTokens).toBeUndefined();
    }
  );

  it.each([true, false])(
    'gates on the catalog record: a row that adds cache_read splits the cached part out (stream: %s)',
    async stream => {
      const final = await runChain(stream, spec.uncachedModel, tier => ({ ...tier, cache_read: tier.input / 4 }));

      expect(final.turnUsage).toEqual([
        { inputTokens: 80, outputTokens: 15 },
        { inputTokens: 90, cacheReadInputTokens: 60, outputTokens: 18 },
        { inputTokens: 80, cacheReadInputTokens: 140, outputTokens: 8 },
      ]);
      expect(final.inputTokens).toBe(250);
      expect(final.cacheReadInputTokens).toBe(200);
    }
  );

  it.each([true, false])(
    'reports the call as a turn when tool calls are passed through (executeTools: false, stream: %s)',
    async stream => {
      const { backend, setMockSequence } = spec.build(stream);
      setMockSequence([spec.toolTurn(stream, 'tool_t1', { a: 1, b: 1 }, { input: 80, output: 15, cached: 30 })]);
      const { calls, cb } = captureCb();

      await backend.complete(
        spec.cachedModel,
        [{ role: 'user', content: 'Add.' }],
        { stream, tools: [ADD_TOOL], executeTools: false },
        cb
      );

      const final = finalCbInfo(calls)!;
      expect(final.turnUsage).toEqual([{ inputTokens: 50, cacheReadInputTokens: 30, outputTokens: 15 }]);
      expect(final.inputTokens).toBe(50);
      expect(final.cacheReadInputTokens).toBe(30);
    }
  );
});

describe.each([geminiTurnUsageSpec, xaiTurnUsageSpec])('$name per-request usage on an end-of-turn tool round', spec => {
  it.each([true, false])('lands the ending request as its own entry (stream: %s)', async stream => {
    const { backend, setMockSequence } = spec.build(stream);
    setMockSequence([
      spec.toolTurn(stream, 'tool_t1', { a: 1, b: 1 }, { input: 80, output: 15, cached: 0 }),
      spec.endTurn(stream, 'tool_t2', 'Saved.', { input: 150, output: 18, cached: 60 }),
    ]);
    const { calls, cb } = captureCb();

    await backend.complete(
      spec.cachedModel,
      [{ role: 'user', content: 'Add, then finish.' }],
      { stream, tools: [ADD_TOOL, FINISH_TOOL], executeTools: true },
      cb
    );

    const expected = [
      { inputTokens: 80, outputTokens: 15 },
      { inputTokens: 90, cacheReadInputTokens: 60, outputTokens: 18 },
    ];
    const settled = latchedUsage(calls);
    expect(settled.turnUsage).toEqual(expected);
    expect(settled.inputTokens).toBe(170);
    expect(settled.cacheReadInputTokens).toBe(60);
    expect(settled.outputTokens).toBe(33);
    // The terminal emit carries the totals itself, as on every other terminal path.
    expect(finalCbInfo(calls)!.turnUsage).toEqual(expected);
  });
});

describe('GeminiBackend cache forwarding on gemini-3.5-flash', () => {
  it.each([true, false])(
    'forwards cached tokens, which settle at $0.15/1M rather than the $1.50 input rate (stream: %s)',
    async stream => {
      const { backend, setMockSequence } = geminiTurnUsageSpec.build(stream);
      setMockSequence([
        geminiTurnUsageSpec.textTurn(stream, 'Done.', { input: 100_000, output: 2_000, cached: 80_000 }),
      ]);
      const { calls, cb } = captureCb();

      await backend.complete('gemini-3.5-flash', [{ role: 'user', content: 'Hi.' }], { stream }, cb);

      const final = finalCbInfo(calls)!;
      expect(final.turnUsage).toEqual([{ inputTokens: 20_000, cacheReadInputTokens: 80_000, outputTokens: 2_000 }]);
      const model = (await backend.getModelInfo()).find(m => m.id === 'gemini-3.5-flash')!;
      expect(getTurnsCost(model, final.turnUsage!)).toBeCloseTo(
        (20_000 * 1.5 + 80_000 * 0.15 + 2_000 * 9) / 1_000_000,
        10
      );
    }
  );
});

describe('XAIBackend per-request usage on its other terminal stream emits', () => {
  const runStream = async (chunks: unknown[], options: Record<string, unknown>) => {
    const { backend, setMockSequence } = xaiTurnUsageSpec.build(true);
    setMockSequence([chunks]);
    const { calls, cb } = captureCb();
    await backend.complete(
      xaiTurnUsageSpec.cachedModel,
      [{ role: 'user', content: 'Hi.' }],
      { stream: true, ...options },
      cb
    );
    return finalCbInfo(calls)!;
  };
  const usage = { input: 150, output: 18, cached: 60 };
  const expected = [{ inputTokens: 90, cacheReadInputTokens: 60, outputTokens: 18 }];

  it('carries turnUsage on the best-effort response_format frame', async () => {
    const final = await runStream(xaiTurnUsageSpec.textTurn(true, '{}', usage) as unknown[], {
      responseFormat: { type: 'json_schema', json_schema: { name: 'x', schema: { type: 'object' } } },
    });

    expect(final.responseFormatMode).toBe('best-effort');
    expect(final.turnUsage).toEqual(expected);
  });

  it('carries turnUsage on the frame that closes a reasoning-only reply', async () => {
    const final = await runStream(
      [
        { choices: [{ index: 0, delta: { reasoning_content: 'thinking' }, finish_reason: null }], usage: null },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: xaiUsage(usage) },
      ],
      { thinking: { enabled: true } }
    );

    expect(final.turnUsage).toEqual(expected);
  });
});

describe('XAIBackend reasoning tokens', () => {
  it.each([true, false])(
    'bills completion_tokens_details.reasoning_tokens as output on every request (stream: %s)',
    async stream => {
      const { backend, setMockSequence } = xaiTurnUsageSpec.build(stream);
      setMockSequence([
        xaiTurnUsageSpec.toolTurn(
          stream,
          'tool_t1',
          { a: 1, b: 1 },
          { input: 80, output: 15, cached: 0, reasoning: 100 }
        ),
        xaiTurnUsageSpec.textTurn(stream, 'Done.', { input: 150, output: 8, cached: 60, reasoning: 50 }),
      ]);
      const { calls, cb } = captureCb();

      await backend.complete(
        xaiTurnUsageSpec.cachedModel,
        [{ role: 'user', content: 'Add.' }],
        { stream, tools: [ADD_TOOL], executeTools: true },
        cb
      );

      const final = finalCbInfo(calls)!;
      expect(final.turnUsage).toEqual([
        { inputTokens: 80, outputTokens: 115 },
        { inputTokens: 90, cacheReadInputTokens: 60, outputTokens: 58 },
      ]);
      expect(final.outputTokens).toBe(173);
    }
  );
});

// xAI is excluded: its adapter does not report a reasoning count yet.
describe.each([anthropicSpec, openaiSpec, geminiSpec])('$name reasoning tokens', spec => {
  it('reports the native reasoning count on the terminal cb', async () => {
    const { backend, setMockSequence } = spec.build();
    setMockSequence([spec.turnWithText('Hi.', { input: 50, output: 800, reasoning: 780 })]);
    const { calls, cb } = captureCb();

    await backend.complete(spec.model, [{ role: 'user', content: 'hi' }], { stream: true, tools: [] }, cb);

    expect(finalCbInfo(calls)?.reasoningTokens).toBe(780);
    // The count is a SUBSET of output, never added to it. Gemini's adapter already folds
    // thoughtsTokenCount into its output (geminiOutputTokens), so its reported output is 800 + 780.
    expect(finalCbInfo(calls)?.outputTokens).toBe(spec.name === 'GeminiBackend' ? 1580 : 800);
  });

  it('sums the reasoning count across tool turns', async () => {
    const { backend, setMockSequence } = spec.build();
    setMockSequence([
      spec.turnWithToolCall('add', 'tool_r1', { a: 2, b: 3 }, { input: 100, output: 20, reasoning: 12 }),
      spec.turnWithText('The result is 5.', { input: 200, output: 30, reasoning: 7 }),
    ]);
    const { calls, cb } = captureCb();

    await backend.complete(
      spec.model,
      [{ role: 'user', content: 'What is 2 + 3?' }],
      { stream: true, tools: [ADD_TOOL], executeTools: true },
      cb
    );

    expect(finalCbInfo(calls)?.reasoningTokens).toBe(19);
  });

  it('keeps an earlier turn count when the terminal turn reports none', async () => {
    const { backend, setMockSequence } = spec.build();
    setMockSequence([
      spec.turnWithToolCall('add', 'tool_r2', { a: 2, b: 3 }, { input: 100, output: 20, reasoning: 12 }),
      spec.turnWithText('The result is 5.', { input: 200, output: 30 }),
    ]);
    const { calls, cb } = captureCb();

    await backend.complete(
      spec.model,
      [{ role: 'user', content: 'What is 2 + 3?' }],
      { stream: true, tools: [ADD_TOOL], executeTools: true },
      cb
    );

    expect(finalCbInfo(calls)?.reasoningTokens).toBe(12);
  });

  it('omits the field entirely when the provider reports no count', async () => {
    const { backend, setMockSequence } = spec.build();
    setMockSequence([
      spec.turnWithToolCall('add', 'tool_r3', { a: 2, b: 3 }, { input: 100, output: 20 }),
      spec.turnWithText('The result is 5.', { input: 200, output: 30 }),
    ]);
    const { calls, cb } = captureCb();

    await backend.complete(
      spec.model,
      [{ role: 'user', content: 'What is 2 + 3?' }],
      { stream: true, tools: [ADD_TOOL], executeTools: true },
      cb
    );

    for (const call of calls) {
      expect(call.info).not.toHaveProperty('reasoningTokens');
    }
  });

  it('reports the count on the executeTools: false leaf', async () => {
    // /v1/completions runs with executeTools: false by default, so the frame that ends a
    // tool-calling turn comes from this leaf - the recursion the other tests drive is skipped.
    const { backend, setMockSequence, callCount } = spec.build();
    setMockSequence([
      spec.turnWithToolCall('add', 'tool_leaf', { a: 2, b: 3 }, { input: 100, output: 20, reasoning: 12 }),
    ]);
    const { calls, cb } = captureCb();

    await backend.complete(
      spec.model,
      [{ role: 'user', content: 'Add.' }],
      { stream: true, tools: [ADD_TOOL], executeTools: false },
      cb
    );

    expect(callCount()).toBe(1);
    expect(finalCbInfo(calls)?.reasoningTokens).toBe(12);
  });
});

// ─── Non-streaming reasoning ───────────────────────────────────────
//
// `stream` defaults to true, but a caller can pass `stream: false`. The non-streaming branch
// reads usage from the full response, threads the accumulator through its own tool recursion
// (or executeTools: false leaf) and emits the total - none of which the streaming specs above
// touch. Each spec mocks the SDK's non-stream entry point, one payload per request.

interface NonStreamBackendSpec {
  name: string;
  model: string;
  build: (turns: unknown[]) => { backend: ICompletionBackend; callCount: () => number };
  toolTurn: (id: string, args: Record<string, unknown>, usage: MockUsage) => unknown;
  textTurn: (text: string, usage: MockUsage) => unknown;
  /** Visible text plus a call to an end-of-turn tool, so the loop ends without another request. */
  endTurn: (id: string, text: string, usage: MockUsage) => unknown;
}

const anthropicNonStreamSpec: NonStreamBackendSpec = {
  name: 'AnthropicBackend',
  model: 'claude-sonnet-4-5-20250929',
  build: turns => {
    const backend = new AnthropicBackend('test-key');
    let calls = 0;
    (backend as unknown as { _api: { messages: { create: () => Promise<unknown> } } })._api = {
      messages: {
        create: async () => {
          const turn = turns[calls++];
          if (!turn) throw new Error(`No mock for call ${calls}`);
          return turn;
        },
      },
    };
    return { backend, callCount: () => calls };
  },
  toolTurn: (id, args, usage) => ({
    content: [{ type: 'tool_use', id, name: 'add', input: args }],
    usage: anthropicUsage(usage),
    stop_reason: 'tool_use',
  }),
  textTurn: (text, usage) => ({
    content: [{ type: 'text', text }],
    usage: anthropicUsage(usage),
    stop_reason: 'end_turn',
  }),
  endTurn: (id, text, usage) => ({
    content: [
      { type: 'text', text },
      { type: 'tool_use', id, name: 'finish', input: {} },
    ],
    usage: anthropicUsage(usage),
    stop_reason: 'tool_use',
  }),
};

const openaiNonStreamSpec: NonStreamBackendSpec = {
  name: 'OpenAIBackend',
  model: 'gpt-4o',
  build: turns => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const backend = new OpenAIBackend({ openai: 'test-key' } as any);
    let calls = 0;
    (backend as unknown as { _api: { chat: { completions: { create: () => Promise<unknown> } } } })._api = {
      chat: {
        completions: {
          create: async () => {
            const turn = turns[calls++];
            if (!turn) throw new Error(`No mock for call ${calls}`);
            return turn;
          },
        },
      },
    };
    return { backend, callCount: () => calls };
  },
  toolTurn: (id, args, usage) => ({
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id, type: 'function', function: { name: 'add', arguments: JSON.stringify(args) } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: openaiChatUsage(usage),
  }),
  textTurn: (text, usage) => ({
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: openaiChatUsage(usage),
  }),
  endTurn: (id, text, usage) => ({
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text,
          tool_calls: [{ id, type: 'function', function: { name: 'finish', arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: openaiChatUsage(usage),
  }),
};

const geminiNonStreamSpec: NonStreamBackendSpec = {
  name: 'GeminiBackend',
  model: 'gemini-2.5-flash',
  build: turns => {
    const backend = new GeminiBackend('test-key');
    let calls = 0;
    (backend as unknown as { _api: { models: { generateContent: () => Promise<unknown> } } })._api = {
      models: {
        generateContent: async () => {
          const turn = turns[calls++];
          if (!turn) throw new Error(`No mock for call ${calls}`);
          return turn;
        },
      },
    };
    return { backend, callCount: () => calls };
  },
  toolTurn: (_id, args, usage) => ({
    candidates: [{ content: { parts: [{ functionCall: { name: 'add', args } }] } }],
    usageMetadata: geminiMockUsage(usage),
  }),
  textTurn: (text, usage) => ({
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: geminiMockUsage(usage),
  }),
  endTurn: (_id, text, usage) => ({
    candidates: [{ content: { parts: [{ text }, { functionCall: { name: 'finish', args: {} } }] } }],
    usageMetadata: geminiMockUsage(usage),
  }),
};

describe.each([anthropicNonStreamSpec, openaiNonStreamSpec, geminiNonStreamSpec])(
  '$name non-streaming reasoning',
  spec => {
    it('reports the count on a single turn', async () => {
      const { backend } = spec.build([spec.textTurn('Hi.', { input: 50, output: 30, reasoning: 22 })]);
      const { calls, cb } = captureCb();

      await backend.complete(spec.model, [{ role: 'user', content: 'hi' }], { stream: false, tools: [] }, cb);

      expect(finalCbInfo(calls)?.reasoningTokens).toBe(22);
    });

    it('sums the count across tool turns', async () => {
      const { backend, callCount } = spec.build([
        spec.toolTurn('tool_ns1', { a: 2, b: 3 }, { input: 100, output: 20, reasoning: 12 }),
        spec.textTurn('The result is 5.', { input: 200, output: 30, reasoning: 7 }),
      ]);
      const { calls, cb } = captureCb();

      await backend.complete(
        spec.model,
        [{ role: 'user', content: 'What is 2 + 3?' }],
        { stream: false, tools: [ADD_TOOL], executeTools: true },
        cb
      );

      expect(callCount()).toBe(2);
      expect(finalCbInfo(calls)?.reasoningTokens).toBe(19);
    });

    it('reports the count on the executeTools: false leaf', async () => {
      const { backend, callCount } = spec.build([
        spec.toolTurn('tool_ns2', { a: 2, b: 3 }, { input: 100, output: 20, reasoning: 12 }),
      ]);
      const { calls, cb } = captureCb();

      await backend.complete(
        spec.model,
        [{ role: 'user', content: 'Add.' }],
        { stream: false, tools: [ADD_TOOL], executeTools: false },
        cb
      );

      expect(callCount()).toBe(1);
      expect(finalCbInfo(calls)?.reasoningTokens).toBe(12);
    });
  }
);

// A round that carries answer text and calls only an end-of-turn tool ends the loop there
// (shouldEndTurnAfterTools), so that round's emit is the terminal one - a branch the
// single-turn, summed-tool-turn and executeTools: false cases above never reach.
describe.each([anthropicNonStreamSpec, openaiNonStreamSpec, geminiNonStreamSpec])(
  '$name non-streaming reasoning on an end-of-turn tool round',
  spec => {
    it('carries the count on the terminal emit', async () => {
      const { backend, callCount } = spec.build([
        spec.endTurn('tool_et1', 'The result is 5.', { input: 200, output: 30, reasoning: 12 }),
      ]);
      const { calls, cb } = captureCb();

      await backend.complete(
        spec.model,
        [{ role: 'user', content: 'Finish.' }],
        { stream: false, tools: [FINISH_TOOL], executeTools: true },
        cb
      );

      expect(callCount()).toBe(1);
      expect(finalCbInfo(calls)?.reasoningTokens).toBe(12);
    });
  }
);
