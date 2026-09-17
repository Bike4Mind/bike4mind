import { ChatModels, type IMessage } from '@bike4mind/common';
import { describe, expect, it, vi } from 'vitest';
import { Stream } from 'openai/streaming';
import { DeepSeekBackend } from './deepseekBackend';
import type { CompletionInfo } from './backend';

/**
 * The non-streaming reasoning path. Every case here is silent when it breaks:
 * no error, no log, just a wrong or missing answer, or a turn billed twice.
 */

type Choice = {
  index: number;
  message: Record<string, unknown>;
  finish_reason?: string;
};

/** A DeepSeekBackend whose OpenAI client is replaced by a canned non-streaming reply. */
function backendReturning(choices: Choice[], usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  const backend = new DeepSeekBackend('test-key');
  const create = vi.fn().mockResolvedValue({ choices, usage });
  // The client is private; swapping it is the seam that keeps this a unit test
  // rather than a live DeepSeek call.
  (backend as unknown as { _api: unknown })._api = { chat: { completions: { create } } };
  return { backend, create };
}

const userMessages = (): IMessage[] => [{ role: 'user', content: 'hi' } as IMessage];

async function runTurn(backend: DeepSeekBackend, model: string, options = {}) {
  const frames: Array<{ text: (string | null | undefined)[]; info: CompletionInfo }> = [];
  await backend.complete(model, userMessages(), { stream: false, ...options }, async (text, info) => {
    frames.push({ text, info });
  });
  return frames;
}

const searchTool = (toolFn: ReturnType<typeof vi.fn>) => [
  { toolSchema: { name: 'search', description: 'search', parameters: { type: 'object' } }, toolFn },
];

describe('DeepSeekBackend reasoning capture', () => {
  it('keeps reasoning_content even when no reasoning parameter was sent', async () => {
    // Gating on "did we send a thinking parameter" drops reasoning on the common
    // path: both ids reason by default and deepseekReasoningParams sends nothing
    // unless an explicit effort or toggle was set. The monologue is billed as
    // output tokens either way, so discarding it charges for unseen text.
    const { backend } = backendReturning([
      { index: 0, message: { content: 'the answer', reasoning_content: 'my thinking' }, finish_reason: 'stop' },
    ]);

    const frames = await runTurn(backend, ChatModels.DEEPSEEK_FLASH);
    expect(frames.at(-1)?.text[0]).toBe('<think>my thinking</think>the answer');
  });

  it('runs the tool when a turn carries BOTH reasoning and tool calls', async () => {
    // Handling reasoning first returns the monologue as the entire answer and
    // runs nothing. Thinking is on by default here, so for an agentic turn this
    // is the normal case rather than an edge one.
    const toolFn = vi.fn().mockResolvedValue('tool output');
    const toolTurn = {
      choices: [
        {
          index: 0,
          message: {
            content: '',
            reasoning_content: 'I should call the tool',
            tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const { backend, create } = backendReturning([]);
    create.mockResolvedValueOnce(toolTurn);
    create.mockResolvedValue({
      choices: [{ index: 0, message: { content: 'final answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 6 },
    });

    const frames = await runTurn(backend, ChatModels.DEEPSEEK_FLASH, { tools: searchTool(toolFn) });

    expect(toolFn).toHaveBeenCalledOnce();
    expect(frames.at(-1)?.text[0]).toBe('final answer');
    expect(frames.at(-1)?.info.toolsUsed?.map(t => t.name)).toEqual(['search']);
  });

  it("replays the prior turn's reasoning_content on the assistant tool-call message", async () => {
    // DeepSeek inverts the usual rule: when a request carries `tools`, the prior
    // monologue MUST come back in context or reasoning continuity breaks. The
    // shared OpenAI converter rebuilds that message, so the field has to survive
    // both pushToolMessages and formatMessages to reach the wire.
    const toolFn = vi.fn().mockResolvedValue('tool output');
    const { backend, create } = backendReturning([]);
    create.mockResolvedValueOnce({
      choices: [
        {
          index: 0,
          message: {
            content: '',
            reasoning_content: 'step one',
            tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    create.mockResolvedValue({
      choices: [{ index: 0, message: { content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 6 },
    });

    await runTurn(backend, ChatModels.DEEPSEEK_FLASH, { tools: searchTool(toolFn) });

    const secondRequest = create.mock.calls[1][0] as { messages: Array<Record<string, unknown>> };
    const assistantTurn = secondRequest.messages.find(m => m.role === 'assistant' && m.tool_calls);
    expect(assistantTurn?.reasoning_content).toBe('step one');
  });

  it('throws a diagnosable error when reasoning consumed the whole output budget', async () => {
    // A turn that hits max_tokens mid-reasoning returns empty content, which
    // otherwise surfaces as a blank reply with no error at all.
    const { backend } = backendReturning([{ index: 0, message: { content: '' }, finish_reason: 'length' }]);

    await expect(runTurn(backend, ChatModels.DEEPSEEK_FLASH)).rejects.toThrow(/output budget was exhausted/);
  });

  it('names the finish_reason when a turn produced nothing for some other reason', async () => {
    const { backend } = backendReturning([{ index: 0, message: { content: '' }, finish_reason: 'content_filter' }]);

    await expect(runTurn(backend, ChatModels.DEEPSEEK_V4_PRO)).rejects.toThrow(/finish_reason: content_filter/);
  });

  /**
   * DeepSeek's `prompt_tokens` is CACHE-INCLUSIVE, like every OpenAI-compatible
   * provider: the cached portion is reported inside the prompt total, not beside
   * it. getTextModelCost expects Anthropic's cache-EXCLUSIVE convention, so the
   * backend has to split them or the user pays the full input rate for tokens
   * DeepSeek billed at ~2% of it.
   */
  it('splits cache-inclusive prompt_tokens so a hit is billed at the cache rate', async () => {
    const { backend } = backendReturning([{ index: 0, message: { content: 'OK' }, finish_reason: 'stop' }], {
      prompt_tokens: 1220,
      completion_tokens: 31,
      prompt_cache_hit_tokens: 1220,
      prompt_cache_miss_tokens: 0,
    } as never);

    const info = (await runTurn(backend, ChatModels.DEEPSEEK_FLASH, { cacheStrategy: { enableCaching: true } })).at(
      -1
    )!.info;

    expect(info.inputTokens).toBe(0);
    expect(info.cacheReadInputTokens).toBe(1220);
    // The two must sum back to what the provider reported, or the turn is either
    // over- or under-billed.
    expect((info.inputTokens ?? 0) + (info.cacheReadInputTokens ?? 0)).toBe(1220);
  });

  it('reads the nested OpenAI cached_tokens spelling too, since DeepSeek sends both', async () => {
    const { backend } = backendReturning([{ index: 0, message: { content: 'OK' }, finish_reason: 'stop' }], {
      prompt_tokens: 100,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 40 },
    } as never);

    const info = (await runTurn(backend, ChatModels.DEEPSEEK_FLASH, { cacheStrategy: { enableCaching: true } })).at(
      -1
    )!.info;
    expect(info.inputTokens).toBe(60);
    expect(info.cacheReadInputTokens).toBe(40);
  });

  it('leaves inputTokens whole and claims no cache read when nothing was cached', async () => {
    const { backend } = backendReturning([{ index: 0, message: { content: 'OK' }, finish_reason: 'stop' }], {
      prompt_tokens: 100,
      completion_tokens: 5,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 100,
    } as never);

    const info = (await runTurn(backend, ChatModels.DEEPSEEK_FLASH)).at(-1)!.info;
    expect(info.inputTokens).toBe(100);
    expect(info.cacheReadInputTokens).toBeUndefined();
  });

  it('never reports negative input if a feed claims more cached than prompt tokens', async () => {
    // A negative input count would silently credit the user.
    const { backend } = backendReturning([{ index: 0, message: { content: 'OK' }, finish_reason: 'stop' }], {
      prompt_tokens: 50,
      completion_tokens: 5,
      prompt_cache_hit_tokens: 900,
    } as never);

    const info = (await runTurn(backend, ChatModels.DEEPSEEK_FLASH)).at(-1)!.info;
    expect(info.inputTokens).toBe(0);
    expect(info.cacheReadInputTokens).toBe(50);
  });

  it('accumulates usage across tool round-trips instead of billing only the last turn', async () => {
    // Every round-trip is a separate billed call and consumers ASSIGN rather than
    // add, so the terminal turn has to carry the whole session.
    const toolFn = vi.fn().mockResolvedValue('tool output');
    const { backend, create } = backendReturning([]);
    create.mockResolvedValueOnce({
      choices: [
        {
          index: 0,
          message: {
            content: '',
            tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 40 },
    });
    create.mockResolvedValue({
      choices: [{ index: 0, message: { content: 'final' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 300, completion_tokens: 30, prompt_cache_hit_tokens: 100 },
    });

    const info = (await runTurn(backend, ChatModels.DEEPSEEK_FLASH, { tools: searchTool(toolFn) })).at(-1)!.info;

    // 100 + 300 prompt tokens, of which 40 + 100 were cache reads.
    expect(info.cacheReadInputTokens).toBe(140);
    expect(info.inputTokens).toBe(260);
    expect(info.outputTokens).toBe(50);
  });

  it('does not fire the empty guard for a turn that legitimately only called a tool', async () => {
    const { backend } = backendReturning([
      {
        index: 0,
        message: {
          content: '',
          tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      },
    ]);

    // executeTools: false makes the tool turn terminal, so the guard would be
    // reached if it were keyed on text alone.
    await expect(
      runTurn(backend, ChatModels.DEEPSEEK_FLASH, { executeTools: false, tools: [] })
    ).resolves.not.toThrow();
  });
});

/**
 * The STREAMING path. Chat streams, so these are the shapes users actually hit.
 */

type StreamChunk = {
  choices: Array<{ index: number; delta: Record<string, unknown>; finish_reason?: string }>;
  usage?: Record<string, unknown>;
};

/** A DeepSeekBackend whose OpenAI client yields the given streamed turns in order. */
function streamingBackend(turns: StreamChunk[][]) {
  const backend = new DeepSeekBackend('test-key');
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

async function runStream(backend: DeepSeekBackend, model: string, options = {}) {
  const frames: Array<{ text: (string | null | undefined)[]; info: CompletionInfo }> = [];
  await backend.complete(model, userMessages(), { stream: true, ...options }, async (text, info) => {
    frames.push({ text, info });
  });
  return frames;
}

describe('DeepSeekBackend streaming reasoning', () => {
  it('asks for usage on the stream, without which a turn settles at zero', async () => {
    const { backend, create } = streamingBackend([
      [
        {
          choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      ],
    ]);

    await runStream(backend, ChatModels.DEEPSEEK_FLASH);

    expect(create.mock.calls[0][0]).toMatchObject({ stream_options: { include_usage: true } });
  });

  it('closes the <think> block on a reasoning-then-tool turn instead of leaving it open', async () => {
    // Reasoning deltas open <think>; the tool arrives with no prose to close it,
    // so without the post-loop close the tag stays open and bleeds into the answer.
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

    const frames = await runStream(backend, ChatModels.DEEPSEEK_FLASH, { tools: searchTool(toolFn) });

    expect(toolFn).toHaveBeenCalledOnce();
    const joined = frames
      .flatMap(f => f.text)
      .filter(Boolean)
      .join('');
    expect(joined).toContain('<think>let me search</think>');
    expect(joined).toContain('the answer');
    expect(joined.match(/<think>/g)?.length).toBe(joined.match(/<\/think>/g)?.length);
  });

  it('throws a diagnosable error when a stream produces no content and no tool', async () => {
    // Without this guard an empty stream returns silently with zero callbacks and
    // the chat hangs.
    const { backend } = streamingBackend([
      [
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      ],
    ]);

    await expect(runStream(backend, ChatModels.DEEPSEEK_FLASH)).rejects.toThrow(/output budget was exhausted/);
  });

  it('splits the streamed cache counters and accumulates across the tool round-trip', async () => {
    const toolFn = vi.fn().mockResolvedValue('42');
    const { backend } = streamingBackend([
      [
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
          usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 60 },
        },
      ],
      [
        {
          choices: [{ index: 0, delta: { content: 'the answer' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 200, completion_tokens: 20, prompt_cache_hit_tokens: 90 },
        },
      ],
    ]);

    const info = (await runStream(backend, ChatModels.DEEPSEEK_FLASH, { tools: searchTool(toolFn) })).at(-1)!.info;

    expect(info.cacheReadInputTokens).toBe(150);
    expect(info.inputTokens).toBe(150);
    expect(info.outputTokens).toBe(30);
  });

  it('surfaces cacheStats on the terminal frame, not only in the log', async () => {
    // Every per-chunk callback fires before the terminal usage chunk is read, so
    // a stream had no frame carrying cacheStats at all. Streaming is the default,
    // so that was every DeepSeek turn: the telemetry existed only in CloudWatch.
    const { backend } = streamingBackend([
      [
        {
          choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 80 },
        },
      ],
    ]);

    const frames = await runStream(backend, ChatModels.DEEPSEEK_FLASH, { cacheStrategy: { enableCaching: true } });
    const info = frames.at(-1)!.info;

    expect(info.cacheStats?.cacheReadTokens).toBe(80);
    expect(info.cacheStats?.totalInputTokens).toBe(100);
    // The extra frame must not restate the counts as new usage.
    expect(info.inputTokens).toBe(20);
    expect(info.cacheReadInputTokens).toBe(80);
    expect(info.outputTokens).toBe(5);
    expect(frames.at(-1)!.text.join('')).toBe('');
  });

  it('keeps the prose from a delta that carries the monologue tail and the answer together', async () => {
    // The reasoning branch used to return before the block-closing branch ever
    // ran, so a chunk holding both fields lost its content silently - no error,
    // just a missing first word. DeepSeek reasons on every turn, so the only
    // thing making this rare is the provider's chunk boundaries.
    const { backend } = streamingBackend([
      [
        { choices: [{ index: 0, delta: { reasoning_content: 'thinking' } }] },
        { choices: [{ index: 0, delta: { reasoning_content: ' more', content: 'The answer' } }] },
        {
          choices: [{ index: 0, delta: { content: ' is 42' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      ],
    ]);

    const frames = await runStream(backend, ChatModels.DEEPSEEK_FLASH);
    const joined = frames
      .flatMap(f => f.text)
      .filter(Boolean)
      .join('');

    expect(joined).toBe('<think>thinking more</think>The answer is 42');
  });

  it('does not degrade a streamed turn to non-streaming for an n it cannot serve', async () => {
    // n is absent from DeepSeek's schema either way, so dropping streaming bought
    // nothing and cost the caller the live response.
    const { backend, create } = streamingBackend([
      [
        {
          choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      ],
    ]);

    await runStream(backend, ChatModels.DEEPSEEK_FLASH, { n: 3 });

    const request = create.mock.calls[0][0] as Record<string, unknown>;
    expect(request.stream).toBe(true);
    expect(request).not.toHaveProperty('n');
  });
});
