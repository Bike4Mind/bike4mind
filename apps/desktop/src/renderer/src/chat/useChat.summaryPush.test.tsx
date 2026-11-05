// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession, ChatSessionSummary } from '@shared/chat';
import { useConversation, type ConversationController } from './useChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const at = '2026-10-01T00:00:00.000Z';
const empty: ChatSession = {
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
const answered: ChatSession = {
  ...empty,
  messages: [
    { id: 'u1', role: 'user', content: 'hello', createdAt: at },
    {
      id: 'a1',
      role: 'assistant',
      content: 'Hi   there',
      createdAt: at,
      usage: { inputTokens: 1, outputTokens: 1, usdCost: 0.25, creditsUsed: 3 },
    },
  ],
} as ChatSession;

const onSummaryChanged = vi.fn<(summary: ChatSessionSummary) => void>();
const getSession = vi.fn();
let root: Root;
let host: HTMLElement;
let conversation: ConversationController;

function Harness() {
  conversation = useConversation('s1', onSummaryChanged);
  return null;
}

beforeEach(() => {
  onSummaryChanged.mockReset();
  getSession.mockReset().mockResolvedValue(empty);
  Object.assign(window, {
    b4m: {
      chat: {
        getSession,
        sendMessage: async () => ({ ok: true, messageId: 'm1' }),
        getQueuedMessages: async () => [],
        onSessionSummary: () => () => {},
        onQueueChanged: () => () => {},
        onStreamEvent: () => () => {},
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

describe('the summary pushed after a send', () => {
  it('carries the outcome, snippet and cost totals the sidebar and roster read', async () => {
    await act(async () => root.render(<Harness />));
    getSession.mockResolvedValue(answered);
    await act(async () => {
      await conversation.send('hello');
    });

    const pushed = onSummaryChanged.mock.calls.at(-1)?.[0];
    expect(pushed).toMatchObject({
      id: 's1',
      messageCount: 2,
      lastOutcome: 'finished',
      lastSnippet: 'Hi there',
      totalUsdCost: 0.25,
      totalCredits: 3,
    });
    expect(pushed).not.toHaveProperty('messages');
  });
});
