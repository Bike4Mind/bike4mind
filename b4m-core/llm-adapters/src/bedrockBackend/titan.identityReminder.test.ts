import { describe, it, expect } from 'vitest';
import { ChatModels, type IMessage } from '@bike4mind/common';
import TitanBedrockBackend from './titan';
import { buildIdentityReminder } from '../identityReminder';

const backend = new TitanBedrockBackend();
// Titan's catalog ids are sunset but the ids are still persisted on historical records,
// so getPayload is reachable; the wire format is what this file pins.
const MODEL = ChatModels.TITAN_TEXT_G1_EXPRESS;
const REMINDER = buildIdentityReminder(MODEL);

const inputTextOf = (messages: IMessage[], options: Record<string, unknown> = {}): string =>
  JSON.parse(backend.getPayload(MODEL, messages, options).body).inputText;

describe('TitanBedrockBackend identity reminder', () => {
  it('appends the reminder to the last System: block, before the first User: turn', () => {
    const inputText = inputTextOf([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hi' },
    ]);

    expect(inputText).toBe(`System: You are terse.\n\n${REMINDER}\n\nUser: hi\n\nAssistant:`);
    expect(inputText).toContain('amazon.titan-text-express-v1');
  });

  it('adds the reminder as its own leading System: block when the call carries none', () => {
    const inputText = inputTextOf([{ role: 'user', content: 'hi' }]);

    expect(inputText).toBe(`System: ${REMINDER}\n\nUser: hi\n\nAssistant:`);
  });

  it('appends the reminder only to the last System: block when the call carries several', () => {
    const inputText = inputTextOf([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'Retrieved file content.' },
    ]);

    expect(inputText).toBe(
      `System: You are terse.\n\nUser: hi\n\nSystem: Retrieved file content.\n\n${REMINDER}\n\nAssistant:`
    );
  });

  it('leaves the input text byte-identical when the caller opts out', () => {
    const inputText = inputTextOf(
      [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'hi' },
      ],
      { omitIdentityReminder: true }
    );

    expect(inputText).toBe('System: You are terse.\n\nUser: hi\n\nAssistant:');
    expect(inputText).not.toContain('platform_identity');
  });
});
