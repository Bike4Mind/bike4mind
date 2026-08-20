/**
 * Regression test: signed thinking blocks must survive a Bedrock tool continuation.
 *
 * An adaptive Claude (Opus 5 class) reasons on every turn whether or not the request
 * declares thinking. Anthropic requires those thinking blocks be replayed unmodified -
 * signature included - in the assistant message that carries `tool_use`. The Bedrock
 * adapter used to rebuild that message as `[tool_use]` alone, so the synthesis round of
 * a multi-round tool turn came back with no text and no tool call and tripped the
 * fail-loud EMPTY-response guard in base.ts.
 *
 * Asserted against the real request bodies the backend sends, over both transports
 * (streaming and non-streaming are separate commands, translators and tool loops):
 *  - a thinking turn's blocks (with signature) lead the rebuilt assistant turn;
 *  - a parallel round attaches them to every turn it rebuilds, not just the first;
 *  - a non-thinking turn is byte-identical to before - exactly `[tool_use]`.
 */

import { describe, it, expect } from 'vitest';
import { ModelBackend, type IMessage, type ModelInfo } from '@bike4mind/common';
import AnthropicBedrockBackend from './anthropic';
import type { ICompletionOptions, ICompletionOptionTools } from '../backend';

/** The failing model from the report: adaptive, and known only to the catalog. */
const ADAPTIVE_MODEL = 'us.anthropic.claude-opus-5';

const adaptiveRecord: ModelInfo = {
  id: ADAPTIVE_MODEL,
  type: 'text',
  name: 'Claude Opus 5 (Bedrock)',
  backend: ModelBackend.Bedrock,
  contextWindow: 200000,
  supportsImageVariation: false,
  max_tokens: 64000,
  can_stream: true,
  can_think: true,
  thinkingStyle: 'adaptive',
  pricing: { 200000: { input: 0.000005, output: 0.000025 } },
} as ModelInfo;

/**
 * Serves one canned raw-Bedrock response per round and records the request body of each,
 * which is what the assertions read. `updateClientForModel` is neutered so no
 * BedrockRuntimeClient (or credential lookup) is built.
 *
 * Streaming and non-streaming are separate Bedrock commands behind separate seams, so
 * both are stubbed: `streamRounds` are event lists, `jsonRounds` whole response bodies.
 */
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

const THINKING_TEXT = 'The user wants weather, so I should call get_weather.';
const SIGNATURE = 'ErUBCkYIBRgCIkDx0signature0payload';

/** A turn that reasons, signs the reasoning, then calls a tool. */
function thinkingToolRound(): unknown[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 110000 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: THINKING_TEXT } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: SIGNATURE } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_round1', name: 'get_weather' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"location":"Paris"}' },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 900 } },
    { type: 'message_stop' },
  ];
}

/** One reasoning block, then two tool calls - the parallel-round shape. */
function thinkingParallelToolRound(): unknown[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 110000 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: THINKING_TEXT } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: SIGNATURE } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_weather', name: 'get_weather' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"location":"Paris"}' },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 'toolu_time', name: 'get_time' },
    },
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"timezone":"Europe/Paris"}' },
    },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 900 } },
    { type: 'message_stop' },
  ];
}

/** The same turn from a model that does not reason: no thinking block at all. */
function plainToolRound(): unknown[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 500 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_round1', name: 'get_weather' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"location":"Paris"}' },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } },
    { type: 'message_stop' },
  ];
}

/** The synthesis round: plain prose, which is what the bug suppressed. */
function synthesisRound(): unknown[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 111000 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'It is sunny in Paris.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 60 } },
    { type: 'message_stop' },
  ];
}

/**
 * The non-streaming shapes of the same two rounds. `invokeModel` returns one whole JSON
 * body rather than an event stream, so `translateChunk` collects the reasoning blocks
 * from `response.content` instead of accumulating them delta by delta.
 */
function thinkingToolResponse(): unknown {
  return {
    id: 'msg_round1',
    type: 'message',
    role: 'assistant',
    model: ADAPTIVE_MODEL,
    content: [
      { type: 'thinking', thinking: THINKING_TEXT, signature: SIGNATURE },
      { type: 'tool_use', id: 'toolu_round1', name: 'get_weather', input: { location: 'Paris' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 110000, output_tokens: 900 },
  };
}

function synthesisResponse(): unknown {
  return {
    id: 'msg_round2',
    type: 'message',
    role: 'assistant',
    model: ADAPTIVE_MODEL,
    content: [{ type: 'text', text: 'It is sunny in Paris.' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 111000, output_tokens: 60 },
  };
}

const weatherTool: ICompletionOptionTools = {
  toolFn: async () => 'sunny, 24C',
  toolSchema: {
    name: 'get_weather',
    description: 'Get the current weather',
    parameters: { type: 'object', properties: { location: { type: 'string', description: 'City' } } },
  },
};

const timeTool: ICompletionOptionTools = {
  toolFn: async () => '14:05',
  toolSchema: {
    name: 'get_time',
    description: 'Get the current local time',
    parameters: { type: 'object', properties: { timezone: { type: 'string', description: 'IANA zone' } } },
  },
};

const tools: ICompletionOptionTools[] = [weatherTool];

type WireBlock = { type: string; thinking?: string; signature?: string; data?: string };

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

/** The content of the assistant turn the adapter rebuilt around the tool call. */
function rebuiltAssistantContent(body: string): WireBlock[] {
  const [first] = rebuiltAssistantTurns(body);
  if (!first) throw new Error('continuation payload carries no rebuilt assistant tool_use turn');
  return first;
}

async function run(backend: RecordingBedrockBackend, options: Partial<ICompletionOptions>) {
  backend.setDispatchModel(adaptiveRecord);
  const messages: IMessage[] = [{ role: 'user', content: 'What is the weather in Paris?' }];
  const emitted: string[] = [];

  await backend.complete(
    ADAPTIVE_MODEL,
    messages,
    { tools, maxTokens: 64000, ...options } as Partial<ICompletionOptions>,
    async text => {
      emitted.push(text.filter((t): t is string => typeof t === 'string').join(''));
    }
  );

  return { backend, emitted: emitted.join('') };
}

async function runToolTurn(rounds: unknown[][], options: Partial<ICompletionOptions> = {}) {
  return run(new RecordingBedrockBackend(rounds), { stream: true, ...options });
}

async function runNonStreamingToolTurn(rounds: unknown[], options: Partial<ICompletionOptions> = {}) {
  return run(new RecordingBedrockBackend([], rounds), { stream: false, ...options });
}

describe('Bedrock Claude tool continuation preserves signed thinking blocks', () => {
  it('leads the rebuilt assistant turn with the thinking block and its signature', async () => {
    const { backend, emitted } = await runToolTurn([thinkingToolRound(), synthesisRound()]);

    expect(backend.sentBodies).toHaveLength(2);
    const content = rebuiltAssistantContent(backend.sentBodies[1]);

    // Anthropic requires the thinking block FIRST, and unmodified.
    expect(content[0]).toEqual({ type: 'thinking', thinking: THINKING_TEXT, signature: SIGNATURE });
    expect(content[1]).toMatchObject({ type: 'tool_use', name: 'get_weather' });
    // The synthesis round produced a real answer rather than tripping the EMPTY guard.
    expect(emitted).toContain('It is sunny in Paris.');
  });

  it('replays a redacted_thinking block too', async () => {
    const redactedRound = thinkingToolRound();
    redactedRound.splice(1, 4, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'redacted_thinking', data: 'encrypted-payload' },
    });

    const { backend } = await runToolTurn([redactedRound, synthesisRound()]);

    expect(rebuiltAssistantContent(backend.sentBodies[1])[0]).toEqual({
      type: 'redacted_thinking',
      data: 'encrypted-payload',
    });
  });

  it('rebuilds a non-reasoning turn as exactly [tool_use]', async () => {
    const { backend } = await runToolTurn([plainToolRound(), synthesisRound()]);

    const content = rebuiltAssistantContent(backend.sentBodies[1]);
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ type: 'tool_use', name: 'get_weather' });
  });

  it('keeps declaring thinking on the continuation round when the caller enabled it', async () => {
    const { backend } = await runToolTurn([thinkingToolRound(), synthesisRound()], {
      thinking: { enabled: true, budget_tokens: 16000 },
    });

    const continuation = JSON.parse(backend.sentBodies[1]) as { thinking?: unknown };
    expect(continuation.thinking).toEqual({ type: 'adaptive' });
  });

  // A parallel round splits one provider turn into one synthetic assistant turn per tool.
  // The reasoning blocks are taken once for the round, so EVERY one of those turns carries
  // them - attaching them to the first only leaves the rest as bare tool_use, which is the
  // shape that makes the continuation come back empty.
  it('attaches the round reasoning blocks to every turn of a parallel tool round', async () => {
    const { backend } = await runToolTurn([thinkingParallelToolRound(), synthesisRound()], {
      tools: [weatherTool, timeTool],
    });

    const turns = rebuiltAssistantTurns(backend.sentBodies[1]);
    expect(turns).toHaveLength(2);
    for (const content of turns) {
      expect(content[0]).toEqual({ type: 'thinking', thinking: THINKING_TEXT, signature: SIGNATURE });
      expect(content[1]).toMatchObject({ type: 'tool_use' });
    }
    expect(turns.map(c => (c[1] as { name?: string }).name)).toEqual(['get_weather', 'get_time']);
  });

  // The non-streaming half of both the capture and the replay: a different Bedrock command
  // (invokeModel), a different translator (translateChunk), and a different loop in base.ts.
  it('replays the thinking block on the non-streaming path too', async () => {
    const { backend, emitted } = await runNonStreamingToolTurn([thinkingToolResponse(), synthesisResponse()]);

    expect(backend.sentBodies).toHaveLength(2);
    const content = rebuiltAssistantContent(backend.sentBodies[1]);

    expect(content[0]).toEqual({ type: 'thinking', thinking: THINKING_TEXT, signature: SIGNATURE });
    expect(content[1]).toMatchObject({ type: 'tool_use', name: 'get_weather' });
    expect(emitted).toContain('It is sunny in Paris.');
  });
});
