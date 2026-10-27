// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession, ChatSessionSummary, ChatStreamEvent } from '@shared/chat';
import { useConversation, type ConversationController } from './useChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const at = '2026-10-01T00:00:00.000Z';
const session: ChatSession = {
  id: 's1',
  title: 'Chat',
  model: 'local:',
  mode: 'chat',
  approvalMode: 'ask',
  reasoningEffort: 'default',
  createdAt: at,
  updatedAt: at,
  messages: [],
};
const sendMessage = vi.fn();
let root: Root;
let host: HTMLElement;
let conversation: ConversationController;

function Harness({ id = 's1' }: { id?: string }) {
  conversation = useConversation(id, () => {});
  return null;
}

beforeEach(() => {
  sendMessage.mockReset();
  Object.assign(window, {
    b4m: {
      chat: {
        getSession: async () => session,
        sendMessage,
        getQueuedMessages: async () => [],
        onSessionSummary: (_listener: (summary: ChatSessionSummary) => void) => () => {},
        onQueueChanged: () => () => {},
        onStreamEvent: (_listener: (event: ChatStreamEvent) => void) => () => {},
      },
      claudeImport: { onSessionsChanged: () => () => {} },
    },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('a refused send', () => {
  it('reports false, shows the error, drops the optimistic message and hands the text back', async () => {
    sendMessage.mockResolvedValue({ ok: false, error: 'No local model is available.' });
    await act(async () => root.render(<Harness />));

    let sent: boolean | undefined;
    await act(async () => {
      sent = await conversation.send('keep this draft');
    });

    expect(sent).toBe(false);
    expect(conversation.sendError).toBe('No local model is available.');
    expect(conversation.messages).toEqual([]);
    expect(conversation.returned?.messages.map(message => message.text)).toEqual(['keep this draft']);
  });

  it('reports true when main accepts the turn', async () => {
    sendMessage.mockResolvedValue({ ok: true, messageId: 'm1' });
    await act(async () => root.render(<Harness />));
    let sent: boolean | undefined;
    await act(async () => {
      sent = await conversation.send('hello');
    });
    expect(sent).toBe(true);
    expect(conversation.returned).toBeNull();
  });

  it('does not hand the text to another conversation opened before the refusal', async () => {
    let refuse!: (value: { ok: false; error: string }) => void;
    sendMessage.mockReturnValue(new Promise(done => (refuse = done)));
    await act(async () => root.render(<Harness />));
    let sent: Promise<boolean> | undefined;
    await act(async () => {
      sent = conversation.send('for the first one');
    });
    await act(async () => root.render(<Harness id="s2" />));
    await act(async () => {
      refuse({ ok: false, error: 'No local model is available.' });
      await sent;
    });
    expect(conversation.returned).toBeNull();
  });
});
