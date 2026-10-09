/**
 * A tool call is announced the moment the provider opens it, not when its arguments are done.
 *
 * Writing a whole file into a tool call takes the model tens of seconds, and the finished call
 * only reaches the client at the end; without this frame the client sits on a silent stream for
 * all of it. Each case drives a real backend against a canned provider stream and checks that a
 * `toolStarted` frame comes out BEFORE the frame carrying the finished call.
 */

import { describe, it, expect, vi } from 'vitest';
import { ChatModels, type CompletionInfo, type ICompletionOptionTools } from '@bike4mind/common';
import { Stream } from 'openai/streaming';
import { AnthropicBackend } from './anthropicBackend';
import { OpenAIBackend } from './openaiBackend';

type AnyRecord = Record<string, unknown>;

interface Frame {
  text: (string | null | undefined)[];
  info?: CompletionInfo;
}

const fileWriteTool: ICompletionOptionTools = {
  toolSchema: {
    name: 'file_write',
    description: 'Write a file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
};

const ARGS = '{"path":"a.ts","content":"export const a = 1;\\n"}';

function capture() {
  const frames: Frame[] = [];
  // Snapshotted: adapters pass toolsUsed by reference and fill it after the stream, so a held
  // reference would read every earlier frame as already carrying the finished call.
  const cb = async (text: (string | null | undefined)[], info?: CompletionInfo) => {
    frames.push({ text: [...text], info: info && { ...info, toolsUsed: info.toolsUsed && [...info.toolsUsed] } });
  };
  return { frames, cb };
}

const startedAt = (frames: Frame[]) => frames.findIndex(f => f.info?.toolStarted);
const finishedAt = (frames: Frame[]) => frames.findIndex(f => (f.info?.toolsUsed?.length ?? 0) > 0);

describe('AnthropicBackend announces a tool call when it opens', () => {
  it('emits toolStarted on content_block_start, ahead of the finished call', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 40 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'file_write' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ARGS } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 90 } },
      { type: 'message_stop' },
    ];
    const backend = new AnthropicBackend('test-key');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK client has no exported mock shape
    (backend as unknown as { _api: any })._api = {
      messages: {
        create: async () => ({
          [Symbol.asyncIterator]: async function* () {
            for (const e of events) yield e;
          },
          controller: { abort: () => {} },
        }),
      },
    };
    const { frames, cb } = capture();

    await backend.complete(
      'claude-sonnet-4-5-20250929',
      [{ role: 'user', content: 'write a.ts' }],
      { stream: true, tools: [fileWriteTool], executeTools: false },
      cb
    );

    const started = startedAt(frames);
    expect(frames[started].info?.toolStarted).toEqual({ name: 'file_write', id: 'toolu_1' });
    expect(frames[started].text.join('')).toBe('');
    expect(started).toBeLessThan(finishedAt(frames));
  });
});

describe('OpenAIBackend announces a tool call when it opens', () => {
  it('emits toolStarted once, on the chat-completions chunk that names the function', async () => {
    const chunks = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', type: 'function', function: { name: 'file_write', arguments: '' } },
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ARGS } }] } }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      },
    ];
    const backend = new OpenAIBackend('test-key');
    const create = vi.fn().mockImplementation(async () => {
      // The adapter branches on `response instanceof Stream`.
      const iterator = () =>
        (async function* () {
          for (const c of chunks) yield c;
        })();
      return new Stream(iterator as never, new AbortController());
    });
    (backend as unknown as { _api: unknown })._api = { chat: { completions: { create } } };
    const { frames, cb } = capture();

    await backend.complete(
      ChatModels.GPT4o,
      [{ role: 'user', content: 'write a.ts' }],
      { stream: true, tools: [fileWriteTool], executeTools: false },
      cb
    );

    const announced = frames.filter(f => f.info?.toolStarted);
    expect(announced.map(f => f.info?.toolStarted)).toEqual([{ name: 'file_write', id: 'call_1' }]);
    expect(startedAt(frames)).toBeLessThan(finishedAt(frames));
  });

  it('emits toolStarted on the Responses output_item.added event for a function call', async () => {
    const item = { type: 'function_call', call_id: 'call_9', name: 'file_write', arguments: '' };
    const events: AnyRecord[] = [
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: ARGS },
      {
        type: 'response.completed',
        response: { output: [{ ...item, arguments: ARGS }], usage: { input_tokens: 10, output_tokens: 20 } },
      },
    ];
    const backend = new OpenAIBackend('test-key');
    const responsesCreate = vi.fn(async () =>
      (async function* () {
        for (const e of events) yield e;
      })()
    );
    (backend as unknown as { _api: unknown })._api = {
      responses: { create: responsesCreate },
      chat: { completions: { create: vi.fn() } },
    };
    const { frames, cb } = capture();

    await backend.complete(
      ChatModels.GPT5,
      [{ role: 'user', content: 'write a.ts' }],
      { stream: true, tools: [fileWriteTool], executeTools: false },
      cb
    );

    expect(responsesCreate).toHaveBeenCalled();
    expect(frames[startedAt(frames)].info?.toolStarted).toEqual({ name: 'file_write', id: 'call_9' });
    expect(startedAt(frames)).toBeLessThan(finishedAt(frames));
  });
});
