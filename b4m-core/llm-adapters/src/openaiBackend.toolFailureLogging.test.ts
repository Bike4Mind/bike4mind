/**
 * The tool layer leaves the failure log to the adapter, so every OpenAI tool path must log a
 * failed tool itself: warn for an expected refusal, error for a real defect.
 * Must stay in sync with toolFailureLogLevel in executeToolsBatch.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { Stream } from 'openai/streaming';
import { ChatModels, ExpectedToolError, type IMessage } from '@bike4mind/common';
import { OpenAIBackend } from './openaiBackend';
import type { ICompletionOptions, ICompletionOptionTools } from './backend';

type Path = 'chat' | 'stream' | 'responses';

const TOOL_ARGS = '{"prompt":"bike"}';
const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function asStream(chunks: Record<string, unknown>[]) {
  const stream = Object.create(Stream.prototype) as Stream<unknown>;
  (stream as unknown as { [Symbol.asyncIterator]: () => AsyncGenerator<unknown> })[Symbol.asyncIterator] =
    async function* () {
      for (const chunk of chunks) yield chunk;
    };
  return stream;
}

function chatRound(isToolRound: boolean, streaming: boolean) {
  const toolCall = { id: 'call_1', type: 'function', function: { name: 'image_generation', arguments: TOOL_ARGS } };
  if (streaming) {
    return asStream(
      isToolRound
        ? [
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage },
          ]
        : [
            { choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
          ]
    );
  }
  return isToolRound
    ? {
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: null, tool_calls: [toolCall] },
            finish_reason: 'tool_calls',
          },
        ],
        usage,
      }
    : { choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage };
}

function responsesRound(isToolRound: boolean) {
  const response = isToolRound
    ? {
        output: [{ type: 'function_call', call_id: 'call_1', name: 'image_generation', arguments: TOOL_ARGS }],
        usage: { input_tokens: 20, output_tokens: 8 },
      }
    : {
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
        usage: { input_tokens: 10, output_tokens: 4 },
      };
  return (async function* () {
    yield { type: 'response.completed', response };
  })();
}

async function runFailingTool(path: Path, error: Error) {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() };
  const backend = new OpenAIBackend('test-key', logger as never);
  let round = 0;
  (backend as unknown as { _api: unknown })._api = {
    chat: { completions: { create: async () => chatRound(round++ === 0, path === 'stream') } },
    responses: { create: async () => responsesRound(round++ === 0) },
  };
  const tool: ICompletionOptionTools = {
    toolSchema: {
      name: 'image_generation',
      description: 'Generate an image.',
      parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    },
    toolFn: async () => {
      throw error;
    },
  };
  const messages: IMessage[] = [{ role: 'user', content: 'generate an image of a red bicycle' }];
  const options: Partial<ICompletionOptions> = {
    stream: path === 'stream',
    tools: [tool],
    ...(path === 'responses' ? { reasoningEffort: 'low' as const } : {}),
  };
  await backend.complete(
    path === 'responses' ? ChatModels.GPT5 : ChatModels.GPT4o,
    messages,
    options,
    async () => undefined
  );
  return logger;
}

describe.each<Path>(['chat', 'stream', 'responses'])('OpenAI tool failure logging (%s path)', path => {
  it.each([
    { label: 'an expected refusal at warn', error: new ExpectedToolError('refused'), level: 'warn' as const },
    { label: 'an unexpected failure at error', error: new Error('boom'), level: 'error' as const },
  ])('logs $label', async ({ error, level }) => {
    const logger = await runFailingTool(path, error);
    const otherLevel = level === 'warn' ? 'error' : 'warn';

    expect(logger[level]).toHaveBeenCalledWith(
      '[Tool Execution] Tool failed',
      expect.objectContaining({ toolName: 'image_generation', error: error.message })
    );
    expect(logger[otherLevel]).not.toHaveBeenCalledWith('[Tool Execution] Tool failed', expect.anything());
  });
});
