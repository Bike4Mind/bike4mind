/**
 * Pins the provider-minimum floor on the output budget sent to OpenAI. A caller that bypasses
 * the /api/chat schema (agents, CLI, pinned session settings) can still hand the adapter a tiny
 * `maxTokens`, and OpenAI 400s anything under 16 ("Expected >= 16, got 8").
 *
 * Covers all three send sites: Responses (`max_output_tokens`), reasoning chat-completions
 * (`max_completion_tokens`) and classic chat-completions (`max_tokens`).
 */

import { describe, it, expect, vi } from 'vitest';
import { ChatModels, MIN_OUTPUT_TOKENS, type ICompletionOptions, type ICompletionOptionTools } from '@bike4mind/common';
import { Stream } from 'openai/streaming';
import { OpenAIBackend } from './openaiBackend';

type AnyRecord = Record<string, unknown>;

const terminalResponse = {
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
  usage: { input_tokens: 10, output_tokens: 4 },
};

function responseStream(): AsyncIterable<AnyRecord> {
  return (async function* () {
    yield { type: 'response.output_text.delta', delta: 'ok' };
    yield { type: 'response.completed', response: terminalResponse };
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

describe('OpenAIBackend output-budget floor', () => {
  it('floors a tiny maxTokens to the provider minimum on the Responses path', async () => {
    const { backend, responsesCreate } = buildBackend();
    await run(backend, ChatModels.GPT5, { tools: [sampleTool], maxTokens: 8 });
    expect((responsesCreate.mock.calls[0][0] as AnyRecord).max_output_tokens).toBe(MIN_OUTPUT_TOKENS);
  });

  it('floors a tiny maxTokens to the provider minimum on the reasoning chat-completions path', async () => {
    const { backend, chatCreate } = buildBackend();
    await run(backend, ChatModels.GPT5, { stream: true, maxTokens: 8 });
    const params = chatCreate.mock.calls[0][0] as AnyRecord;
    expect(params.max_completion_tokens).toBe(MIN_OUTPUT_TOKENS);
  });

  it('floors a tiny maxTokens to the provider minimum on the classic chat-completions path', async () => {
    const { backend, chatCreate } = buildBackend();
    await run(backend, ChatModels.GPT4o, { stream: true, maxTokens: 8 });
    expect((chatCreate.mock.calls[0][0] as AnyRecord).max_tokens).toBe(MIN_OUTPUT_TOKENS);
  });

  it('passes a budget at or above the minimum through unchanged', async () => {
    const { backend, responsesCreate, chatCreate } = buildBackend();
    await run(backend, ChatModels.GPT5, { tools: [sampleTool], maxTokens: 4096 });
    expect((responsesCreate.mock.calls[0][0] as AnyRecord).max_output_tokens).toBe(4096);
    await run(backend, ChatModels.GPT4o, { stream: true, maxTokens: MIN_OUTPUT_TOKENS });
    expect((chatCreate.mock.calls[0][0] as AnyRecord).max_tokens).toBe(MIN_OUTPUT_TOKENS);
  });

  it('passes a large budget through unchanged on the reasoning chat-completions path', async () => {
    const { backend, chatCreate } = buildBackend();
    await run(backend, ChatModels.GPT5, { stream: true, maxTokens: 4096 });
    expect((chatCreate.mock.calls[0][0] as AnyRecord).max_completion_tokens).toBe(4096);
  });

  it('leaves the budget unset when the caller sent none', async () => {
    const { backend, responsesCreate, chatCreate } = buildBackend();
    await run(backend, ChatModels.GPT4o, { stream: true });
    expect((chatCreate.mock.calls[0][0] as AnyRecord).max_tokens).toBeUndefined();
    await run(backend, ChatModels.GPT5, { tools: [sampleTool] });
    expect('max_output_tokens' in (responsesCreate.mock.calls[0][0] as AnyRecord)).toBe(false);
    await run(backend, ChatModels.GPT5, { stream: true });
    expect('max_completion_tokens' in (chatCreate.mock.calls[1][0] as AnyRecord)).toBe(false);
  });
});
