/**
 * Text a model streams ahead of its tool calls must be on the assistant message the next round
 * sends back. Without it the model never sees its own preamble and restates it, and the
 * append-only reply accumulator then holds the text twice. Driven per backend through the real
 * tool loop with a mocked SDK, capturing the SECOND request. Harness mirrors
 * endTurnAfterTextTools.test.ts; the message helper itself: replayPreToolText.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { Stream } from 'openai/streaming';
import { ChatModels } from '@bike4mind/common';
import type { CompletionInfo } from '@bike4mind/common';
import type { ICompletionBackend, ICompletionOptionTools } from './backend';
import { AnthropicBackend } from './anthropicBackend';
import { DeepSeekBackend } from './deepseekBackend';
import { KimiBackend } from './kimiBackend';
import { OpenAIBackend } from './openaiBackend';
import { XAIBackend } from './xaiBackend';

type ToolCall = { name: string; id: string; args: Record<string, unknown> };
type RequestMessage = { role: string; content?: unknown; tool_calls?: unknown[] };

const PLAN = 'Plan: look it up, then answer.';

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

const lookupTool: ICompletionOptionTools = {
  toolSchema: {
    name: 'lookup',
    description: 'lookup tool',
    parameters: { type: 'object', properties: { target: { type: 'string', description: 'target' } } },
  },
  toolFn: async () => 'lookup result',
};

const openAIRound = (text: string, toolCalls: ToolCall[]): unknown[] => [
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
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  },
];

const anthropicRound = (text: string, toolCalls: ToolCall[]): unknown[] => {
  const offset = text ? 1 : 0;
  return [
    { type: 'message_start' },
    ...(text
      ? [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
          { type: 'content_block_stop', index: 0 },
        ]
      : []),
    ...toolCalls.flatMap((call, i) => [
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
    ]),
    {
      delta: { stop_reason: toolCalls.length ? 'tool_use' : 'end_turn' },
      type: 'message_delta',
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    { type: 'message_stop' },
  ];
};

interface Harness {
  backend: ICompletionBackend;
  requests: RequestMessage[][];
  setSequence: (s: unknown[][]) => void;
}

function openAIHarness(backend: ICompletionBackend): Harness {
  const requests: RequestMessage[][] = [];
  let sequence: unknown[][] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial SDK client mock
  (backend as unknown as { _api: any })._api = {
    chat: {
      completions: {
        create: async (params: { messages: RequestMessage[] }) => {
          requests.push(JSON.parse(JSON.stringify(params.messages)));
          const events = sequence[requests.length - 1];
          if (!events) throw new Error(`No mock for call ${requests.length}`);
          return asOpenAIStream(events);
        },
      },
    },
  };
  return { backend, requests, setSequence: s => (sequence = s) };
}

function anthropicHarness(): Harness {
  const backend = new AnthropicBackend('test-key');
  const requests: RequestMessage[][] = [];
  let sequence: unknown[][] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial SDK client mock
  (backend as unknown as { _api: any })._api = {
    messages: {
      create: async (params: { messages: RequestMessage[] }) => {
        requests.push(JSON.parse(JSON.stringify(params.messages)));
        const events = sequence[requests.length - 1];
        if (!events) throw new Error(`No mock for call ${requests.length}`);
        return asyncIterable(events);
      },
    },
  };
  return { backend, requests, setSequence: s => (sequence = s) };
}

interface Spec {
  name: string;
  model: string;
  build: () => Harness;
  round: (text: string, toolCalls: ToolCall[]) => unknown[];
  /** The text carried by an assistant message of the request, whatever shape the provider uses. */
  textOf: (message: RequestMessage) => string;
}

const openAIText = (message: RequestMessage) => (typeof message.content === 'string' ? message.content : '');
const anthropicText = (message: RequestMessage) =>
  Array.isArray(message.content)
    ? (message.content as { type: string; text?: string }[])
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('')
    : '';

const SPECS: Spec[] = [
  {
    name: 'AnthropicBackend',
    model: 'claude-sonnet-4-5-20250929',
    build: anthropicHarness,
    round: anthropicRound,
    textOf: anthropicText,
  },
  {
    name: 'OpenAIBackend',
    model: 'gpt-4o',

    build: () => openAIHarness(new OpenAIBackend('test-key')),
    round: openAIRound,
    textOf: openAIText,
  },
  {
    name: 'XAIBackend',
    model: 'grok-3',
    build: () => openAIHarness(new XAIBackend('test-key')),
    round: openAIRound,
    textOf: openAIText,
  },
  {
    name: 'KimiBackend',
    model: 'kimi-k2',
    build: () => openAIHarness(new KimiBackend('test-key')),
    round: openAIRound,
    textOf: openAIText,
  },
  {
    name: 'DeepSeekBackend',
    model: ChatModels.DEEPSEEK_FLASH,
    build: () => openAIHarness(new DeepSeekBackend('test-key')),
    round: openAIRound,
    textOf: openAIText,
  },
];

const isToolCallTurn = (message: RequestMessage) =>
  message.role === 'assistant' &&
  (Array.isArray(message.tool_calls) ||
    (Array.isArray(message.content) && (message.content as { type: string }[]).some(b => b.type === 'tool_use')));

describe.each(SPECS)('$name pre-tool text replay', spec => {
  async function secondRequest(round1: unknown[]) {
    const { backend, requests, setSequence } = spec.build();
    setSequence([round1, spec.round('Final answer.', [])]);
    const info: CompletionInfo[] = [];
    await backend.complete(
      spec.model,
      [{ role: 'user', content: 'question' }],
      { stream: true, tools: [lookupTool], executeTools: true },
      async (_text, completion) => {
        if (completion) info.push(completion);
      }
    );
    expect(requests).toHaveLength(2);
    return requests[1];
  }

  it('sends the text streamed ahead of a tool call back on the assistant message', async () => {
    const request = await secondRequest(spec.round(PLAN, [{ name: 'lookup', id: 'call_1', args: { target: 'x' } }]));

    const toolTurns = request.filter(isToolCallTurn);
    expect(toolTurns).toHaveLength(1);
    expect(spec.textOf(toolTurns[0])).toBe(PLAN);
  });

  it('puts the text on one assistant message when the round calls several tools', async () => {
    const request = await secondRequest(
      spec.round(PLAN, [
        { name: 'lookup', id: 'call_1', args: { target: 'x' } },
        { name: 'lookup', id: 'call_2', args: { target: 'y' } },
      ])
    );

    const toolTurns = request.filter(isToolCallTurn);
    expect(toolTurns.length).toBeGreaterThanOrEqual(1);
    expect(toolTurns.map(spec.textOf).filter(Boolean)).toEqual([PLAN]);
  });

  it('adds no text when the round called a tool without writing any', async () => {
    const request = await secondRequest(spec.round('', [{ name: 'lookup', id: 'call_1', args: { target: 'x' } }]));

    const toolTurns = request.filter(isToolCallTurn);
    expect(toolTurns).toHaveLength(1);
    expect(spec.textOf(toolTurns[0])).toBe('');
  });
});

describe('OpenAIBackend non-streaming pre-tool text', () => {
  it('does not replay text the non-streaming path never forwarded to the user', async () => {
    const backend = new OpenAIBackend('test-key');
    const requests: RequestMessage[][] = [];
    const message = (content: string, withTool: boolean) => ({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
            ...(withTool
              ? {
                  tool_calls: [
                    { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"target":"x"}' } },
                  ],
                }
              : {}),
          },
          finish_reason: withTool ? 'tool_calls' : 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial SDK client mock
    (backend as unknown as { _api: any })._api = {
      chat: {
        completions: {
          create: async (params: { messages: RequestMessage[] }) => {
            requests.push(JSON.parse(JSON.stringify(params.messages)));
            return requests.length === 1 ? message(PLAN, true) : message('Final answer.', false);
          },
        },
      },
    };

    await backend.complete(
      'gpt-4o',
      [{ role: 'user', content: 'question' }],
      { stream: false, tools: [lookupTool], executeTools: true },
      async () => {}
    );

    expect(requests).toHaveLength(2);
    const toolTurns = requests[1].filter(isToolCallTurn);
    expect(toolTurns).toHaveLength(1);
    expect(toolTurns[0].content).toBeNull();
  });
});

describe('AnthropicBackend pre-tool text ordering', () => {
  it('replays only the text written before the first tool call, never text that followed it', async () => {
    const { backend, requests, setSequence } = anthropicHarness();
    const textBlock = (index: number, text: string) => [
      { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index },
    ];
    setSequence([
      [
        { type: 'message_start' },
        ...textBlock(0, PLAN),
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify({ target: 'x' }) },
        },
        { type: 'content_block_stop', index: 1 },
        ...textBlock(2, 'Trailing note.'),
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        { type: 'message_stop' },
      ],
      anthropicRound('Final answer.', []),
    ]);

    await backend.complete(
      'claude-sonnet-4-5-20250929',
      [{ role: 'user', content: 'question' }],
      { stream: true, tools: [lookupTool], executeTools: true },
      async () => {}
    );

    const toolTurns = requests[1].filter(isToolCallTurn);
    expect(toolTurns).toHaveLength(1);
    expect(anthropicText(toolTurns[0])).toBe(PLAN);
  });
});
