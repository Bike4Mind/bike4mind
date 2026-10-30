import { describe, it, expect } from 'vitest';
import { ChatModels, type IMessage } from '@bike4mind/common';
import LlamaBedrockBackend from './llama';
import { buildIdentityReminder } from '../identityReminder';

const backend = new LlamaBedrockBackend();
const MODEL = ChatModels.LLAMA3_INSTRUCT_70B_V1;
const REMINDER = buildIdentityReminder(MODEL);

const promptOf = (messages: IMessage[], options: Record<string, unknown> = {}): string =>
  JSON.parse(backend.getPayload(MODEL, messages, options).body).prompt;

describe('LlamaBedrockBackend identity reminder', () => {
  it('appends the reminder to the last System: block, before the first Human: turn', () => {
    const prompt = promptOf([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hi' },
    ]);

    expect(prompt).toBe(`System: You are terse.\n\n${REMINDER}\n\nHuman: hi\n\nAssistant:`);
  });

  it('adds the reminder as its own leading System: block when the call carries none', () => {
    const prompt = promptOf([{ role: 'user', content: 'hi' }]);

    expect(prompt).toBe(`System: ${REMINDER}\n\nHuman: hi\n\nAssistant:`);
  });

  it('appends the reminder only to the last System: block when the call carries several', () => {
    const prompt = promptOf([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'Retrieved file content.' },
    ]);

    expect(prompt).toBe(
      `System: You are terse.\n\nHuman: hi\n\nSystem: Retrieved file content.\n\n${REMINDER}\n\nAssistant:`
    );
  });

  it('leaves the prompt byte-identical when the caller opts out', () => {
    const prompt = promptOf(
      [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'hi' },
      ],
      { omitIdentityReminder: true }
    );

    expect(prompt).toBe('System: You are terse.\n\nHuman: hi\n\nAssistant:');
    expect(prompt).not.toContain('platform_identity');
  });
});
