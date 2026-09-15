/**
 * Locks in the reasoning_effort gate, later widened to the whole GPT-5 reasoning
 * family.
 *
 * OpenAI's /v1/chat/completions breaks tool calling when function tools are
 * combined with `reasoning_effort` for the GPT-5 reasoning family. GPT-5.4
 * (and -mini/-nano) hard-reject with a 400 that directs callers to
 * /v1/responses; GPT-5 / -mini / -nano / 5.1 / 5.2 return 200 but silently
 * narrate the tool call instead of emitting a real `tool_calls` entry (the
 * /opti "Draft with AI" no-op). Until the Responses API is wired
 * up, the adapter drops `reasoning_effort` for the whole family when tools are
 * present. O-series (o1/o3/o4) is unaffected - it calls tools correctly with
 * `reasoning_effort` - and stays out of the gate.
 *
 * The base GPT-5 narrator family (gpt-5 / -mini / -nano / 5.1 / 5.2)
 * with tools routes to /v1/responses instead of chat.completions (see
 * openaiBackend.responsesRouting.test.ts), so it is intentionally NOT asserted here.
 *
 * Asserted matrix (chat.completions path only):
 *  - GPT-5.4 + tools            -> `reasoning_effort` omitted
 *  - GPT-5.4, no tools          -> `reasoning_effort` set
 *  - GPT-5.4-mini/-nano + tools -> omitted (whole 5.4 family)
 *  - GPT-5, no tools            -> `reasoning_effort` set (no tools => not routed)
 *  - O3 + tools                 -> still set (unaffected by the gate)
 */

import { describe, it, expect } from 'vitest';
import { ChatModels, type ICompletionOptions, type ICompletionOptionTools } from '@bike4mind/common';
import { OpenAIBackend } from './openaiBackend';

const SENTINEL = new Error('captured-params-sentinel');

type CapturedParams = Record<string, unknown> | null;

function buildBackend() {
  const backend = new OpenAIBackend('test-key');
  let captured: CapturedParams = null;
  (backend as unknown as { _api: unknown })._api = {
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          captured = params;
          // Throw a non-retryable sentinel so withRetry surfaces it immediately
          // and `complete()` aborts before touching the (absent) stream body.
          throw SENTINEL;
        },
      },
    },
  };
  return { backend, getCaptured: () => captured };
}

const sampleTool: ICompletionOptionTools = {
  toolSchema: {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
  execute: async () => 'sunny',
};

async function runComplete(backend: OpenAIBackend, model: string, options: Partial<ICompletionOptions>): Promise<void> {
  try {
    await backend.complete(model, [{ role: 'user', content: 'hi' }], options, async () => undefined);
  } catch (err) {
    if (err !== SENTINEL) throw err;
  }
}

describe('OpenAIBackend reasoning_effort gate for GPT-5.4 + tools (#8920)', () => {
  it('omits reasoning_effort for GPT-5.4 when function tools are present', async () => {
    const { backend, getCaptured } = buildBackend();

    await runComplete(backend, ChatModels.GPT5_4, {
      tools: [sampleTool],
      reasoningEffort: 'medium',
    });

    const params = getCaptured();
    expect(params).not.toBeNull();
    expect(params).toHaveProperty('tools');
    expect(params).not.toHaveProperty('reasoning_effort');
  });

  it('still sends reasoning_effort for GPT-5.4 when no tools are present', async () => {
    const { backend, getCaptured } = buildBackend();

    await runComplete(backend, ChatModels.GPT5_4, {
      reasoningEffort: 'medium',
    });

    const params = getCaptured();
    expect(params).not.toBeNull();
    expect(params).not.toHaveProperty('tools');
    expect(params?.reasoning_effort).toBe('medium');
  });

  it('omits reasoning_effort for GPT-5.4 Mini and Nano when tools are present', async () => {
    for (const model of [ChatModels.GPT5_4_MINI, ChatModels.GPT5_4_NANO]) {
      const { backend, getCaptured } = buildBackend();

      await runComplete(backend, model, {
        tools: [sampleTool],
        reasoningEffort: 'low',
      });

      const params = getCaptured();
      expect(params, `${model}: capture`).not.toBeNull();
      expect(params, `${model}: tools forwarded`).toHaveProperty('tools');
      expect(params, `${model}: reasoning_effort dropped`).not.toHaveProperty('reasoning_effort');
    }
  });

  // NOTE: the base GPT-5 narrator family (gpt-5 / -mini / -nano / 5.1 / 5.2) with tools
  // no longer reaches /v1/chat/completions at all - it routes to the Responses API
  // (RESPONSES_API_TOOL_MODELS). That routing is covered in
  // openaiBackend.responsesRouting.test.ts. The chat-path reasoning_effort drop for those
  // models remains as fallback but is unreachable while routing is active. Here we only
  // assert the still-on-chat cases: GPT-5 with NO tools, the GPT-5.4 family, and O-series.

  it('still sends reasoning_effort for GPT-5 when no tools are present', async () => {
    const { backend, getCaptured } = buildBackend();

    await runComplete(backend, ChatModels.GPT5, {
      reasoningEffort: 'medium',
    });

    const params = getCaptured();
    expect(params).not.toBeNull();
    expect(params).not.toHaveProperty('tools');
    expect(params?.reasoning_effort).toBe('medium');
  });

  it('still sends reasoning_effort for O3 (unaffected reasoning model) when tools are present', async () => {
    const { backend, getCaptured } = buildBackend();

    await runComplete(backend, ChatModels.O3, {
      tools: [sampleTool],
      reasoningEffort: 'high',
    });

    const params = getCaptured();
    expect(params).not.toBeNull();
    expect(params).toHaveProperty('tools');
    expect(params?.reasoning_effort).toBe('high');
  });
});
