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
const summary = { id: 's1', model: 'local:ollama:qwen' } as ChatSessionSummary;
const settleLocalModel = vi.fn();
const onSummaryChanged = vi.fn();
let root: Root;
let host: HTMLElement;
let conversation: ConversationController;

function Harness({ id = 's1' }: { id?: string }) {
  conversation = useConversation(id, onSummaryChanged);
  return null;
}

beforeEach(() => {
  settleLocalModel.mockReset();
  onSummaryChanged.mockReset();
  Object.assign(window, {
    b4m: {
      chat: {
        getSession: async (id: string) => ({ ...session, id }),
        settleLocalModel,
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

describe('settleLocalModel', () => {
  it('applies the model, the notice and the summary main returns', async () => {
    settleLocalModel.mockResolvedValue({ session: summary, notice: 'Switched.' });
    await act(async () => root.render(<Harness />));
    await act(async () => conversation.settleLocalModel());
    expect(settleLocalModel).toHaveBeenCalledWith('s1');
    expect(conversation.session?.model).toBe('local:ollama:qwen');
    expect(conversation.notice).toBe('Switched.');
    expect(onSummaryChanged).toHaveBeenCalledWith(summary);
  });

  it('changes nothing when main has nothing to settle', async () => {
    settleLocalModel.mockResolvedValue(null);
    await act(async () => root.render(<Harness />));
    await act(async () => conversation.settleLocalModel());
    expect(conversation.session?.model).toBe('local:');
    expect(conversation.notice).toBeNull();
    expect(onSummaryChanged).not.toHaveBeenCalled();
  });

  it('ignores a result that lands after another conversation was opened', async () => {
    let settle!: (value: unknown) => void;
    settleLocalModel.mockReturnValue(new Promise(done => (settle = done)));
    await act(async () => root.render(<Harness />));
    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = conversation.settleLocalModel();
    });
    await act(async () => root.render(<Harness id="s2" />));
    await act(async () => {
      settle({ session: summary, notice: 'Switched.' });
      await pending;
    });
    expect(conversation.session?.model).toBe('local:');
    expect(conversation.notice).toBeNull();
    expect(onSummaryChanged).not.toHaveBeenCalled();
  });
});
