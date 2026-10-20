/**
 * Pins the usage the Anthropic streaming path reports when a stream is cut short by the
 * degeneration guard (both the post-loop and the AbortError emit), and how message_start's
 * prompt usage combines with message_delta's cumulative counts.
 */

import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';
import { ChatModels, estimateStreamedOutputTokens } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import type { CompletionInfo, ICompletionOptionTools } from './backend';
import { DEGENERATE_STREAM_STOP_REASON } from './degenerateStreamGuard';
import { TOOL_ROUND_LOG_PREFIX, type ToolRoundEntry } from './toolRoundTiming';

type Usage = Record<string, number | null>;

const messageStart = (usage: Usage) => ({ type: 'message_start', message: { usage } });
const textStart = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const textDelta = (text: string) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });

/**
 * A stream that repeats one short unit until the degeneration guard aborts it, then either ends
 * (the SDK iterator's usual reaction to abort) or throws an AbortError.
 */
function degenerateStream(startUsage: Usage, onAbort: 'end' | 'throw') {
  let aborted = false;
  const unit = '</invoke>\n';
  return {
    /** Chars of text streamed before the abort landed. */
    streamedChars: 0,
    [Symbol.asyncIterator]: async function* (this: { streamedChars: number }) {
      yield messageStart(startUsage);
      yield textStart;
      for (let i = 0; i < 2000 && !aborted; i++) {
        this.streamedChars += unit.length;
        yield textDelta(unit);
      }
      if (aborted && onAbort === 'throw') {
        const err = new Error('Request was aborted.');
        err.name = 'AbortError';
        throw err;
      }
    },
    controller: {
      abort: () => {
        aborted = true;
      },
    },
  };
}

function eventStream(events: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    controller: { abort: () => {} },
  };
}

function buildBackend(streams: unknown[], logger?: Logger) {
  const backend = new AnthropicBackend('test-key', logger);
  (backend as unknown as { _api: unknown })._api = {
    messages: { create: async () => streams.shift() },
  };
  return backend;
}

const weatherTool: ICompletionOptionTools = {
  toolSchema: {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
  toolFn: async () => 'sunny',
  _isMcpTool: true,
};

const toolTurn = eventStream([
  { type: 'message_start' },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'get_weather' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":"NYC"}' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: {
      input_tokens: 80,
      output_tokens: 15,
      cache_read_input_tokens: 3000,
      // The only reasoning count in these chains: the abort/degenerate turns below never
      // reach message_delta, so their reasoning count can only come from this earlier turn
      // through the accumulator.
      output_tokens_details: { thinking_tokens: 12 },
    },
  },
  { type: 'message_stop' },
]);

async function run(streams: unknown[], tools?: ICompletionOptionTools[]): Promise<CompletionInfo> {
  const backend = buildBackend(streams);
  const infos: CompletionInfo[] = [];
  await backend.complete(
    ChatModels.CLAUDE_4_8_OPUS,
    [{ role: 'user', content: 'hi' }],
    { stream: true, ...(tools ? { tools, executeTools: true } : {}) },
    async (_text, info) => {
      if (info) infos.push(info);
    }
  );
  return infos.at(-1)!;
}

describe('AnthropicBackend - usage on a degenerate stream', () => {
  it('reports the prompt usage when the stream ends after the degeneration abort', async () => {
    const last = await run([
      degenerateStream(
        { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 },
        'end'
      ),
    ]);

    expect(last.stopReason).toBe(DEGENERATE_STREAM_STOP_REASON);
    expect(last.inputTokens).toBe(10);
    // A first call leaves output to the caller's own estimate (see withAbortedOutputEstimate).
    expect(last.outputTokens).toBe(0);
    expect(last.cacheReadInputTokens).toBe(5000);
    expect(last.cacheCreationInputTokens).toBe(200);
    expect(last.turnUsage).toEqual([
      { inputTokens: 10, outputTokens: 0, cacheReadInputTokens: 5000, cacheCreationInputTokens: 200 },
    ]);
  });

  it('estimates the output of a degenerate second call from what it streamed, when the abort throws', async () => {
    const stream = degenerateStream({ input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 3100 }, 'throw');
    const last = await run([toolTurn, stream], [weatherTool]);

    // message_delta never came, but the provider billed the streamed repetition.
    const estimated = estimateStreamedOutputTokens(stream.streamedChars, ChatModels.CLAUDE_4_8_OPUS);
    expect(estimated).toBeGreaterThan(0);
    expect(last.stopReason).toBe(DEGENERATE_STREAM_STOP_REASON);
    // The count from the earlier tool turn survives our own abort.
    expect(last.reasoningTokens).toBe(12);
    expect(last.inputTokens).toBe(100);
    expect(last.outputTokens).toBe(15 + estimated);
    expect(last.cacheReadInputTokens).toBe(6100);
    expect(last.turnUsage).toEqual([
      { inputTokens: 80, outputTokens: 15, cacheReadInputTokens: 3000 },
      { inputTokens: 20, outputTokens: estimated, cacheReadInputTokens: 3100 },
    ]);
  });

  it('estimates the output of a degenerate second call from what it streamed, when the stream ends', async () => {
    const stream = degenerateStream({ input_tokens: 20, output_tokens: 1 }, 'end');
    const last = await run([toolTurn, stream], [weatherTool]);

    const estimated = estimateStreamedOutputTokens(stream.streamedChars, ChatModels.CLAUDE_4_8_OPUS);
    expect(estimated).toBeGreaterThan(0);
    expect(last.stopReason).toBe(DEGENERATE_STREAM_STOP_REASON);
    // Same as the AbortError variant above: the earlier turn's count survives.
    expect(last.reasoningTokens).toBe(12);
    expect(last.outputTokens).toBe(15 + estimated);
    expect(last.turnUsage).toEqual([
      { inputTokens: 80, outputTokens: 15, cacheReadInputTokens: 3000 },
      { inputTokens: 20, outputTokens: estimated },
    ]);
  });
});

describe('AnthropicBackend - message_start and message_delta usage', () => {
  it('keeps the message_start cache count when message_delta reports it as null', async () => {
    const last = await run([
      eventStream([
        messageStart({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 5000 }),
        textStart,
        textDelta('Done.'),
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null },
        },
        { type: 'message_stop' },
      ]),
    ]);

    expect(last.inputTokens).toBe(10);
    expect(last.outputTokens).toBe(5);
    expect(last.cacheReadInputTokens).toBe(5000);
    expect(last.turnUsage).toEqual([{ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 5000 }]);
  });
});

describe('AnthropicBackend - per-round tool timing log', () => {
  it('logs one ToolRound line per round, in order, with the tool name and result size', async () => {
    const logger = new Logger();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const terminalTurn = eventStream([
      { type: 'message_start' },
      textStart,
      textDelta('It is sunny.'),
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 5, output_tokens: 3 } },
      { type: 'message_stop' },
    ]);
    const backend = buildBackend([toolTurn, terminalTurn], logger);

    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      [{ role: 'user', content: 'weather?' }],
      { stream: true, tools: [weatherTool], executeTools: true },
      async () => undefined
    );

    const rounds = info.mock.calls
      .map(([line]) => String(line))
      .filter(line => line.startsWith(TOOL_ROUND_LOG_PREFIX))
      .map(line => JSON.parse(line.slice(TOOL_ROUND_LOG_PREFIX.length + 1)) as ToolRoundEntry);

    expect(rounds.map(r => r.round)).toEqual([0, 1]);
    expect(rounds[0].tools).toEqual([{ name: 'get_weather', resultChars: 'sunny'.length }]);
    expect(rounds[0].stopReason).toBe('tool_use');
    expect(rounds[0].msToFirstChunk).not.toBeNull();
    expect(rounds[1].tools).toEqual([]);
    expect(rounds[1].stopReason).toBe('end_turn');
    expect(rounds[1].sinceRequestMs).toBeGreaterThanOrEqual(rounds[0].sinceRequestMs);
  });

  it('logs the round that ends the turn after only end-of-turn tools ran', async () => {
    const logger = new Logger();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const endTool: ICompletionOptionTools = {
      toolSchema: { name: 'show_card', description: 'Render a card.', parameters: { type: 'object', properties: {} } },
      toolFn: async () => 'card rendered',
      endsTurnAfterText: true,
    };
    const answerThenEndTool = eventStream([
      { type: 'message_start' },
      textStart,
      textDelta('Here is the answer.'),
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_2', name: 'show_card' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 5, output_tokens: 3 } },
      { type: 'message_stop' },
    ]);
    const backend = buildBackend([toolTurn, answerThenEndTool], logger);

    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      [{ role: 'user', content: 'weather?' }],
      { stream: true, tools: [weatherTool, endTool], executeTools: true },
      async () => undefined
    );

    const rounds = info.mock.calls
      .map(([line]) => String(line))
      .filter(line => line.startsWith(TOOL_ROUND_LOG_PREFIX))
      .map(line => JSON.parse(line.slice(TOOL_ROUND_LOG_PREFIX.length + 1)) as ToolRoundEntry);

    expect(rounds.map(r => r.round)).toEqual([0, 1]);
    expect(rounds[1].tools).toEqual([{ name: 'show_card', resultChars: 'card rendered'.length }]);
  });
});
