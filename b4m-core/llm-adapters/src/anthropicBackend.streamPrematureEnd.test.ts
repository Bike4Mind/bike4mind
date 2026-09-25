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
});
