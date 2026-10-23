import { describe, it, expect } from 'vitest';
import { ChatModels, type IMessage } from '@bike4mind/common';
import MoonshotBedrockBackend from './moonshot';
import { buildIdentityReminder } from '../identityReminder';

const backend = new MoonshotBedrockBackend();
const MODEL = ChatModels.KIMI_K2_5_BEDROCK;
const REMINDER = buildIdentityReminder(MODEL);

type Body = { messages: Array<{ role: string; content: string | null }> };

const payloadOf = (messages: IMessage[], options: Record<string, unknown> = {}): Body =>
  JSON.parse(backend.getPayload(MODEL, messages, options).body);

describe('MoonshotBedrockBackend identity reminder', () => {
  it('appends the reminder to the last system message by default', () => {
    const body = payloadOf([
      { role: 'system', content: 'first layer' },
      { role: 'system', content: 'last layer' },
      { role: 'user', content: 'hi' },
    ]);

    expect(body.messages[1]).toEqual({ role: 'system', content: `last layer\n\n${REMINDER}` });
    expect(body.messages[0]).toEqual({ role: 'system', content: 'first layer' });
  });

  it('prepends a system message when the call carries none', () => {
    const body = payloadOf([{ role: 'user', content: 'hi' }]);

    expect(body.messages[0]).toEqual({ role: 'system', content: REMINDER });
  });

  it('sends no reminder when the caller opts out', () => {
    const body = payloadOf([{ role: 'user', content: 'hi' }], { omitIdentityReminder: true });

    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('sends the caller system message unappended when the caller opts out', () => {
    const body = payloadOf(
      [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'hi' },
      ],
      { omitIdentityReminder: true }
    );

    expect(body.messages).toEqual([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hi' },
    ]);
  });
});
