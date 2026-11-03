// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession, ChatSessionSummary, ChatStreamEvent } from '@shared/chat';
import type { GenerationSettings } from '@shared/generation';
import { useConversation, type ConversationController } from './useChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const at = '2026-10-01T00:00:00.000Z';
const session: ChatSession = {
  id: 's1',
  title: 'Chat',
  model: 'local:ollama:qwen3:8b',
  mode: 'chat',
  approvalMode: 'ask',
  reasoningEffort: 'default',
  generation: { temperature: 0.4 },
  createdAt: at,
  updatedAt: at,
  messages: [],
};
const setSessionGeneration = vi.fn(async (_id: string, generation: GenerationSettings): Promise<ChatSessionSummary> => {
  const { messages: _messages, ...meta } = session;
  const { generation: _old, ...rest } = meta;
  return { ...rest, ...(Object.keys(generation).length > 0 ? { generation } : {}), messageCount: 0 };
});
let root: Root;
let host: HTMLElement;
let conversation: ConversationController;

function Harness() {
  conversation = useConversation('s1', () => {});
  return null;
}

beforeEach(() => {
  setSessionGeneration.mockClear();
  Object.assign(window, {
    b4m: {
      chat: {
        getSession: async () => session,
        setSessionGeneration,
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

describe('a conversation generation settings', () => {
  it('reopens with the stored overrides, and saves and clears them through main', async () => {
    await act(async () => root.render(<Harness />));
    expect(conversation.session?.generation).toEqual({ temperature: 0.4 });

    await act(async () => conversation.setGeneration({ temperature: 0.4, topK: 20 }));
    expect(setSessionGeneration).toHaveBeenLastCalledWith('s1', { temperature: 0.4, topK: 20 });
    expect(conversation.session?.generation).toEqual({ temperature: 0.4, topK: 20 });

    await act(async () => conversation.setGeneration({}));
    expect(conversation.session?.generation).toBeUndefined();
  });
});
