/**
 * OpenAI cached-input accounting.
 *
 * OpenAI's automatic prompt cache reports `cached_tokens` INSIDE `prompt_tokens`
 * (unlike Anthropic, where cache reads are disjoint from input). The adapter used
 * to capture that number and throw it away, so every warm turn settled at the full
 * input rate - a warm gpt-5.5 turn cost ~5x what OpenAI actually charged for it.
 *
 * These lock in the split the settlement path expects: `cacheReadInputTokens` is
 * the cached count and `inputTokens` is the uncached remainder, so the two are
 * disjoint and getTextModelCost can price each at its own rate.
 */

import { describe, it, expect, vi } from 'vitest';
import { ChatModels, getTextModelCost, type ICompletionOptions, type ICompletionOptionTools } from '@bike4mind/common';
import { Stream } from 'openai/streaming';
import { OpenAIBackend } from './openaiBackend';
import type { CompletionInfo } from './backend';

type AnyRecord = Record<string, unknown>;

type StreamChunk = {
  choices: Array<{ index: number; delta: AnyRecord; finish_reason?: string }>;
  usage?: AnyRecord;
};

/** An OpenAIBackend whose chat client yields the given streamed turns in order. */
function streamingBackend(turns: StreamChunk[][]) {
  const backend = new OpenAIBackend('test-key');
  let call = 0;
  const create = vi.fn().mockImplementation(async () => {
    const chunks = turns[Math.min(call, turns.length - 1)];
    call += 1;
    // The adapter branches on `response instanceof Stream`, so a bare async
    // generator would read as a non-streaming reply.
    const iterator = () =>
      (async function* () {
        for (const c of chunks) yield c;
      })();
    return new Stream(iterator as never, new AbortController());
  });
  (backend as unknown as { _api: unknown })._api = { chat: { completions: { create } } };
  return { backend, create };
}

/** An OpenAIBackend whose chat client returns canned non-streaming replies in order. */
function nonStreamingBackend(turns: AnyRecord[]) {
  const backend = new OpenAIBackend('test-key');
  let call = 0;
  const create = vi.fn().mockImplementation(async () => turns[Math.min(call++, turns.length - 1)]);
  (backend as unknown as { _api: unknown })._api = { chat: { completions: { create } } };
  return { backend, create };
}

/** Wraps a terminal Responses payload as the SSE event stream the adapter consumes. */
function toResponseStream(payload: AnyRecord): AsyncIterable<AnyRecord> {
  return (async function* () {
    yield { type: 'response.output_text.delta', delta: 'ok' };
    yield { type: 'response.completed', response: payload };
  })();
}

function responsesBackend(payloads: AnyRecord[], chatTurns: AnyRecord[] = []) {
  const backend = new OpenAIBackend('test-key');
  let call = 0;
  let chatCall = 0;
  const responsesCreate = vi.fn(async () => toResponseStream(payloads[Math.min(call++, payloads.length - 1)]));
  const chatCreate = vi.fn(async () => chatTurns[Math.min(chatCall++, chatTurns.length - 1)]);
  (backend as unknown as { _api: unknown })._api = {
    responses: { create: responsesCreate },
    chat: { completions: { create: chatCreate } },
  };
  return { backend, responsesCreate, chatCreate };
}

async function run(
  backend: OpenAIBackend,
  model: string,
  options: Partial<ICompletionOptions> = {}
): Promise<CompletionInfo[]> {
  const frames: CompletionInfo[] = [];
  await backend.complete(model, [{ role: 'user', content: 'hi' }], options, async (_text, info) => {
    frames.push(info);
  });
  return frames;
}

const sampleTool: ICompletionOptionTools = {
  toolSchema: {
    name: 'lookup',
    description: 'Look something up.',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  },
  toolFn: async () => 'result',
};

/** The last frame that actually carries usage - transient tool frames report zeros. */
const settled = (frames: CompletionInfo[]) => frames.at(-1)!;

describe('OpenAI streaming: cached prompt tokens', () => {
  it('splits a warm turn into the cached read and the uncached remainder', async () => {
    // The measured case from the field: 3,139 prompt tokens, 2,816 of them served
    // from cache. Before the fix both the discount and the field were dropped.
    const { backend } = streamingBackend([
      [
        {
          choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 3139,
            completion_tokens: 100,
            prompt_tokens_details: { cached_tokens: 2816 },
          },
        },
      ],
    ]);

    const info = settled(await run(backend, ChatModels.GPT5_5, { stream: true }));

    expect(info.cacheReadInputTokens).toBe(2816);
    expect(info.inputTokens).toBe(3139 - 2816);
    // Disjoint by construction: the two components must re-sum to what OpenAI billed.
    expect(info.inputTokens! + info.cacheReadInputTokens!).toBe(3139);
  });

  it('leaves a cold turn untouched, with no cache field to imply a discount', async () => {
    const { backend } = streamingBackend([
      [
        {
          choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3139, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } },
        },
      ],
    ]);

    const info = settled(await run(backend, ChatModels.GPT5_5, { stream: true }));

    expect(info.inputTokens).toBe(3139);
    expect(info.cacheReadInputTokens).toBeUndefined();
  });

  it('clamps a cached count that exceeds the prompt rather than crediting negative input', async () => {
    const { backend } = streamingBackend([
      [
        {
          choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 400 } },
        },
      ],
    ]);

    const info = settled(await run(backend, ChatModels.GPT5_5, { stream: true }));

    expect(info.inputTokens).toBe(0);
    expect(info.cacheReadInputTokens).toBe(100);
  });

  it('accumulates cache reads across tool-call recursion instead of reporting only the last turn', async () => {
    // Every OpenAI round-trip is billed independently, so a tool turn plus its
    // synthesis turn must report the SUM of both turns' cache reads.
    const { backend } = streamingBackend([
      [
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } },
        },
      ],
      [
        {
          choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1500, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 900 } },
        },
      ],
    ]);

    const info = settled(await run(backend, ChatModels.GPT4o, { stream: true, tools: [sampleTool] }));

    expect(info.cacheReadInputTokens).toBe(800 + 900);
    expect(info.inputTokens).toBe(1000 + 1500 - (800 + 900));
  });
});

describe('OpenAI non-streaming: cached prompt tokens', () => {
  it('splits the terminal turn the same way the streaming path does', async () => {
    const { backend } = nonStreamingBackend([
      {
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 1600 } },
      },
    ]);

    const info = settled(await run(backend, ChatModels.GPT4o, { stream: false }));

    expect(info.cacheReadInputTokens).toBe(1600);
    expect(info.inputTokens).toBe(400);
  });

  it('carries cache reads through executeTools:false without losing the discount', async () => {
    const { backend } = nonStreamingBackend([
      {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              tool_calls: [{ id: 't1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 900, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 700 } },
      },
    ]);

    const info = settled(
      await run(backend, ChatModels.GPT4o, { stream: false, tools: [sampleTool], executeTools: false })
    );

    expect(info.cacheReadInputTokens).toBe(700);
    expect(info.inputTokens).toBe(200);
  });
});

describe('OpenAI Responses API: cached prompt tokens', () => {
  it('splits input_tokens by input_tokens_details.cached_tokens', async () => {
    const { backend } = responsesBackend([
      {
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 5000, output_tokens: 200, input_tokens_details: { cached_tokens: 4200 } },
      },
    ]);

    const info = settled(await run(backend, ChatModels.GPT5, { tools: [sampleTool] }));

    expect(info.cacheReadInputTokens).toBe(4200);
    expect(info.inputTokens).toBe(800);
  });

  it('accumulates the Responses turn cache read into the chat synthesis turn', async () => {
    const { backend } = responsesBackend(
      [
        {
          output: [{ type: 'function_call', call_id: 'c1', name: 'lookup', arguments: '{}' }],
          usage: { input_tokens: 1000, output_tokens: 20, input_tokens_details: { cached_tokens: 600 } },
        },
      ],
      [
        {
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1200, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 500 } },
        },
      ]
    );

    const info = settled(await run(backend, ChatModels.GPT5, { tools: [sampleTool] }));

    expect(info.cacheReadInputTokens).toBe(600 + 500);
    expect(info.inputTokens).toBe(1000 + 1200 - (600 + 500));
  });
});

describe('OpenAI cached-input rates', () => {
  const modelById = async (id: string) => {
    const models = await new OpenAIBackend('test-key').getModelInfo();
    const model = models.find(m => m.id === id);
    if (!model) throw new Error(`model ${id} missing from getModelInfo()`);
    return model;
  };

  // Rates read from OpenAI's published pricing table on 2026-08-19
  // (https://developers.openai.com/api/docs/pricing). The CACHE_READ_MULTIPLIER
  // fallback is 0.1x, which matches the GPT-5 family but NOT the older ones - OpenAI
  // bills their cached input at 0.25x (4.1 family, o3, o4-mini) or 0.5x (4o family).
  // Publishing the real rate is what keeps the new discount from settling those models
  // BELOW what OpenAI charges us.
  it.each([
    [ChatModels.GPT4_1, 0.5],
    [ChatModels.GPT4_1_MINI, 0.1],
    [ChatModels.GPT4_1_NANO, 0.025],
    [ChatModels.GPT4o, 1.25],
    [ChatModels.GPT4o_MINI, 0.075],
    [ChatModels.O3, 0.5],
    [ChatModels.O4_MINI, 0.275],
  ])('publishes an explicit cache_read rate for %s', async (id, perMTok) => {
    const model = await modelById(id);
    const tier = model.pricing[Math.max(...Object.keys(model.pricing).map(Number))];
    expect(tier.cache_read).toBeCloseTo(perMTok / 1_000_000, 12);
  });

  it('prices a warm gpt-4o turn at the published cached rate, not the 0.1x default', async () => {
    const model = await modelById(ChatModels.GPT4o);
    const cost = getTextModelCost(model, 400, 0, 1600, 0);
    // 400 x $2.50/M + 1600 x $1.25/M
    expect(cost).toBeCloseTo((400 * 2.5 + 1600 * 1.25) / 1_000_000, 12);
  });

  it("leaves the GPT-5 family on the 0.1x default, matching OpenAI's published rate", async () => {
    const model = await modelById(ChatModels.GPT5_5);
    const tier = model.pricing[Math.max(...Object.keys(model.pricing).map(Number))];
    expect(tier.cache_read).toBeUndefined();
    // $5.00/M input -> $0.50/M cached, which is exactly what OpenAI publishes for
    // gpt-5.5 (verified 2026-08-19), so an explicit override would only be noise.
    expect(getTextModelCost(model, 0, 0, 1_000_000, 0)).toBeCloseTo(0.5, 6);
  });
});
