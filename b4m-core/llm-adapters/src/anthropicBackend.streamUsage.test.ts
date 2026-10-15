/**
 * Pins the usage the Anthropic streaming path reports when a stream is cut short by the
 * degeneration guard (both the post-loop and the AbortError emit), and how message_start's
 * prompt usage combines with message_delta's cumulative counts.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import type { CompletionInfo, ICompletionOptionTools } from './backend';
import { DEGENERATE_STREAM_STOP_REASON } from './degenerateStreamGuard';

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
  return {
    [Symbol.asyncIterator]: async function* () {
      yield messageStart(startUsage);
      yield textStart;
      for (let i = 0; i < 2000 && !aborted; i++) yield textDelta('</invoke>\n');
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

function buildBackend(streams: unknown[]) {
  const backend = new AnthropicBackend('test-key');
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
    usage: { input_tokens: 80, output_tokens: 15, cache_read_input_tokens: 3000 },
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
    expect(last.outputTokens).toBe(0);
    expect(last.cacheReadInputTokens).toBe(5000);
    expect(last.cacheCreationInputTokens).toBe(200);
    expect(last.turnUsage).toEqual([
      { inputTokens: 10, outputTokens: 0, cacheReadInputTokens: 5000, cacheCreationInputTokens: 200 },
    ]);
  });

  it('reports the prior calls plus this prompt when the degeneration abort throws', async () => {
    const last = await run(
      [toolTurn, degenerateStream({ input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 3100 }, 'throw')],
      [weatherTool]
    );

    expect(last.stopReason).toBe(DEGENERATE_STREAM_STOP_REASON);
    expect(last.inputTokens).toBe(100);
    expect(last.outputTokens).toBe(15);
    expect(last.cacheReadInputTokens).toBe(6100);
    expect(last.turnUsage).toEqual([
      { inputTokens: 80, outputTokens: 15, cacheReadInputTokens: 3000 },
      { inputTokens: 20, outputTokens: 0, cacheReadInputTokens: 3100 },
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
