import { ChatModels, type IMessage } from '@bike4mind/common';
import { describe, expect, it, vi } from 'vitest';
import { Stream } from 'openai/streaming';
import { XAIBackend } from './xaiBackend';
import type { CompletionInfo } from './backend';

type StreamChunk = {
  choices: Array<{ index: number; delta: Record<string, unknown>; finish_reason?: string }>;
  usage?: Record<string, unknown>;
};

/** An XAIBackend whose OpenAI client yields the given streamed turns in order. */
function streamingBackend(turns: StreamChunk[][]) {
  const backend = new XAIBackend('test-key');
  let call = 0;
  const create = vi.fn().mockImplementation(async () => {
    const chunks = turns[Math.min(call, turns.length - 1)];
    call += 1;
    // The backend branches on `response instanceof Stream`, so a bare async
    // generator would be treated as a non-streaming reply. Wrap it in a real Stream.
    const iterator = () =>
      (async function* () {
        for (const c of chunks) yield c;
      })();
    return new Stream(iterator as never, new AbortController());
  });
  (backend as unknown as { _api: unknown })._api = { chat: { completions: { create } } };
  return { backend, create };
}

const userMessages = (): IMessage[] => [{ role: 'user', content: 'hi' } as IMessage];

async function runStream(backend: XAIBackend, model: string, options = {}) {
  const frames: Array<{ text: (string | null | undefined)[]; info: CompletionInfo }> = [];
  await backend.complete(
    model,
    userMessages(),
    { stream: true, thinking: { enabled: true }, ...options },
    async (text, info) => {
      frames.push({ text, info });
    }
  );
  return frames;
}

const searchTool = (toolFn: ReturnType<typeof vi.fn>) => [
  { toolSchema: { name: 'search', description: 'search', parameters: { type: 'object' } }, toolFn },
];

describe('XAIBackend streaming reasoning', () => {
  it('flushes a partial marker held at the reasoning/tool-call boundary instead of dropping it', async () => {
    // The escaper holds back a possible marker prefix ("<th") at the end of a
    // push() until the next delta resolves it. When reasoning ends straight into
    // tool_calls with no further content delta, nothing ever resolves it - without
    // a post-loop flush, the recursive call for the tool round-trip creates a
    // brand-new escaper and the held-back text is silently gone.
    const toolFn = vi.fn().mockResolvedValue('42');
    const { backend } = streamingBackend([
      [
        { choices: [{ index: 0, delta: { reasoning_content: 'tool now <th' } }] },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      ],
      [
        {
          choices: [{ index: 0, delta: { content: 'the answer' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 6 },
        },
      ],
    ]);

    const frames = await runStream(backend, ChatModels.GROK_4_5, { tools: searchTool(toolFn) });

    expect(toolFn).toHaveBeenCalledOnce();
    const joined = frames
      .flatMap(f => f.text)
      .filter(Boolean)
      .join('');
    expect(joined).toContain('<think>tool now <th</think>');
    expect(joined).toContain('the answer');
    expect(joined.match(/<think>/g)?.length).toBe(joined.match(/<\/think>/g)?.length);
  });

  it('closes the <think> block on a reasoning-then-tool turn instead of leaving it open', async () => {
    const toolFn = vi.fn().mockResolvedValue('42');
    const { backend } = streamingBackend([
      [
        { choices: [{ index: 0, delta: { reasoning_content: 'let me search' } }] },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      ],
      [
        {
          choices: [{ index: 0, delta: { content: 'the answer' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 6 },
        },
      ],
    ]);

    const frames = await runStream(backend, ChatModels.GROK_4_5, { tools: searchTool(toolFn) });

    expect(toolFn).toHaveBeenCalledOnce();
    const joined = frames
      .flatMap(f => f.text)
      .filter(Boolean)
      .join('');
    expect(joined).toContain('<think>let me search</think>');
    expect(joined).toContain('the answer');
    expect(joined.match(/<think>/g)?.length).toBe(joined.match(/<\/think>/g)?.length);
  });

  it('keeps reasoning text from being emitted twice by the flush guard on an already-closed block', async () => {
    const { backend } = streamingBackend([
      [
        { choices: [{ index: 0, delta: { reasoning_content: 'thinking' } }] },
        { choices: [{ index: 0, delta: { content: 'The answer' } }] },
        {
          choices: [{ index: 0, delta: { content: ' is 42' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      ],
    ]);

    const frames = await runStream(backend, ChatModels.GROK_4_5);
    const joined = frames
      .flatMap(f => f.text)
      .filter(Boolean)
      .join('');

    expect(joined).toBe('<think>thinking</think>The answer is 42');
  });
});
