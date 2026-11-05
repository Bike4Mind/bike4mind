// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession, ChatSessionSummary, ChatStreamEvent } from '@shared/chat';
import { useConversation, useSessions, type ConversationController, type SessionsController } from './useChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const at = '2026-10-01T00:00:00.000Z';
const sessionNamed = (id: string): ChatSession => ({
  id,
  title: id,
  model: 'local:',
  mode: 'chat',
  approvalMode: 'ask',
  reasoningEffort: 'default',
  createdAt: at,
  updatedAt: at,
  messages: [],
});
let root: Root;
let host: HTMLElement;
let conversation: ConversationController;
let sessions: SessionsController;
let listeners: ((event: ChatStreamEvent) => void)[] = [];
const emit = (event: ChatStreamEvent) => listeners.forEach(listener => listener(event));

function Harness({ id }: { id: string }) {
  conversation = useConversation(id, () => {});
  sessions = useSessions();
  return null;
}

const noticeFor = (sessionId: string): ChatStreamEvent => ({
  type: 'context-notice',
  sessionId,
  message: `notice for ${sessionId}`,
});

beforeEach(() => {
  Object.assign(window, {
    b4m: {
      chat: {
        getSession: async (id: string) => sessionNamed(id),
        listSessions: async () => [],
        deleteSession: vi.fn(async () => undefined),
        getQueuedMessages: async () => [],
        onSessionSummary: (_listener: (summary: ChatSessionSummary) => void) => () => {},
        onQueueChanged: () => () => {},
        onStreamEvent: (listener: (event: ChatStreamEvent) => void) => {
          listeners.push(listener);
          return () => {
            listeners = listeners.filter(item => item !== listener);
          };
        },
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

describe('a context notice for a conversation that is not open', () => {
  it('shows when that conversation opens, once', async () => {
    await act(async () => root.render(<Harness id="open" />));
    await act(async () => emit(noticeFor('away')));
    expect(conversation.notice).toBeNull();

    await act(async () => root.render(<Harness id="away" />));
    expect(conversation.notice).toBe('notice for away');

    await act(async () => root.render(<Harness id="open" />));
    await act(async () => root.render(<Harness id="away" />));
    expect(conversation.notice).toBeNull();
  });

  it('is dropped when the conversation is deleted', async () => {
    await act(async () => root.render(<Harness id="open" />));
    await act(async () => emit(noticeFor('gone')));
    await act(async () => {
      await sessions.remove('gone');
    });

    await act(async () => root.render(<Harness id="gone" />));
    expect(conversation.notice).toBeNull();
  });
});
