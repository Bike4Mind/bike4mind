import { describe, it, expect } from 'vitest';
import type { IMessage } from '@bike4mind/common';
import { appendIdentityReminderToMessages, buildIdentityReminder } from './identityReminder';

const REMINDER = buildIdentityReminder('some-model');

describe('appendIdentityReminderToMessages', () => {
  it('joins the reminder onto the last system message rather than adding one', () => {
    const messages: IMessage[] = [
      { role: 'system', content: 'first system layer' },
      { role: 'system', content: 'last system layer' },
      { role: 'user', content: 'hi' },
    ];

    const result = appendIdentityReminderToMessages(messages, REMINDER);

    expect(result).toHaveLength(3);
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toEqual({ role: 'system', content: `last system layer\n\n${REMINDER}` });
  });

  it('prepends a system message when the array has none', () => {
    const result = appendIdentityReminderToMessages([{ role: 'user', content: 'hi' }], REMINDER);

    expect(result).toEqual([
      { role: 'system', content: REMINDER },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('prepends when the last system message content is not plain text', () => {
    const messages: IMessage[] = [
      { role: 'system', content: [{ type: 'text', text: 'block content' }] },
      { role: 'user', content: 'hi' },
    ];

    const result = appendIdentityReminderToMessages(messages, REMINDER);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: 'system', content: REMINDER });
  });

  // Tool-round recursion re-sends the caller's array; a mutation would stack one reminder per round.
  it('returns a new array and leaves the input untouched', () => {
    const messages: IMessage[] = [
      { role: 'system', content: 'system layer' },
      { role: 'user', content: 'hi' },
    ];
    const snapshot = JSON.parse(JSON.stringify(messages));

    const result = appendIdentityReminderToMessages(messages, REMINDER);

    expect(result).not.toBe(messages);
    expect(messages).toEqual(snapshot);
    expect(result).toHaveLength(messages.length);
  });
});
