/**
 * Pins the Claude Fable safety-classifier refusal contract in the Anthropic backend.
 *
 * When a Fable model's cyber/bio classifiers decline, the API returns a successful HTTP 200
 * ending in stop_reason: 'refusal' and empty content. complete() converts that into a thrown
 * error the fallback loop recognizes (shouldTriggerFallback -> getLlmWithFallback), rather than
 * surfacing a silently-empty completion. Scoped to models whose refusalFallback resolves true, so
 * a refusal from any other model (a genuine decline) still resolves and surfaces unchanged.
 */

import { describe, it, expect } from 'vitest';
import { AnthropicBackend } from '../anthropicBackend';
import type { CompletionInfo, ICompletionOptions, ICompletionOptionTools } from '../backend';
import { SafetyRefusalError } from '../llmRefusalErrors';
import { ChatModels, ModelBackend, type IMessage, type ModelInfo } from '@bike4mind/common';

function asyncIterable(events: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    controller: { abort: () => {} },
  };
}

// An array is a streamed turn's events; an object is a non-streaming response body.
function buildBackend() {
  const backend = new AnthropicBackend('test-key');
  const responseQueue: unknown[] = [];
  const requests: Record<string, unknown>[] = [];
  type AnthropicApiMock = { messages: { create: (params: Record<string, unknown>) => unknown } };
  (backend as unknown as { _api: AnthropicApiMock })._api = {
    messages: {
      create: async params => {
        requests.push(structuredClone(params));
        const next = responseQueue.shift() ?? [];
        return Array.isArray(next) ? asyncIterable(next) : next;
      },
    },
  };
  return {
    backend,
    requests,
    enqueue: (...turns: unknown[]) => turns.forEach(t => responseQueue.push(t)),
  };
}

// A pre-output safety-classifier refusal: no content blocks, terminal message_delta carrying
// stop_reason: 'refusal'.
function refusalTurn(): unknown[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { input_tokens: 12, output_tokens: 0 } },
    { type: 'message_stop' },
  ];
}

const refusalResponse = () => ({
  content: [],
  stop_reason: 'refusal',
  usage: { input_tokens: 12, output_tokens: 0 },
});

function textTurn(text: string): unknown[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 5, output_tokens: 3 } },
    { type: 'message_stop' },
  ];
}

// A refusal after some output: the text streamed before the classifier stopped the turn.
function midStreamRefusalTurn(): unknown[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 30, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Here is how' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { input_tokens: 30, output_tokens: 7 } },
    { type: 'message_stop' },
  ];
}

const run = (
  backend: AnthropicBackend,
  model: string,
  stream: boolean,
  infos: CompletionInfo[] = [],
  options: Partial<ICompletionOptions> = {}
) =>
  backend.complete(
    model,
    [{ role: 'user', content: 'benign adjacent request' }],
    { stream, ...options },
    async (_text, info) => {
      infos.push(info);
    }
  );

async function refusalOf(promise: Promise<void>): Promise<SafetyRefusalError> {
  const error = await promise.then(
    () => undefined,
    (rejected: unknown) => rejected
  );
  expect(error).toBeInstanceOf(SafetyRefusalError);
  return error as SafetyRefusalError;
}

describe('AnthropicBackend - safety-classifier refusal fallback', () => {
  it.each([
    [ChatModels.CLAUDE_FABLE_5, true],
    ['claude-fable-5-1', true],
    ['claude-fable-5-1', false],
    ['claude-fable-5-2', true],
    ['claude-fable-5-2', false],
  ])('rejects with a recognized error when %s refuses (stream=%s)', async (model, stream) => {
    const { backend, enqueue } = buildBackend();
    enqueue(stream ? refusalTurn() : refusalResponse());

    await expect(run(backend, model, stream)).rejects.toThrow(/safety classifier refusal/i);
  });

  it.each([
    [ChatModels.CLAUDE_4_8_OPUS, true],
    [ChatModels.CLAUDE_5_5_OPUS, true],
    [ChatModels.CLAUDE_5_5_OPUS, false],
  ])('surfaces a refusal from %s, whose refusalFallback is false, unchanged (stream=%s)', async (model, stream) => {
    const { backend, enqueue } = buildBackend();
    enqueue(stream ? refusalTurn() : refusalResponse());
    const infos: CompletionInfo[] = [];

    await expect(run(backend, model, stream, infos)).resolves.not.toThrow();
    // Only the streaming path reports the stop reason to the caller.
    if (stream) expect(infos.some(info => info.stopReason === 'refusal')).toBe(true);
  });

  it('replays a refused Fable 5.2 tool round to the Opus 4.8 fallback with its thinking block unchanged', async () => {
    // What the completion loop hands the fallback hop after Fable 5.2 ran a tool round and then
    // refused: the round's assistant content as the backend pushed it, signed thinking first.
    // Opus 4.8 cannot read a Fable 5.2 block; the API drops it unbilled, and stripping it here
    // instead would break the tool turn's block order.
    const fableThinking = { type: 'thinking', thinking: '', signature: 'fable-5-2-signature' };
    const history = [
      { role: 'user', content: 'check the host' },
      {
        role: 'assistant',
        content: [fableThinking, { type: 'tool_use', id: 'call_1', name: 'lookup', input: { host: 'a' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'up' }] },
    ] as IMessage[];
    const lookup: ICompletionOptionTools = {
      toolSchema: {
        name: 'lookup',
        description: 'Look a host up.',
        parameters: { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] },
      },
      toolFn: async () => 'up',
    };
    const { backend, enqueue, requests } = buildBackend();
    enqueue(textTurn('the host is up'));

    await backend.complete(ChatModels.CLAUDE_4_8_OPUS, history, { stream: true, tools: [lookup] }, async () => {});

    const sent = requests[0] as { messages: Array<{ role: string; content: unknown }>; thinking?: { type: string } };
    const assistant = sent.messages.find(message => message.role === 'assistant');
    expect(assistant?.content).toEqual([fableThinking, expect.objectContaining({ type: 'tool_use', id: 'call_1' })]);
    expect(sent.thinking?.type).not.toBe('disabled');
  });

  it.each([
    [ChatModels.CLAUDE_FABLE_5, true],
    ['claude-fable-5-2', true],
    ['claude-fable-5-2', false],
    ['claude-fable-5-1', true],
  ])('settles a refusal from %s when the caller has no fallback loop (stream=%s)', async (model, stream) => {
    const { backend, enqueue } = buildBackend();
    enqueue(stream ? refusalTurn() : refusalResponse());
    const infos: CompletionInfo[] = [];

    await expect(run(backend, model, stream, infos, { settleRefusal: true })).resolves.not.toThrow();
    if (stream) expect(infos.some(info => info.stopReason === 'refusal')).toBe(true);
  });
});

describe('AnthropicBackend safety refusal usage', () => {
  // What a recursive tool round hands the next one: the rounds already run, summed and per request.
  const afterOneToolRound: Partial<ICompletionOptions> = {
    _internal: {
      accumInputTokens: 100,
      accumOutputTokens: 40,
      accumCacheReadTokens: 10,
      accumCacheWriteTokens: 5,
      accumTurnUsage: [{ inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 10, cacheCreationInputTokens: 5 }],
    },
  };

  it.each([true, false])(
    'carries the tool rounds already run but not a pre-output refusal (stream=%s)',
    async stream => {
      const { backend, enqueue } = buildBackend();
      enqueue(stream ? refusalTurn() : refusalResponse());

      const error = await refusalOf(run(backend, 'claude-fable-5-2', stream, [], afterOneToolRound));
      expect(error.usage).toEqual({
        inputTokens: 100,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 5,
        outputTokens: 40,
        turnUsage: [{ inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 10, cacheCreationInputTokens: 5 }],
      });
    }
  );

  it('adds a refused request that streamed output, which the provider bills', async () => {
    const { backend, enqueue } = buildBackend();
    enqueue(midStreamRefusalTurn());

    const error = await refusalOf(run(backend, 'claude-fable-5-2', true, [], afterOneToolRound));
    expect(error.usage).toEqual({
      inputTokens: 130,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      outputTokens: 47,
      turnUsage: [
        { inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 10, cacheCreationInputTokens: 5 },
        { inputTokens: 30, outputTokens: 7 },
      ],
    });
  });

  it('carries no usage for a first-round pre-output refusal', async () => {
    const { backend, enqueue } = buildBackend();
    enqueue(refusalTurn());

    const error = await refusalOf(run(backend, 'claude-fable-5-2', true));
    expect(error.usage).toBeUndefined();
  });
});

describe('AnthropicBackend refusal fallback read from the catalog', () => {
  const record = (id: string, patch: Partial<ModelInfo>) =>
    ({
      id,
      type: 'text',
      name: id,
      backend: ModelBackend.Anthropic,
      contextWindow: 1_000_000,
      max_tokens: 128_000,
      pricing: {},
      can_stream: true,
      supportsImageVariation: false,
      thinkingStyle: 'adaptive',
      ...patch,
    }) as ModelInfo;

  it('throws for a catalog-only Fable 5.2 whose row states no refusalFallback, from the seed', async () => {
    const { backend, enqueue } = buildBackend();
    backend.setDispatchModel(record('claude-fable-5-2', {}));
    enqueue(refusalTurn());

    await expect(run(backend, 'claude-fable-5-2', true)).rejects.toThrow(/safety classifier refusal/i);
  });

  it('surfaces a decline from an unlisted catalog-only model whose row states no refusalFallback', async () => {
    const { backend, enqueue } = buildBackend();
    backend.setDispatchModel(record('claude-fable-5-3', {}));
    enqueue(refusalTurn());

    await expect(run(backend, 'claude-fable-5-3', true)).resolves.not.toThrow();
  });

  it('throws into the fallback chain when the row states refusalFallback', async () => {
    const { backend, enqueue } = buildBackend();
    backend.setDispatchModel(record('claude-fable-5-3', { refusalFallback: true }));
    enqueue(refusalTurn());

    await expect(run(backend, 'claude-fable-5-3', true)).rejects.toThrow(/safety classifier refusal/i);
  });

  it.each([ChatModels.CLAUDE_FABLE_5, 'claude-fable-5-2'])(
    'lets an operator row turn the seeded fallback off for %s',
    async model => {
      const { backend, enqueue } = buildBackend();
      backend.setDispatchModel(record(model, { refusalFallback: false }));
      enqueue(refusalTurn());

      await expect(run(backend, model, true)).resolves.not.toThrow();
    }
  );
});
