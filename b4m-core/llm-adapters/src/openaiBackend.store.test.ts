/**
 * Every request the OpenAI adapter sends opts out of OpenAI-side storage (`store: false`),
 * on both the Responses and the Chat Completions endpoints.
 */

import { describe, it, expect, vi } from 'vitest';
import { ChatModels, type ICompletionOptions, type ICompletionOptionTools } from '@bike4mind/common';
import { Stream } from 'openai/streaming';
import { OpenAIBackend } from './openaiBackend';

type AnyRecord = Record<string, unknown>;

function responseStream(): AsyncIterable<AnyRecord> {
  return (async function* () {
    yield { type: 'response.output_text.delta', delta: 'ok' };
    yield {
      type: 'response.completed',
      response: {
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 10, output_tokens: 4 },
      },
    };
  })();
}

function chatStream(): Stream<unknown> {
  const events = [
    { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
  ];
  const stream = {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    controller: { abort: () => {} },
  };
  Object.setPrototypeOf(stream, Stream.prototype);
  return stream as unknown as Stream<unknown>;
}

function buildBackend() {
  const backend = new OpenAIBackend('test-key');
  const responsesCreate = vi.fn(async (_params: AnyRecord) => responseStream());
  const chatCreate = vi.fn(async (params: AnyRecord) =>
    params.stream
      ? chatStream()
      : {
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }
  );
  (backend as unknown as { _api: unknown })._api = {
    responses: { create: responsesCreate },
    chat: { completions: { create: chatCreate } },
  };
  return { backend, responsesCreate, chatCreate };
}

const sampleTool: ICompletionOptionTools = {
  toolSchema: {
    name: 'lookup',
    description: 'Look something up.',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  },
};

async function run(backend: OpenAIBackend, model: string, options: Partial<ICompletionOptions>) {
  await backend.complete(model, [{ role: 'user', content: 'hi' }], options, async () => {});
}

describe('OpenAIBackend store: false', () => {
  it('sends store: false on the Responses path', async () => {
    const { backend, responsesCreate, chatCreate } = buildBackend();
    await run(backend, ChatModels.GPT5, { tools: [sampleTool] });
    expect(chatCreate).not.toHaveBeenCalled();
    expect((responsesCreate.mock.calls[0][0] as AnyRecord).store).toBe(false);
  });

  it('sends store: false on the reasoning chat-completions path', async () => {
    const { backend, chatCreate } = buildBackend();
    await run(backend, ChatModels.GPT5, { stream: true });
    expect((chatCreate.mock.calls[0][0] as AnyRecord).store).toBe(false);
  });

  it('sends store: false on the classic streaming chat-completions path', async () => {
    const { backend, chatCreate } = buildBackend();
    await run(backend, ChatModels.GPT4o, { stream: true });
    expect((chatCreate.mock.calls[0][0] as AnyRecord).store).toBe(false);
  });

  it('sends store: false on the classic non-streaming chat-completions path', async () => {
    const { backend, chatCreate } = buildBackend();
    await run(backend, ChatModels.GPT4o, { stream: false });
    const params = chatCreate.mock.calls[0][0] as AnyRecord;
    expect(params.stream).toBe(false);
    expect(params.store).toBe(false);
  });
});
