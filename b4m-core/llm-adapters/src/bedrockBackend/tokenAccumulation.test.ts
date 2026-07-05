/**
 * Regression test for multi-turn token accumulation in BaseBedrockBackend.
 *
 * Bedrock's recursion path mirrors the other backends: each tool round-trip
 * is a separate InvokeModel call billed independently, but the recursive
 * complete() call doesn't currently thread an accumulator through _internal.
 * The result is that cliCompletions' assign-not-add wrappedOnChunk only sees
 * the terminal turn's tokens - turns 1..N-1 are silently dropped.
 *
 * Bedrock has a different SDK shape (BedrockRuntimeClient + per-subclass
 * translateStreamChunk) so it lives in its own test file rather than the
 * parameterized tokenAccumulation.test.ts. We sidestep the
 * subclass-specific stream chunk format by defining a TestBedrockBackend
 * whose translateStreamChunk passes through pre-shaped ICompletionResponseChunk
 * objects directly.
 */

import { describe, it, expect } from 'vitest';
import type { ChatModels, IMessage, ModelInfo } from '@bike4mind/common';
import type { CompletionInfo } from '@bike4mind/common';
import { BaseBedrockBackend } from './base';
import {
  ChoiceEndReason,
  ChoiceStatus,
  type IChoiceEndToolUse,
  type ICompletionOptionTools,
  type ICompletionOptions,
  type ICompletionResponseChunk,
} from '../backend';

// ─── Test subclass ─────────────────────────────────────────────────
//
// Implements the abstract methods minimally. translateStreamChunk treats
// the bytes as an already-shaped ICompletionResponseChunk so we can author
// chunks directly in tests.

class TestBedrockBackend extends BaseBedrockBackend {
  // No-op: BaseBedrockBackend.updateClientForModel rebuilds the AWS client
  // at the start of every complete(), which would clobber the mock injected
  // via _bedrockRuntime in the test. Skip the rebuild so our mock survives.
  protected override updateClientForModel(_model: string): void {
    // intentionally empty
  }

  async getModelInfo(): Promise<ModelInfo[]> {
    return [];
  }

  formatMessages(messages: IMessage[]): IMessage[] {
    return messages;
  }

  getPayload(): { modelId: string; contentType: string; accept: string; body: string } {
    return { modelId: 'test', contentType: 'application/json', accept: 'application/json', body: '{}' };
  }

  // Mocks emit objects that are already in ICompletionResponseChunk shape;
  // pass them through directly.
  translateStreamChunk(_model: string, json: unknown): { done: boolean; chunk?: ICompletionResponseChunk } {
    return { done: false, chunk: json as ICompletionResponseChunk };
  }

  translateChunk(_model: string, json: unknown): { done: boolean; chunk?: ICompletionResponseChunk } {
    return { done: true, chunk: json as ICompletionResponseChunk };
  }

  pushToolMessages(messages: IMessage[], tool: IChoiceEndToolUse['tool'], result: string): void {
    messages.push({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: tool.id,
          name: tool.name,
          input: JSON.parse(tool.parameters || '{}'),
        },
      ],
    } as IMessage);
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: tool.id,
          content: result,
        },
      ],
    } as IMessage);
  }
}

// ─── Mock Bedrock runtime ──────────────────────────────────────────

interface MockUsage {
  input: number;
  output: number;
}

interface CapturedCb {
  text: (string | null | undefined)[];
  info?: CompletionInfo;
}

/**
 * Build a Bedrock response body that yields the supplied chunks. Each chunk
 * is JSON-encoded into the `bytes` field that the base class decodes.
 */
function asBedrockBody(chunks: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) {
        yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(c)) } };
      }
    },
  };
}

function makeBackend(streamSequence: unknown[][]): {
  backend: TestBedrockBackend;
  callCount: () => number;
} {
  const backend = new TestBedrockBackend();
  let calls = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
    send: async (_command: unknown, _opts?: unknown) => {
      const chunks = streamSequence[calls++];
      if (!chunks) throw new Error(`Mock has no body for call ${calls}`);
      return { body: asBedrockBody(chunks) };
    },
  };
  return { backend, callCount: () => calls };
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
 * Returns the info from the *very last* cb call. Use to assert that the
 * terminal cb itself carries the running total - catches a backend that
 * emits the right total on an intermediate cb but 0 on the final cb.
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

// ─── Chunk fixtures ────────────────────────────────────────────────
//
// BaseBedrockBackend's stream loop reads choice.tool, choice.chunkText,
// choice.statusEndReason, and choice.usage. These directly match
// ICompletionResponseChunk's IChoice shape.

/**
 * Tool turn - split across three chunks:
 *  1. tool_use start (registers name + id)
 *  2. parameters delta as chunkText
 *  3. usage in the final chunk
 *
 * Split prevents the parameter-doubling that would happen if `tool` and
 * `chunkText` arrived in the same chunk (see base.ts:178-179: ??= followed
 * by += writes chunkText twice on first assignment).
 */
function turnWithToolCall(
  toolName: string,
  toolId: string,
  args: Record<string, unknown>,
  usage: MockUsage
): unknown[] {
  return [
    // Register tool name/id; no chunkText so parameters initialize to ''.
    {
      choices: [
        {
          index: 0,
          status: ChoiceStatus.STREAM,
          tool: { name: toolName, id: toolId },
        },
      ],
    },
    // Append the parameters JSON via chunkText.
    {
      choices: [
        {
          index: 0,
          status: ChoiceStatus.STREAM,
          chunkText: JSON.stringify(args),
        },
      ],
    },
    // Final chunk carries usage.
    {
      choices: [
        {
          index: 0,
          status: ChoiceStatus.END,
          statusEndReason: ChoiceEndReason.STOP,
          usage: { input_tokens: usage.input, output_tokens: usage.output },
        },
      ],
    },
  ];
}

function turnWithText(text: string, usage: MockUsage): unknown[] {
  return [
    {
      choices: [
        {
          index: 0,
          status: ChoiceStatus.STREAM,
          chunkText: text,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          status: ChoiceStatus.END,
          statusEndReason: ChoiceEndReason.STOP,
          usage: { input_tokens: usage.input, output_tokens: usage.output },
        },
      ],
    },
  ];
}

const TEST_MODEL = 'test-model' as ChatModels;

// ─── Tests ─────────────────────────────────────────────────────────

describe('BaseBedrockBackend single-turn token reporting', () => {
  it('emits real input/output tokens on the per-chunk cb', async () => {
    const { backend } = makeBackend([turnWithText('Hello, world.', { input: 50, output: 5 })]);
    const { calls, cb } = captureCb();

    await backend.complete(
      TEST_MODEL,
      [{ role: 'user', content: 'hi' }],
      { stream: true, tools: [] } as Partial<ICompletionOptions>,
      cb
    );

    const final = lastTokenEmit(calls);
    expect(final).toBeDefined();
    expect(final!.inputTokens).toBe(50);
    expect(final!.outputTokens).toBe(5);
    const lastCb = finalCbInfo(calls);
    expect(lastCb).toBeDefined();
    expect(lastCb!.inputTokens).toBe(50);
    expect(lastCb!.outputTokens).toBe(5);
  });
});

describe('BaseBedrockBackend multi-turn token accumulation (executeTools=true)', () => {
  it('terminal cb sees the sum of input/output tokens across the tool round-trip', async () => {
    const { backend, callCount } = makeBackend([
      turnWithToolCall('add', 'tool_test_01', { a: 2, b: 3 }, { input: 100, output: 20 }),
      turnWithText('The result is 5.', { input: 200, output: 30 }),
    ]);
    const { calls, cb } = captureCb();

    await backend.complete(
      TEST_MODEL,
      [{ role: 'user', content: 'What is 2 + 3?' }],
      { stream: true, tools: [ADD_TOOL], executeTools: true } as Partial<ICompletionOptions>,
      cb
    );

    expect(callCount()).toBe(2);
    const final = lastTokenEmit(calls);
    expect(final).toBeDefined();
    expect(final!.inputTokens).toBe(300); // 100 + 200
    expect(final!.outputTokens).toBe(50); // 20 + 30
    const lastCb = finalCbInfo(calls);
    expect(lastCb).toBeDefined();
    expect(lastCb!.inputTokens).toBe(300);
    expect(lastCb!.outputTokens).toBe(50);
  });

  it('three-turn tool chain accumulates across all three turns', async () => {
    const { backend, callCount } = makeBackend([
      turnWithToolCall('add', 'tool_t1', { a: 1, b: 1 }, { input: 80, output: 15 }),
      turnWithToolCall('add', 'tool_t2', { a: 2, b: 2 }, { input: 150, output: 18 }),
      turnWithText('Done.', { input: 220, output: 8 }),
    ]);
    const { calls, cb } = captureCb();

    await backend.complete(
      TEST_MODEL,
      [{ role: 'user', content: 'Run two adds.' }],
      { stream: true, tools: [ADD_TOOL], executeTools: true } as Partial<ICompletionOptions>,
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
