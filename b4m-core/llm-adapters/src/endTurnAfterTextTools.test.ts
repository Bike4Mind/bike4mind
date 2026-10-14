/**
 * A round that already streamed its answer and called only `endsTurnAfterText` tools must end the
 * turn instead of making the follow-up model call (which would restate the answer). Driven per
 * backend through the real tool loop with a mocked SDK; the harness mirrors
 * toolResultRecording.test.ts. Decision logic itself: shouldEndTurnAfterTools in
 * executeToolsBatch.test.ts.
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

interface MockUsage {
  input: number;
  output: number;
}

interface CapturedCb {
  text: (string | null | undefined)[];
  info?: CompletionInfo;
}

type ToolCall = { name: string; id: string; args: Record<string, unknown> };

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

function captureCb() {
  const calls: CapturedCb[] = [];
  return {
    calls,
    cb: async (text: (string | null | undefined)[], info?: CompletionInfo) => {
      calls.push({ text, info });
    },
  };
}

/** Everything the caller would render as answer text (reasoning channel excluded). */
function answerText(calls: CapturedCb[]): string {
  return calls
    .filter(call => call.info?.channel !== 'reasoning')
    .flatMap(call => call.text)
    .filter((chunk): chunk is string => typeof chunk === 'string')
    .join('');
}

function lastTokenInfo(calls: CapturedCb[]): CompletionInfo | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    const info = calls[i].info;
    if (info?.inputTokens || info?.outputTokens) return info;
  }
  return undefined;
}

const SUGGEST_RESULT = 'Buttons shown.';
const ANSWER = 'Here is the full answer.';

function makeTool(name: string, endsTurnAfterText: boolean, result: string): ICompletionOptionTools {
  return {
    toolSchema: {
      name,
      description: `${name} tool`,
      parameters: { type: 'object', properties: { target: { type: 'string', description: 'target' } } },
    },
    toolFn: async () => result,
    ...(endsTurnAfterText ? { endsTurnAfterText: true } : {}),
  };
}

const suggestTool = makeTool('suggest_links', true, SUGGEST_RESULT);
const lookupTool = makeTool('lookup', false, 'lookup result');

interface BackendSpec {
  name: string;
  model: string;
  build: () => { backend: ICompletionBackend; apiCallCount: () => number; setMockSequence: (s: unknown[][]) => void };
  /** One round: optional answer text followed by the given tool calls. */
  round: (text: string, toolCalls: ToolCall[], usage: MockUsage) => unknown[];
}

function openAICompatibleBuild(make: () => ICompletionBackend) {
  return () => {
    const backend = make();
    let calls = 0;
    let sequence: unknown[][] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial SDK client mock
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
    return { backend, apiCallCount: () => calls, setMockSequence: (s: unknown[][]) => (sequence = s) };
  };
}

const openAICompatibleRound = (text: string, toolCalls: ToolCall[], usage: MockUsage): unknown[] => [
  ...(text ? [{ choices: [{ index: 0, delta: { content: text }, finish_reason: null }], usage: null }] : []),
  ...(toolCalls.length
    ? [
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: toolCalls.map((call, index) => ({
                  index,
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                })),
              },
              finish_reason: null,
            },
          ],
          usage: null,
        },
      ]
    : []),
  {
    choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
  },
];

const anthropicSpec: BackendSpec = {
  name: 'AnthropicBackend',
  model: 'claude-sonnet-4-5-20250929',
  build: () => {
    const backend = new AnthropicBackend('test-key');
    let calls = 0;
    let sequence: unknown[][] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial SDK client mock
    (backend as unknown as { _api: any })._api = {
      messages: {
        create: async () => {
          const events = sequence[calls++];
          if (!events) throw new Error(`No mock for call ${calls}`);
          return asyncIterable(events);
        },
      },
    };
    return { backend, apiCallCount: () => calls, setMockSequence: s => (sequence = s) };
  },
  round: (text, toolCalls, usage) => {
    const textBlocks = text
      ? [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
          { type: 'content_block_stop', index: 0 },
        ]
      : [];
    const offset = text ? 1 : 0;
    const toolBlocks = toolCalls.flatMap((call, i) => [
      {
        type: 'content_block_start',
        index: i + offset,
        content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
      },
      {
        type: 'content_block_delta',
        index: i + offset,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args) },
      },
      { type: 'content_block_stop', index: i + offset },
    ]);
    return [
      { type: 'message_start' },
      ...textBlocks,
      ...toolBlocks,
      {
        type: 'message_delta',
        delta: { stop_reason: toolCalls.length ? 'tool_use' : 'end_turn' },
        usage: { input_tokens: usage.input, output_tokens: usage.output },
      },
      { type: 'message_stop' },
    ];
  },
};

const openaiSpec: BackendSpec = {
  name: 'OpenAIBackend',
  model: 'gpt-4o',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- constructor takes a key bag
  build: openAICompatibleBuild(() => new OpenAIBackend({ openai: 'test-key' } as any)),
  round: openAICompatibleRound,
};

const xaiSpec: BackendSpec = {
  name: 'XAIBackend',
  model: 'grok-3',
  build: openAICompatibleBuild(() => new XAIBackend('test-key')),
  round: openAICompatibleRound,
};

const kimiSpec: BackendSpec = {
  name: 'KimiBackend',
  model: 'kimi-k2',
  build: openAICompatibleBuild(() => new KimiBackend('test-key')),
  round: openAICompatibleRound,
};

const geminiSpec: BackendSpec = {
  name: 'GeminiBackend',
  model: 'gemini-2.5-flash',
  build: () => {
    const backend = new GeminiBackend('test-key');
    let calls = 0;
    let sequence: unknown[][] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial SDK client mock
    (backend as unknown as { _api: any })._api = {
      models: {
        generateContentStream: async () => {
          const events = sequence[calls++];
          if (!events) throw new Error(`No mock for call ${calls}`);
          return asyncIterable(events);
        },
      },
    };
    return { backend, apiCallCount: () => calls, setMockSequence: s => (sequence = s) };
  },
  round: (text, toolCalls, usage) => [
    {
      candidates: [
        {
          content: {
            parts: [
              ...(text ? [{ text }] : []),
              ...toolCalls.map(call => ({ functionCall: { name: call.name, args: call.args } })),
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: usage.input, candidatesTokenCount: usage.output },
    },
  ],
};

const SPECS: BackendSpec[] = [anthropicSpec, openaiSpec, xaiSpec, kimiSpec, geminiSpec];

describe.each(SPECS)('$name end-of-turn tools', spec => {
  async function run(sequence: unknown[][], tools: ICompletionOptionTools[]) {
    const { backend, apiCallCount, setMockSequence } = spec.build();
    setMockSequence(sequence);
    const { calls, cb } = captureCb();
    const messages = [{ role: 'user' as const, content: 'question' }];
    await backend.complete(spec.model, messages, { stream: true, tools, executeTools: true }, cb);
    return { calls, apiCallCount: apiCallCount(), messages };
  }

  it('ends the turn after answer text plus a lone flagged tool call', async () => {
    const { calls, apiCallCount, messages } = await run(
      [
        spec.round(ANSWER, [{ name: 'suggest_links', id: 'call_nav', args: { target: 'x' } }], {
          input: 10,
          output: 5,
        }),
        spec.round('The answer again.', [], { input: 20, output: 7 }),
      ],
      [suggestTool, lookupTool]
    );

    expect(apiCallCount).toBe(1);
    expect(answerText(calls)).toBe(ANSWER);
    const terminal = lastTokenInfo(calls);
    expect(terminal?.inputTokens).toBe(10);
    expect(terminal?.outputTokens).toBe(5);
    expect(terminal?.toolsUsed?.map(tool => tool.name)).toEqual(['suggest_links']);
    // The tool call and its result stay in history so the next user turn sees a paired call.
    const history = JSON.stringify(messages);
    expect(history).toContain('suggest_links');
    expect(history).toContain(SUGGEST_RESULT);
  });

  it('still recurses when the batch includes an unflagged tool', async () => {
    const { calls, apiCallCount } = await run(
      [
        spec.round(
          ANSWER,
          [
            { name: 'suggest_links', id: 'call_nav', args: { target: 'x' } },
            { name: 'lookup', id: 'call_lookup', args: { target: 'y' } },
          ],
          { input: 10, output: 5 }
        ),
        spec.round(' Follow-up.', [], { input: 20, output: 7 }),
      ],
      [suggestTool, lookupTool]
    );

    expect(apiCallCount).toBe(2);
    expect(answerText(calls)).toContain('Follow-up.');
    expect(lastTokenInfo(calls)?.inputTokens).toBe(30);
  });

  it('still recurses when the flagged tool was called without any answer text', async () => {
    const { calls, apiCallCount } = await run(
      [
        spec.round('', [{ name: 'suggest_links', id: 'call_nav', args: { target: 'x' } }], { input: 10, output: 5 }),
        spec.round(ANSWER, [], { input: 20, output: 7 }),
      ],
      [suggestTool]
    );

    expect(apiCallCount).toBe(2);
    expect(answerText(calls)).toContain(ANSWER);
  });
});

describe('AnthropicBackend end-of-turn tools (non-streaming)', () => {
  it('ends the turn after answer text plus a lone flagged tool call', async () => {
    const backend = new AnthropicBackend('test-key');
    let apiCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial SDK client mock
    (backend as unknown as { _api: any })._api = {
      messages: {
        create: async () => {
          apiCalls += 1;
          if (apiCalls > 1) return { content: [{ type: 'text', text: 'The answer again.' }], usage: {} };
          return {
            content: [
              { type: 'text', text: ANSWER },
              { type: 'tool_use', id: 'call_nav', name: 'suggest_links', input: { target: 'x' } },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      },
    };
    const { calls, cb } = captureCb();
    const messages = [{ role: 'user' as const, content: 'question' }];

    await backend.complete(anthropicSpec.model, messages, { stream: false, tools: [suggestTool] }, cb);

    expect(apiCalls).toBe(1);
    expect(answerText(calls)).toBe(ANSWER);
    expect(lastTokenInfo(calls)?.inputTokens).toBe(10);
    expect(JSON.stringify(messages)).toContain(SUGGEST_RESULT);
  });
});
