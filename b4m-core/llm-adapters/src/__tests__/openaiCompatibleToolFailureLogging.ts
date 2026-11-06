/**
 * Shared suite for the OpenAI-compatible backends (Kimi, xAI, DeepSeek): the tool layer leaves the
 * failure log to the adapter, so each backend must log a failed tool itself, warn for an expected
 * refusal and error for a real defect. Must stay in sync with toolFailureLogLevel in executeToolsBatch.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { Stream } from 'openai/streaming';
import { ExpectedToolError, type IMessage } from '@bike4mind/common';
import type { ICompletionBackend, ICompletionOptionTools } from '../backend';

const TOOL_NAME = 'image_generation';

const toolCallTurn = (stream: boolean) =>
  stream
    ? [
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: TOOL_NAME, arguments: '{}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      ]
    : {
        choices: [
          {
            index: 0,
            message: {
              content: '',
              tool_calls: [{ id: 't1', type: 'function', function: { name: TOOL_NAME, arguments: '{}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };

const answerTurn = (stream: boolean) =>
  stream
    ? [
        {
          choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 6 },
        },
      ]
    : {
        choices: [{ index: 0, message: { content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      };

async function runFailingTool(
  makeBackend: (logger: never) => ICompletionBackend,
  model: string,
  stream: boolean,
  error: Error
) {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() };
  const backend = makeBackend(logger as never);
  const turns = [toolCallTurn(stream), answerTurn(stream)];
  let call = 0;
  const create = vi.fn().mockImplementation(async () => {
    const turn = turns[Math.min(call++, turns.length - 1)];
    if (!stream) return turn;
    const chunks = turn as unknown[];
    // The backends branch on `response instanceof Stream`, so wrap the generator in a real one.
    const iterator = () =>
      (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    return new Stream(iterator as never, new AbortController());
  });
  (backend as unknown as { _api: unknown })._api = { chat: { completions: { create } } };

  const tool: ICompletionOptionTools = {
    toolSchema: { name: TOOL_NAME, description: TOOL_NAME, parameters: { type: 'object', properties: {} } },
    toolFn: async () => {
      throw error;
    },
  };
  await backend.complete(
    model,
    [{ role: 'user', content: 'generate an image of a red bicycle' } as IMessage],
    { stream, tools: [tool] },
    async () => undefined
  );
  return logger;
}

export function describeOpenAICompatibleToolFailureLogging(
  label: string,
  makeBackend: (logger: never) => ICompletionBackend,
  model: string
) {
  describe.each([true, false])(`${label} tool failure logging (stream=%s)`, stream => {
    it.each([
      { label: 'an expected refusal at warn', error: new ExpectedToolError('refused'), level: 'warn' as const },
      { label: 'an unexpected failure at error', error: new Error('boom'), level: 'error' as const },
    ])('logs $label', async ({ error, level }) => {
      const logger = await runFailingTool(makeBackend, model, stream, error);
      const otherLevel = level === 'warn' ? 'error' : 'warn';

      expect(logger[level]).toHaveBeenCalledWith(
        '[Tool Execution] Tool failed',
        expect.objectContaining({ toolName: TOOL_NAME, error: error.message })
      );
      expect(logger[otherLevel]).not.toHaveBeenCalledWith('[Tool Execution] Tool failed', expect.anything());
    });
  });
}
