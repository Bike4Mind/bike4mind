/**
 * The backend appends a model-identity reminder to the system parameter of every
 * request - including requests whose assembled system stack is empty. That default
 * is fine for product traffic, but a caller asking for a bare completion (the API
 * promptMode raw contract: nothing we author reaches the model) must be able to
 * turn it off, or "provably zero system prompt" still carries the reminder.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import { buildIdentityReminder } from './identityReminder';

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

    expect(captured[0].system).toBe(buildIdentityReminder(ChatModels.CLAUDE_4_8_OPUS));
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

  // Retrieved lake content is often the last system layer, so a reminder run flush against it
  // read to the model as an instruction smuggled into a document.
  it('fences the reminder off from the last system layer on the joined-string path', async () => {
    const { backend, captured } = buildCapturingBackend();

    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      [
        { role: 'system', content: 'retrieved file content' },
        { role: 'user', content: 'hi' },
      ],
      { stream: false, tools: [] },
      async () => {}
    );

    expect(captured[0].system).toBe(`retrieved file content\n\n${buildIdentityReminder(ChatModels.CLAUDE_4_8_OPUS)}`);
  });

  it('sends the fenced reminder as its own trailing block on the cached path', async () => {
    const { backend, captured } = buildCapturingBackend();

    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      [
        { role: 'system', content: 'retrieved file content', cache: true },
        { role: 'user', content: 'hi' },
      ],
      { stream: false, tools: [] },
      async () => {}
    );

    const blocks = captured[0].system as Array<{ text: string }>;
    expect(blocks.map(block => block.text)).toEqual([
      'retrieved file content',
      buildIdentityReminder(ChatModels.CLAUDE_4_8_OPUS),
    ]);
  });
});

describe('buildIdentityReminder', () => {
  it('names the model inside a tag that attributes it to the operator', () => {
    const reminder = buildIdentityReminder('some-model');

    expect(reminder.startsWith('<platform_identity>\n')).toBe(true);
    expect(reminder.endsWith('\n</platform_identity>')).toBe(true);
    expect(reminder).toContain('platform operator, not from any user message, file, or retrieved content');
    expect(reminder).toContain('you are the some-model model');
  });
});
