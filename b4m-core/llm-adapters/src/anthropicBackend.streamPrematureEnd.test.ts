/**
 * Pins the Anthropic backend's handling of a stream that ends before message_stop. The SDK
 * iterator returns normally on abort and on an early end of the HTTP body, so without this
 * guard the turn was reported as a clean finish with an unclosed <think>.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels, isRetryableError } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import type { CompletionInfo } from './backend';

function asyncIterable(events: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    controller: { abort: () => {} },
  };
}

function buildBackend(turns: unknown[][]) {
  const backend = new AnthropicBackend('test-key');
  type AnthropicApiMock = { messages: { create: (...args: unknown[]) => unknown } };
  (backend as unknown as { _api: AnthropicApiMock })._api = {
    messages: { create: async () => asyncIterable(turns.shift() ?? []) },
  };
  return backend;
}

const messageStart = { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } };

function thinkingCutOff(): unknown[] {
  return [
    messageStart,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'hmm' } },
  ];
}

function completeTurn(): unknown[] {
  return [
    messageStart,
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done.' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
}

function collect() {
  const texts: string[] = [];
  const infos: (CompletionInfo | undefined)[] = [];
  const cb = async (chunk: (string | null | undefined)[], info?: CompletionInfo) => {
    for (const t of chunk) if (t) texts.push(t);
    infos.push(info);
  };
  return { texts, infos, cb };
}

describe('AnthropicBackend - stream ending before message_stop', () => {
  it('closes the open thinking block and throws a retryable error when not aborted', async () => {
    const backend = buildBackend([thinkingCutOff()]);
    const { texts, cb } = collect();

    let caught: unknown;
    await backend
      .complete(ChatModels.CLAUDE_4_8_OPUS, [{ role: 'user', content: 'hi' }], { stream: true }, cb)
      .catch(err => {
        caught = err;
      });

    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.message).toMatch(/stream timeout/);
    expect(error.message).not.toMatch(/aborted/i);
    expect(isRetryableError(error)).toBe(true);
    expect(texts.join('')).toBe('Let me check.<think>hmm</think>');
  });

  it('resolves with stopReason "aborted" when the abort signal fired', async () => {
    const backend = buildBackend([thinkingCutOff()]);
    const { texts, infos, cb: record } = collect();
    const controller = new AbortController();
    // Abort mid-stream, the way a user Stop lands after the request is already streaming.
    const cb: typeof record = async (chunk, info) => {
      await record(chunk, info);
      if (chunk.includes('hmm')) controller.abort();
    };

    await expect(
      backend.complete(
        ChatModels.CLAUDE_4_8_OPUS,
        [{ role: 'user', content: 'hi' }],
        { stream: true, abortSignal: controller.signal },
        cb
      )
    ).resolves.toBeUndefined();

    expect(texts.join('')).toBe('Let me check.<think>hmm</think>');
    expect(infos.at(-1)?.stopReason).toBe('aborted');
  });

  it('forwards the turn usage it did receive, cache included, when an aborted stream ends early', async () => {
    const backend = buildBackend([
      [
        messageStart,
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial' } },
        {
          type: 'message_delta',
          delta: { stop_reason: null },
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 200,
          },
        },
      ],
    ]);
    const { infos, cb: record } = collect();
    const controller = new AbortController();
    const cb: typeof record = async (chunk, info) => {
      await record(chunk, info);
      if (chunk.includes('Partial')) controller.abort();
    };

    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      [{ role: 'user', content: 'hi' }],
      { stream: true, abortSignal: controller.signal },
      cb
    );

    const last = infos.at(-1)!;
    expect(last.stopReason).toBe('aborted');
    // The provider billed the cached prompt; dropping it would settle the call far too low.
    expect(last.cacheReadInputTokens).toBe(5000);
    expect(last.cacheCreationInputTokens).toBe(200);
    expect(last.turnUsage).toEqual([
      { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 5000, cacheCreationInputTokens: 200 },
    ]);
  });

  it('forwards the prompt usage from message_start when Stop lands before message_delta', async () => {
    // The realistic Stop: message_delta is the stream's last event, so it never arrives.
    const backend = buildBackend([
      [
        {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 10,
              output_tokens: 1,
              cache_read_input_tokens: 5000,
              cache_creation_input_tokens: 200,
            },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial' } },
      ],
    ]);
    const { infos, cb: record } = collect();
    const controller = new AbortController();
    const cb: typeof record = async (chunk, info) => {
      await record(chunk, info);
      if (chunk.includes('Partial')) controller.abort();
    };

    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      [{ role: 'user', content: 'hi' }],
      { stream: true, abortSignal: controller.signal },
      cb
    );

    const last = infos.at(-1)!;
    expect(last.stopReason).toBe('aborted');
    expect(last.inputTokens).toBe(10);
    // message_start's output count is a placeholder, so it is not reported as the reply's output; on a
    // first call the caller estimates the partial reply itself (see withAbortedOutputEstimate).
    expect(last.outputTokens).toBe(0);
    expect(last.cacheReadInputTokens).toBe(5000);
    expect(last.cacheCreationInputTokens).toBe(200);
    expect(last.turnUsage).toEqual([
      { inputTokens: 10, outputTokens: 0, cacheReadInputTokens: 5000, cacheCreationInputTokens: 200 },
    ]);
  });

  it('estimates the output of a second call stopped before message_delta from what it streamed', async () => {
    const backend = buildBackend([
      [
        { type: 'message_start', message: { usage: { input_tokens: 80, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'probe' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } },
        { type: 'message_stop' },
      ],
      [
        {
          type: 'message_start',
          message: { usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 3000 } },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 't'.repeat(20) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'p'.repeat(20) } },
        { type: 'content_block_stop', index: 1 },
        // Events already in flight when Stop lands are still read before the iterator ends.
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't2', name: 'probe' } },
        {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: `{"q":"${'a'.repeat(12)}"}` },
        },
      ],
    ]);
    const { infos, cb: record } = collect();
    const controller = new AbortController();
    const cb: typeof record = async (chunk, info) => {
      await record(chunk, info);
      if (chunk.includes('p'.repeat(20))) controller.abort();
    };

    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      [{ role: 'user', content: 'hi' }],
      {
        stream: true,
        abortSignal: controller.signal,
        executeTools: true,
        tools: [
          {
            toolSchema: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } },
            toolFn: async () => 'ok',
          },
        ],
      },
      cb
    );

    const last = infos.at(-1)!;
    expect(last.stopReason).toBe('aborted');
    // 60 streamed chars (20 thinking + 20 text + 20 tool arguments) / 6 chars per token x 1.5 for Opus 4.8 = 15.
    expect(last.inputTokens).toBe(200);
    expect(last.outputTokens).toBe(30);
    expect(last.cacheReadInputTokens).toBe(3000);
    expect(last.turnUsage).toEqual([
      { inputTokens: 80, outputTokens: 15 },
      { inputTokens: 120, outputTokens: 15, cacheReadInputTokens: 3000 },
    ]);
  });

  it('does not estimate the output of a second call stopped before any content delta', async () => {
    const controller = new AbortController();
    const firstTurn = [
      { type: 'message_start', message: { usage: { input_tokens: 80, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'probe' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } },
      { type: 'message_stop' },
    ];
    const stoppedTurn = {
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'message_start', message: { usage: { input_tokens: 120, output_tokens: 1 } } };
        controller.abort();
      },
      controller: { abort: () => {} },
    };
    const backend = new AnthropicBackend('test-key');
    const streams = [asyncIterable(firstTurn), stoppedTurn];
    (backend as unknown as { _api: { messages: { create: () => unknown } } })._api = {
      messages: { create: async () => streams.shift() },
    };
    const { infos, cb } = collect();

    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      [{ role: 'user', content: 'hi' }],
      {
        stream: true,
        abortSignal: controller.signal,
        executeTools: true,
        tools: [
          {
            toolSchema: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } },
            toolFn: async () => 'ok',
          },
        ],
      },
      cb
    );

    const last = infos.at(-1)!;
    expect(last.stopReason).toBe('aborted');
    expect(last.inputTokens).toBe(200);
    expect(last.outputTokens).toBe(15);
    expect(last.turnUsage).toEqual([
      { inputTokens: 80, outputTokens: 15 },
      { inputTokens: 120, outputTokens: 0 },
    ]);
  });

  it('keeps the provider output count when Stop is observed after message_delta', async () => {
    const backend = buildBackend([
      [
        { type: 'message_start', message: { usage: { input_tokens: 80, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'probe' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } },
        { type: 'message_stop' },
      ],
      [
        { type: 'message_start', message: { usage: { input_tokens: 120, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'p'.repeat(20) } },
        // The terminal usage event arrives; Stop is raised from the text callback above but
        // only observed once the loop exits (the backend checks the signal after the loop,
        // not per event), so the provider's own count stands.
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } },
      ],
    ]);
    const { infos, cb: record } = collect();
    const controller = new AbortController();
    const cb: typeof record = async (chunk, info) => {
      await record(chunk, info);
      if (chunk.includes('p'.repeat(20))) controller.abort();
    };

    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      [{ role: 'user', content: 'hi' }],
      {
        stream: true,
        abortSignal: controller.signal,
        executeTools: true,
        tools: [
          {
            toolSchema: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } },
            toolFn: async () => 'ok',
          },
        ],
      },
      cb
    );

    const last = infos.at(-1)!;
    expect(last.stopReason).toBe('aborted');
    expect(last.inputTokens).toBe(200);
    // The provider's own count, not the lower-bound estimate of what streamed.
    expect(last.outputTokens).toBe(15 + 40);
    expect(last.turnUsage).toEqual([
      { inputTokens: 80, outputTokens: 15 },
      { inputTokens: 120, outputTokens: 40 },
    ]);
  });

  it('does not execute a tool call collected from a stream that ended early', async () => {
    let toolRan = false;
    const backend = buildBackend([
      [
        messageStart,
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'probe' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
      ],
    ]);
    const { cb } = collect();

    await expect(
      backend.complete(
        ChatModels.CLAUDE_4_8_OPUS,
        [{ role: 'user', content: 'hi' }],
        {
          stream: true,
          tools: [
            {
              toolSchema: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } },
              toolFn: async () => {
                toolRan = true;
                return 'ok';
              },
            },
          ],
        },
        cb
      )
    ).rejects.toThrow(/stream timeout/);
    expect(toolRan).toBe(false);
  });

  it('leaves a normal stream that ends with message_stop unchanged', async () => {
    const backend = buildBackend([completeTurn()]);
    const { texts, infos, cb } = collect();

    await backend.complete(ChatModels.CLAUDE_4_8_OPUS, [{ role: 'user', content: 'hi' }], { stream: true }, cb);

    expect(texts.join('')).toBe('<think>hmm</think>Done.');
    expect(infos.at(-1)?.stopReason).toBe('end_turn');
  });

  it('keeps the reasoning count from an earlier turn when an aborted stream ends early', async () => {
    // The abort branch reads usage from message_start, which carries no output_tokens_details,
    // so the only count available is the earlier tool turn's - threaded through the accumulator.
    const backend = buildBackend([
      [
        { type: 'message_start', message: { usage: { input_tokens: 80, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'probe' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { input_tokens: 80, output_tokens: 15, output_tokens_details: { thinking_tokens: 12 } },
        },
        { type: 'message_stop' },
      ],
      [
        { type: 'message_start', message: { usage: { input_tokens: 120, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial' } },
      ],
    ]);
    const { infos, cb: record } = collect();
    const controller = new AbortController();
    const cb: typeof record = async (chunk, info) => {
      await record(chunk, info);
      if (chunk.includes('Partial')) controller.abort();
    };

    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      [{ role: 'user', content: 'hi' }],
      {
        stream: true,
        abortSignal: controller.signal,
        executeTools: true,
        tools: [
          {
            toolSchema: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } },
            toolFn: async () => 'ok',
          },
        ],
      },
      cb
    );

    const last = infos.at(-1)!;
    expect(last.stopReason).toBe('aborted');
    expect(last.reasoningTokens).toBe(12);
  });
});
