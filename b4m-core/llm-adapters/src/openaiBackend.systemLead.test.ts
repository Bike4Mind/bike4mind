/**
 * Wire-level check that complete() sends the consolidated lead system message on both OpenAI
 * endpoints. openaiBackend.formatMessages.test.ts pins the composition by calling formatMessages
 * directly; this pins that each endpoint's call site actually uses it.
 */

import { describe, expect, it, vi } from 'vitest';
import { BadRequestError, ChatModels, type ICompletionOptionTools, type IMessage } from '@bike4mind/common';
import { OpenAIBackend } from './openaiBackend';
import { buildIdentityReminder } from './identityReminder';

type AnyRecord = Record<string, unknown>;

const CALLER_SYSTEM = 'ORG AUTHORITY: The active organization is Acme Corp.';

const tool: ICompletionOptionTools = {
  toolSchema: { name: 'lookup', description: 'Look something up.', parameters: { type: 'object', properties: {} } },
};

function buildBackend() {
  const backend = new OpenAIBackend('test-key');
  const chatCreate = vi.fn(async (_params: AnyRecord) => ({
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
    usage: { prompt_tokens: 5, completion_tokens: 3 },
  }));
  const responsesCreate = vi.fn(async (_params: AnyRecord) =>
    (async function* () {
      yield {
        type: 'response.completed',
        response: {
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      };
    })()
  );
  (backend as unknown as { _api: unknown })._api = {
    chat: { completions: { create: chatCreate } },
    responses: { create: responsesCreate },
  };
  return { backend, chatCreate, responsesCreate };
}

describe('OpenAIBackend lead system message on the wire', () => {
  it.each([
    ['system-only', [{ role: 'system', content: CALLER_SYSTEM }] as IMessage[]],
    ['blank string', [{ role: 'user', content: '  \n ' }] as IMessage[]],
    ['blank text block', [{ role: 'assistant', content: [{ type: 'text', text: '\t' }] }] as IMessage[]],
  ])('rejects %s before either provider endpoint is called', async (_label, messages) => {
    const { backend, chatCreate, responsesCreate } = buildBackend();

    await expect(backend.complete(ChatModels.GPT5_4, messages, {}, async () => {})).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: 400,
      message: 'request must contain at least one non-empty user or assistant message',
    });
    expect(chatCreate).not.toHaveBeenCalled();
    expect(responsesCreate).not.toHaveBeenCalled();
  });

  it('keeps a native assistant tool-call turn substantive when its text content is null', async () => {
    const { backend, chatCreate } = buildBackend();
    const messages = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
      },
    ] as IMessage[];

    await backend.complete(ChatModels.GPT5_4, messages, {}, async () => {});

    expect(chatCreate).toHaveBeenCalledOnce();
  });

  it('Chat Completions: caller system text, then the identity reminder', async () => {
    const { backend, chatCreate } = buildBackend();

    await backend.complete(
      ChatModels.GPT5_4,
      [
        { role: 'system', content: CALLER_SYSTEM },
        { role: 'user', content: 'hi' },
      ],
      {},
      async () => {}
    );

    const { messages } = chatCreate.mock.calls[0][0] as { messages: AnyRecord[] };
    expect(messages[0]).toEqual({
      role: 'system',
      content: `${CALLER_SYSTEM}\n\n${buildIdentityReminder(ChatModels.GPT5_4)}`,
    });
  });

  it('Chat Completions: an older model with tools gets only the reminder, no tool protocol', async () => {
    const { backend, chatCreate } = buildBackend();

    await backend.complete(ChatModels.GPT4_1, [{ role: 'user', content: 'hi' }], { tools: [tool] }, async () => {});

    const { messages } = chatCreate.mock.calls[0][0] as { messages: AnyRecord[] };
    expect(messages[0]).toEqual({ role: 'system', content: buildIdentityReminder(ChatModels.GPT4_1) });
  });

  it('Responses: the same lead reaches input[0]', async () => {
    const { backend, chatCreate, responsesCreate } = buildBackend();

    // GPT-5 with tools is routed to /v1/responses (see openaiBackend.dispatchProfile.test.ts).
    await backend.complete(
      ChatModels.GPT5,
      [
        { role: 'system', content: CALLER_SYSTEM },
        { role: 'user', content: 'hi' },
      ],
      { tools: [tool] },
      async () => {}
    );

    expect(chatCreate).not.toHaveBeenCalled();
    const { input } = responsesCreate.mock.calls[0][0] as { input: AnyRecord[] };
    expect(input[0]).toEqual({
      role: 'system',
      content: `${CALLER_SYSTEM}\n\n${buildIdentityReminder(ChatModels.GPT5)}`,
    });
  });

  it('Responses: tool-backed identity sends the caller system text with no reminder', async () => {
    const { backend, chatCreate, responsesCreate } = buildBackend();

    await backend.complete(
      ChatModels.GPT5,
      [
        { role: 'system', content: CALLER_SYSTEM },
        { role: 'user', content: 'hi' },
      ],
      { tools: [tool], identityViaTool: true },
      async () => {}
    );

    expect(chatCreate).not.toHaveBeenCalled();
    const { input } = responsesCreate.mock.calls[0][0] as { input: AnyRecord[] };
    expect(input[0]).toEqual({ role: 'system', content: CALLER_SYSTEM });
  });

  it('tool-backed identity: tools present drops the reminder, tools absent keeps it', async () => {
    const withTools = buildBackend();
    await withTools.backend.complete(
      ChatModels.GPT4_1,
      [{ role: 'user', content: 'hi' }],
      { identityViaTool: true, tools: [tool] },
      async () => {}
    );
    const sent = withTools.chatCreate.mock.calls[0][0] as { messages: AnyRecord[] };
    expect(sent.messages.some(m => m.role === 'system')).toBe(false);

    const withoutTools = buildBackend();
    await withoutTools.backend.complete(
      ChatModels.GPT4_1,
      [{ role: 'user', content: 'hi' }],
      { identityViaTool: true, tools: undefined },
      async () => {}
    );
    const kept = withoutTools.chatCreate.mock.calls[0][0] as { messages: AnyRecord[] };
    expect(kept.messages[0]).toEqual({ role: 'system', content: buildIdentityReminder(ChatModels.GPT4_1) });
  });

  it('raw lane sends no system message when the caller supplied none', async () => {
    const { backend, chatCreate } = buildBackend();

    await backend.complete(
      ChatModels.GPT5_4,
      [{ role: 'user', content: 'hi' }],
      { omitIdentityReminder: true },
      async () => {}
    );

    const { messages } = chatCreate.mock.calls[0][0] as { messages: AnyRecord[] };
    expect(messages.some(m => m.role === 'system')).toBe(false);
  });
});
