import { describe, expect, it } from 'vitest';
import { OWNER_ONLY_CHAT_MESSAGE_FIELDS, redactChatMessageForViewer } from './chatMessage';

const message = () => ({
  id: 'q1',
  prompt: 'hello',
  pendingAction: { tool: 'send_email', params: { to: 'x' }, ts: 1 },
  promptMeta: {
    functionCalls: [{ name: 'search', parameters: {}, returnValue: 'tool output' }],
  },
});

describe('redactChatMessageForViewer', () => {
  it('returns the same message for the owner', () => {
    const owned = message();
    expect(redactChatMessageForViewer(owned, true)).toBe(owned);
  });

  it('drops every owner-only field and redacts promptMeta for a non-owner', () => {
    const redacted = redactChatMessageForViewer(message(), false);

    for (const field of OWNER_ONLY_CHAT_MESSAGE_FIELDS) expect(redacted).not.toHaveProperty(field);
    expect(redacted).toMatchObject({ id: 'q1', prompt: 'hello' });
    expect(redacted.promptMeta?.functionCalls?.[0]).toEqual({ name: 'search', parameters: {} });
  });

  it('does not mutate the input', () => {
    const input = message();
    redactChatMessageForViewer(input, false);

    expect(input.pendingAction).toBeDefined();
    expect(input.promptMeta.functionCalls[0]).toHaveProperty('returnValue', 'tool output');
  });

  it('tolerates a message without promptMeta', () => {
    expect(redactChatMessageForViewer({ id: 'q2', pendingAction: { tool: 't', params: {}, ts: 1 } }, false)).toEqual({
      id: 'q2',
      promptMeta: undefined,
    });
  });
});
