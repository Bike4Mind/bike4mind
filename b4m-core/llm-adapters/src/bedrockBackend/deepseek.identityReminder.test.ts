import { describe, it, expect } from 'vitest';
import { ChatModels, type IMessage } from '@bike4mind/common';
import DeepSeekBedrockBackend from './deepseek';
import { buildIdentityReminder } from '../identityReminder';

const backend = new DeepSeekBedrockBackend();
const MODEL = ChatModels.DEEPSEEK_R1_BEDROCK;
const REMINDER = buildIdentityReminder(MODEL);

type ConverseBody = {
  system?: Array<{ text: string }>;
  messages: Array<{ role: string; content: Array<{ text: string }> }>;
};

const payloadOf = (messages: IMessage[], options: Record<string, unknown> = {}): ConverseBody =>
  JSON.parse(backend.getPayload(MODEL, messages, options).body);

describe('DeepSeekBedrockBackend identity reminder', () => {
  it('appends the reminder to the Converse system field by default', () => {
    const body = payloadOf([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hi' },
    ]);

    expect(body.system?.[0].text).toBe(`You are terse.\n\n${REMINDER}`);
  });

  it('appends one reminder after the final caller system layer', () => {
    const body = payloadOf([
      { role: 'system', content: 'first' },
      { role: 'system', content: 'last' },
      { role: 'user', content: 'hi' },
    ]);

    expect(body.system?.[0].text).toBe(`first\nlast\n\n${REMINDER}`);
  });

  it('adds the reminder as a system field when the caller supplies only user turns', () => {
    const body = payloadOf([{ role: 'user', content: 'hi' }]);

    expect(body.system).toEqual([{ text: REMINDER }]);
    expect(body.messages).toEqual([{ role: 'user', content: [{ text: 'hi' }] }]);
  });

  it('carries the reminder into the demoted user turn when the payload is system-only', () => {
    const body = payloadOf([{ role: 'system', content: 'Summarise this session.' }]);

    expect(body.system).toBeUndefined();
    expect(body.messages).toEqual([{ role: 'user', content: [{ text: `Summarise this session.\n\n${REMINDER}` }] }]);
  });

  it('sends no system field when the reminder is omitted and the caller supplied none', () => {
    const body = payloadOf([{ role: 'user', content: 'hi' }], { omitIdentityReminder: true });

    expect(body.system).toBeUndefined();
  });

  it('sends the caller system text unappended when the reminder is omitted', () => {
    const body = payloadOf(
      [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'hi' },
      ],
      { omitIdentityReminder: true }
    );

    expect(body.system?.[0].text).toBe('You are terse.');
  });
});
