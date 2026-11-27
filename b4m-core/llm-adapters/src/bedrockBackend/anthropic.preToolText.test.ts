/**
 * The text a Bedrock Claude turn writes before calling a tool must ride the rebuilt assistant
 * turn on the next round. Dropping it means the model never sees its own preamble, restates it,
 * and the append-only reply then shows it twice. The direct Anthropic adapter replays it too
 * (see anthropicBackend.ts pushToolMessages).
 */

import { describe, it, expect } from 'vitest';
import { ModelBackend, type IMessage, type ModelInfo } from '@bike4mind/common';
import AnthropicBedrockBackend from './anthropic';
import type { ICompletionOptions, ICompletionOptionTools } from '../backend';

const MODEL = 'global.anthropic.claude-sonnet-5';

const modelRecord: ModelInfo = {
  id: MODEL,
  type: 'text',
  name: 'Claude Sonnet 5 (Bedrock)',
  backend: ModelBackend.Bedrock,
  contextWindow: 200000,
  supportsImageVariation: false,
  max_tokens: 64000,
  can_stream: true,
  can_think: true,
  pricing: { 200000: { input: 0.000003, output: 0.000015 } },
} as ModelInfo;

/** Serves one canned response per round and records each request body. */
class RecordingBedrockBackend extends AnthropicBedrockBackend {
  sentBodies: string[] = [];

  constructor(
    private readonly streamRounds: unknown[][] = [],
    private readonly jsonRounds: unknown[] = []
  ) {
    super();
  }

  protected override updateClientForModel(_model: string): void {
    // intentionally empty - no real client is needed
  }

  protected override async invokeModelStream(input: {
    modelId: string;
    contentType: string;
    accept: string;
    body: string;
  }): Promise<{ body?: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }> }> {
    const round = this.streamRounds[this.sentBodies.length] ?? [];
    this.sentBodies.push(input.body);
    return {
      body: {
        [Symbol.asyncIterator]: async function* () {
          for (const chunk of round) {
            yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(chunk)) } };
          }
        },
      },
    };
  }

  protected override async invokeModel(input: {
    modelId: string;
    contentType: string;
    accept: string;
    body: string;
  }): Promise<{ body?: Uint8Array }> {
    const round = this.jsonRounds[this.sentBodies.length];
    this.sentBodies.push(input.body);
    if (!round) throw new Error(`no canned non-streaming round ${this.sentBodies.length - 1}`);
    return { body: new TextEncoder().encode(JSON.stringify(round)) };
  }
}

const PLAN = 'Plan: 1. search the news, 2. pick the top story, 3. report it.';
const THINKING_TEXT = 'I should write a plan, then search.';
const SIGNATURE = 'ErUBCkYIBRgCIkDx0signature0payload';

type StreamEvent = Record<string, unknown>;

function toolUseEvents(index: number, id: string, name: string, json: string): StreamEvent[] {
  return [
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } },
    { type: 'content_block_stop', index },
  ];
}

function textEvents(index: number, text: string): StreamEvent[] {
  return [
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index },
  ];
}

function streamRound(blocks: StreamEvent[], stopReason: string): unknown[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 500 } } },
    ...blocks,
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 40 } },
    { type: 'message_stop' },
  ];
}

const planThenSearchRound = () =>
  streamRound([...textEvents(0, PLAN), ...toolUseEvents(1, 'toolu_search', 'web_search', '{"q":"news"}')], 'tool_use');

const synthesisRound = () => streamRound(textEvents(0, 'The top headline is X.'), 'end_turn');

const searchTool: ICompletionOptionTools = {
  toolFn: async () => 'results',
  toolSchema: {
    name: 'web_search',
    description: 'Search the web',
    parameters: { type: 'object', properties: { q: { type: 'string', description: 'Query' } } },
  },
};

const timeTool: ICompletionOptionTools = {
  toolFn: async () => '14:05',
  toolSchema: {
    name: 'get_time',
    description: 'Get the current time',
    parameters: { type: 'object', properties: {} },
  },
};

type WireBlock = { type: string; text?: string; name?: string };

/** Every assistant turn the adapter rebuilt around a tool call, in order. */
function rebuiltAssistantTurns(body: string): WireBlock[][] {
  const { messages } = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> };
  return messages
    .filter(
      m =>
        m.role === 'assistant' &&
        Array.isArray(m.content) &&
        (m.content as WireBlock[]).some(b => b.type === 'tool_use')
    )
    .map(m => m.content as WireBlock[]);
}

async function run(backend: RecordingBedrockBackend, options: Partial<ICompletionOptions>) {
  backend.setDispatchModel(modelRecord);
  const messages: IMessage[] = [{ role: 'user', content: 'Plan, search, then give me the headline.' }];
  await backend.complete(
    MODEL,
    messages,
    { tools: [searchTool], maxTokens: 64000, ...options } as Partial<ICompletionOptions>,
    async () => {}
  );
  return backend;
}

describe('Bedrock Claude replays the pre-tool text on the next tool round', () => {
  it('keeps the text ahead of the tool_use on the streaming path', async () => {
    const backend = await run(new RecordingBedrockBackend([planThenSearchRound(), synthesisRound()]), {
      stream: true,
    });

    expect(backend.sentBodies).toHaveLength(2);
    const [turn] = rebuiltAssistantTurns(backend.sentBodies[1]);
    expect(turn).toEqual([
      { type: 'text', text: PLAN },
      expect.objectContaining({ type: 'tool_use', name: 'web_search', input: { q: 'news' } }),
    ]);
  });

  it('keeps the text on the non-streaming path', async () => {
    const backend = await run(
      new RecordingBedrockBackend(
        [],
        [
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: MODEL,
            content: [
              { type: 'text', text: PLAN },
              { type: 'tool_use', id: 'toolu_search', name: 'web_search', input: { q: 'news' } },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 500, output_tokens: 40 },
          },
          {
            id: 'msg_2',
            type: 'message',
            role: 'assistant',
            model: MODEL,
            content: [{ type: 'text', text: 'The top headline is X.' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 600, output_tokens: 20 },
          },
        ]
      ),
      { stream: false }
    );

    const [turn] = rebuiltAssistantTurns(backend.sentBodies[1]);
    expect(turn).toEqual([
      { type: 'text', text: PLAN },
      expect.objectContaining({ type: 'tool_use', name: 'web_search' }),
    ]);
  });

  // Anthropic requires the signed thinking block first; the text keeps its place after it.
  it('places the text between the thinking block and the tool_use', async () => {
    const round = streamRound(
      [
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: THINKING_TEXT } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: SIGNATURE } },
        { type: 'content_block_stop', index: 0 },
        ...textEvents(1, PLAN),
        ...toolUseEvents(2, 'toolu_search', 'web_search', '{"q":"news"}'),
      ],
      'tool_use'
    );
    const backend = await run(new RecordingBedrockBackend([round, synthesisRound()]), {
      stream: true,
      thinking: { enabled: true, budget_tokens: 2000 },
    });

    const [turn] = rebuiltAssistantTurns(backend.sentBodies[1]);
    expect(turn.map(b => b.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(turn[1]).toEqual({ type: 'text', text: PLAN });
  });

  // A parallel round becomes one synthetic turn per tool; repeating the text on each would
  // show the model its preamble twice, the very thing this replay prevents.
  it('puts the text on the first turn of a parallel round only', async () => {
    const round = streamRound(
      [
        ...textEvents(0, PLAN),
        ...toolUseEvents(1, 'toolu_search', 'web_search', '{"q":"news"}'),
        ...toolUseEvents(2, 'toolu_time', 'get_time', '{}'),
      ],
      'tool_use'
    );
    const backend = await run(new RecordingBedrockBackend([round, synthesisRound()]), {
      stream: true,
      tools: [searchTool, timeTool],
    });

    const turns = rebuiltAssistantTurns(backend.sentBodies[1]);
    expect(turns.map(t => t.map(b => b.type))).toEqual([['text', 'tool_use'], ['tool_use']]);
    expect(turns[0][0]).toEqual({ type: 'text', text: PLAN });
  });

  it('adds no text block when the turn wrote only whitespace', async () => {
    const round = streamRound(
      [...textEvents(0, '\n\n'), ...toolUseEvents(1, 'toolu_search', 'web_search', '{"q":"news"}')],
      'tool_use'
    );
    const backend = await run(new RecordingBedrockBackend([round, synthesisRound()]), { stream: true });

    const [turn] = rebuiltAssistantTurns(backend.sentBodies[1]);
    expect(turn.map(b => b.type)).toEqual(['tool_use']);
  });
});
