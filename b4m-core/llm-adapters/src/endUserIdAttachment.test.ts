/**
 * Verifies the backends actually attach the per-end-user identifier to
 * outbound provider requests: Anthropic `metadata.user_id` and OpenAI
 * `safety_identifier`. The params builders in both backends are large and
 * heavily branched, so these tests capture the constructed request params via
 * the SDK-mocking pattern from responseFormat.test.ts and assert the field is
 * present when the backend is constructed with an end-user id, and absent when
 * it is not.
 */

import { describe, it, expect } from 'vitest';
import { Stream } from 'openai/streaming';
import { AnthropicBackend } from './anthropicBackend';
import { OpenAIBackend } from './openaiBackend';
import { toProviderEndUserId } from './endUserId';

const END_USER_ID = '507f1f77bcf86cd799439011';
const HASHED = toProviderEndUserId(END_USER_ID)!;

// ─── helpers ───────────────────────────────────────────────────────

function asyncIterable(events: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    controller: { abort: () => {} },
  };
}

function asOpenAIStream(events: unknown[]): Stream<unknown> {
  const s = asyncIterable(events);
  Object.setPrototypeOf(s, Stream.prototype);
  return s as unknown as Stream<unknown>;
}

const noopCb = async () => {};

const ANTHROPIC_STREAM_EVENTS = [
  { type: 'message_start' },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 } },
  { type: 'message_stop' },
];

function buildAnthropicBackend(endUserId?: string) {
  const backend = new AnthropicBackend('test-key', undefined, endUserId);
  let lastApiParams: any = null; // any: raw captured request params
  (backend as unknown as { _api: any })._api = {
    messages: {
      create: async (params: unknown) => {
        lastApiParams = params;
        return asyncIterable(ANTHROPIC_STREAM_EVENTS);
      },
    },
  };
  return { backend, getApiParams: () => lastApiParams };
}

const OPENAI_STREAM_EVENTS = [
  { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }], usage: null },
  {
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
];

function buildOpenAIBackend(endUserId?: string) {
  const backend = new OpenAIBackend('test-key', undefined, endUserId);
  let lastParams: any = null; // any: raw captured request params
  (backend as unknown as { _api: any })._api = {
    chat: {
      completions: {
        create: async (params: unknown) => {
          lastParams = params;
          return asOpenAIStream(OPENAI_STREAM_EVENTS);
        },
      },
    },
  };
  return { backend, getParams: () => lastParams };
}

// ─── AnthropicBackend: metadata.user_id ────────────────────────────

describe('AnthropicBackend end-user attribution', () => {
  it('attaches metadata.user_id when constructed with an end-user id', async () => {
    const { backend, getApiParams } = buildAnthropicBackend(HASHED);
    await backend.complete(
      'claude-sonnet-4-5-20250929',
      [{ role: 'user', content: 'hi' }],
      { stream: true, executeTools: false },
      noopCb
    );
    expect(getApiParams().metadata).toEqual({ user_id: HASHED });
  });

  it('omits metadata entirely when no end-user id is set', async () => {
    const { backend, getApiParams } = buildAnthropicBackend(undefined);
    await backend.complete(
      'claude-sonnet-4-5-20250929',
      [{ role: 'user', content: 'hi' }],
      { stream: true, executeTools: false },
      noopCb
    );
    expect(getApiParams()).not.toHaveProperty('metadata');
  });
});

// ─── OpenAIBackend: safety_identifier ──────────────────────────────

describe('OpenAIBackend end-user attribution', () => {
  it('attaches safety_identifier when constructed with an end-user id', async () => {
    const { backend, getParams } = buildOpenAIBackend(HASHED);
    await backend.complete('gpt-4o', [{ role: 'user', content: 'hi' }], { stream: true, executeTools: false }, noopCb);
    expect(getParams().safety_identifier).toBe(HASHED);
  });

  it('omits safety_identifier when no end-user id is set', async () => {
    const { backend, getParams } = buildOpenAIBackend(undefined);
    await backend.complete('gpt-4o', [{ role: 'user', content: 'hi' }], { stream: true, executeTools: false }, noopCb);
    expect(getParams()).not.toHaveProperty('safety_identifier');
  });
});
