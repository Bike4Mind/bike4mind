/**
 * A Responses stream can end with no terminal event: the openai SDK swallows an abort during the
 * SSE read, and an upstream close just stops yielding. The adapter must tell those apart.
 */

import { describe, it, expect, vi } from 'vitest';
import { ChatModels, type ICompletionOptions, type ICompletionOptionTools } from '@bike4mind/common';
import { OpenAIBackend, ResponsesStreamTruncatedError } from './openaiBackend';

type AnyRecord = Record<string, unknown>;

const sampleTool: ICompletionOptionTools = {
  toolSchema: {
    name: 'lookup',
    description: 'Look something up.',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  },
};

const terminal = { output: [], usage: { input_tokens: 1, output_tokens: 1 } };

/** Yields `events`, running `onEnd` once the last one is consumed, then ends the iterator quietly. */
function buildBackend(events: AnyRecord[], onEnd?: () => void) {
  const backend = new OpenAIBackend('test-key');
  const stream = (async function* () {
    for (const e of events) yield e;
    onEnd?.();
  })();
  (backend as unknown as { _api: unknown })._api = {
    responses: { create: vi.fn(async () => stream) },
    chat: { completions: { create: vi.fn() } },
  };
  return backend;
}

const delta = { type: 'response.output_text.delta', delta: 'partial ' };

function complete(backend: OpenAIBackend, options: Partial<ICompletionOptions> = {}) {
  return backend.complete(
    ChatModels.GPT5,
    [{ role: 'user', content: 'hi' }],
    { tools: [sampleTool], ...options },
    async () => {}
  );
}

describe('OpenAIBackend Responses stream without a terminal event', () => {
  it('rejects as an AbortError when the signal aborted mid-stream', async () => {
    const controller = new AbortController();
    const backend = buildBackend([delta], () => controller.abort());

    await expect(complete(backend, { abortSignal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('rejects as ResponsesStreamTruncatedError when the stream closes early with no abort', async () => {
    const backend = buildBackend([delta]);

    await expect(complete(backend, { abortSignal: new AbortController().signal })).rejects.toBeInstanceOf(
      ResponsesStreamTruncatedError
    );
  });

  it('keeps a mid-stream iterator failure as its original error', async () => {
    const backend = buildBackend([delta], () => {
      throw new Error('stream timeout');
    });

    const err = await complete(backend).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ResponsesStreamTruncatedError);
    expect(err.message).toBe('stream timeout');
  });

  it('keeps a response.failed event as its own error, not a truncation', async () => {
    const backend = buildBackend([delta, { type: 'response.failed', response: { error: { message: 'boom' } } }]);

    const err = await complete(backend).catch(e => e);
    expect(err).not.toBeInstanceOf(ResponsesStreamTruncatedError);
    expect(err.message).toContain('boom');
  });

  it('still resolves when the terminal event arrives', async () => {
    const backend = buildBackend([delta, { type: 'response.completed', response: terminal }]);
    const callback = vi.fn(async () => {});

    await expect(
      backend.complete(ChatModels.GPT5, [{ role: 'user', content: 'hi' }], { tools: [sampleTool] }, callback)
    ).resolves.toBeUndefined();
    expect(callback).toHaveBeenLastCalledWith([], expect.objectContaining({ inputTokens: 1, outputTokens: 1 }));
  });
});
