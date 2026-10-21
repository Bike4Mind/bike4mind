import { describe, it, expect, vi } from 'vitest';
import { Stream } from 'openai/streaming';
import { ChatModels, type ICompletionOptionTools } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { OpenAIBackend } from './openaiBackend';
import { TOOL_ROUND_LOG_PREFIX, type ToolRoundEntry } from './toolRoundTiming';

const weatherTool: ICompletionOptionTools = {
  toolSchema: {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
  toolFn: async () => 'sunny',
};

function asOpenAIStream(events: unknown[]): Stream<unknown> {
  const s = {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    controller: { abort: () => {} },
  };
  Object.setPrototypeOf(s, Stream.prototype);
  return s as unknown as Stream<unknown>;
}

const streamedToolTurn = () =>
  asOpenAIStream([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
      usage: null,
    },
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]);

const streamedTerminalTurn = () =>
  asOpenAIStream([
    { choices: [{ index: 0, delta: { content: 'It is sunny.' }, finish_reason: null }], usage: null },
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    },
  ]);

const toolTurn = () => ({
  choices: [
    {
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

const terminalTurn = () => ({
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'It is sunny.' } }],
  usage: { prompt_tokens: 12, completion_tokens: 4 },
});

async function runRounds(stream: boolean, responses: unknown[]): Promise<ToolRoundEntry[]> {
  const logger = new Logger();
  const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  const queue = [...responses];
  const backend = new OpenAIBackend('test-key');
  (backend as unknown as { logger: Logger }).logger = logger;
  (backend as unknown as { _api: unknown })._api = {
    chat: { completions: { create: async () => queue.shift() } },
  };

  await backend.complete(
    ChatModels.GPT4O,
    [{ role: 'user', content: 'weather?' }],
    { stream, tools: [weatherTool], executeTools: true },
    async () => undefined
  );

  return info.mock.calls
    .filter(([message]) => message === TOOL_ROUND_LOG_PREFIX)
    .map(([, metadata]) => metadata as ToolRoundEntry);
}

function expectTwoRounds(rounds: ToolRoundEntry[]) {
  expect(rounds.map(r => r.round)).toEqual([0, 1]);
  expect(rounds[0].tools).toEqual([{ name: 'get_weather', resultChars: 'sunny'.length }]);
  expect(rounds[1].tools).toEqual([]);
  expect(rounds[1].sinceRequestMs).toBeGreaterThanOrEqual(rounds[0].sinceRequestMs);
  for (const r of rounds) expect(r.modelMs).toBeLessThanOrEqual(r.roundMs);
}

describe('OpenAIBackend chat completions per-round tool timing log', () => {
  it('logs one line per round on the streaming path', async () => {
    const rounds = await runRounds(true, [streamedToolTurn(), streamedTerminalTurn()]);

    expectTwoRounds(rounds);
    expect(rounds[0].stopReason).toBe('tool_calls');
    expect(rounds[0].msToFirstChunk).not.toBeNull();
    expect(rounds[1].stopReason).toBe('stop');
  });

  it('logs one line per round on the non-streaming path', async () => {
    const rounds = await runRounds(false, [toolTurn(), terminalTurn()]);

    expectTwoRounds(rounds);
    expect(rounds[0].stopReason).toBe('tool_calls');
    expect(rounds[0].msToFirstChunk).toBeNull();
    expect(rounds[1].stopReason).toBe('stop');
  });
});
