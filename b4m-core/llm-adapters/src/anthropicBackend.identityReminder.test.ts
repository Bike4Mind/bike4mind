/**
 * The backend appends a model-identity reminder to the system parameter of every
 * request - including requests whose assembled system stack is empty. That default
 * is fine for product traffic, but a caller asking for a bare completion (the API
 * promptMode raw contract: nothing we author reaches the model) must be able to
 * turn it off, or "provably zero system prompt" tops out at seventeen tokens.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';

function buildCapturingBackend() {
  const backend = new AnthropicBackend('test-key');
  const captured: { system?: unknown }[] = [];
  (backend as unknown as { _api: unknown })._api = {
    messages: {
      create: async (params: { system?: unknown }) => {
        captured.push(params);
        return { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };
  return { backend, captured };
}

describe('AnthropicBackend identity reminder', () => {
  it('appends the reminder by default, even with no system messages', async () => {
    const { backend, captured } = buildCapturingBackend();

    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      [{ role: 'user', content: 'hi' }],
      { stream: false, tools: [] },
      async () => {}
    );

    expect(captured[0].system).toContain('you are specifically the');
  });

  it('sends NO system parameter when the caller omits the reminder and supplies no system messages', async () => {
    const { backend, captured } = buildCapturingBackend();

    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      [{ role: 'user', content: 'hi' }],
      {
        stream: false,
        tools: [],
        omitIdentityReminder: true,
      },
      async () => {}
    );

    expect(captured[0].system).toBeUndefined();
  });

  it('sends the caller system text verbatim, unappended, when the reminder is omitted', async () => {
    const { backend, captured } = buildCapturingBackend();

    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      [
        { role: 'system', content: 'caller-authored system text' },
        { role: 'user', content: 'hi' },
      ],
      { stream: false, tools: [], omitIdentityReminder: true },
      async () => {}
    );

    expect(captured[0].system).toBe('caller-authored system text');
  });
});
