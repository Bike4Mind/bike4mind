import { describe, it, expect, vi } from 'vitest';
import { ChatModels, type IMessage } from '@bike4mind/common';
import { KimiBackend } from './kimiBackend';
import { buildIdentityReminder } from './identityReminder';

const MODEL = ChatModels.KIMI_K2_6;
const REMINDER = buildIdentityReminder(MODEL);

type SentMessage = { role: string; content: unknown };

function capturingBackend() {
  const backend = new KimiBackend('test-key');
  const requests: Array<{ messages: SentMessage[] }> = [];
  const create = vi.fn().mockImplementation(async (params: { messages: SentMessage[] }) => {
    requests.push(params);
    return {
      choices: [{ index: 0, message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
  });
  (backend as unknown as { _api: unknown })._api = { chat: { completions: { create } } };
  return { backend, requests };
}

async function send(messages: IMessage[], options: Record<string, unknown> = {}): Promise<SentMessage[]> {
  const { backend, requests } = capturingBackend();
  await backend.complete(MODEL, messages, { stream: false, ...options }, async () => {});
  return requests[0].messages;
}

describe('KimiBackend identity reminder', () => {
  it('appends the reminder to the system message by default', async () => {
    const messages = await send([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hi' },
    ]);

    expect(messages[0]).toMatchObject({ role: 'system', content: `You are terse.\n\n${REMINDER}` });
  });

  it('appends the reminder to the last system message only', async () => {
    const messages = await send([
      { role: 'system', content: 'first layer' },
      { role: 'system', content: 'last layer' },
      { role: 'user', content: 'hi' },
    ]);

    expect(messages).toEqual([
      { role: 'system', content: 'first layer' },
      { role: 'system', content: `last layer\n\n${REMINDER}` },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('prepends a system message when the call carries none', async () => {
    const messages = await send([{ role: 'user', content: 'hi' }]);

    expect(messages[0]).toMatchObject({ role: 'system', content: REMINDER });
  });

  it('sends no reminder when the caller opts out', async () => {
    const messages = await send([{ role: 'user', content: 'hi' }], { omitIdentityReminder: true });

    expect(messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('sends the caller system message unappended when the caller opts out', async () => {
    const messages = await send(
      [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'hi' },
      ],
      { omitIdentityReminder: true }
    );

    expect(messages).toEqual([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hi' },
    ]);
  });
});
