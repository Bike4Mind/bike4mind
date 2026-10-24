// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession, ChatSessionSummary, ChatStreamEvent } from '@shared/chat';
import { useConversation, type ConversationController } from './useChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const at = '2026-10-01T00:00:00.000Z';
function imported(content: string): ChatSession {
  return {
    id: 'cc-import',
    title: 'Imported',
    model: 'm',
    mode: 'chat',
    approvalMode: 'ask',
    reasoningEffort: 'default',
    createdAt: at,
    updatedAt: at,
    importOrigin: { kind: 'claude-code', sourceId: 'import', importedAt: at, sourceUpdatedAt: at },
    messages: [{ id: 'cc-u', role: 'user', content, createdAt: at }],
  };
}
const changed = new Set<() => void>();
const summaries = new Set<(summary: ChatSessionSummary) => void>();
const streamed = new Set<(event: ChatStreamEvent) => void>();
const setSessionHistory = vi.fn();
const getSession = vi.fn<(id: string) => Promise<ChatSession | null>>();
let root: Root;
let host: HTMLElement;
let conversation: ConversationController;
function Harness({ id }: { id: string | null }) {
  conversation = useConversation(id, () => {});
  return <div>{conversation.messages.map(message => message.content).join(',')}</div>;
}
async function show(id = 'cc-import') {
  await act(async () => root.render(<Harness id={id} />));
}
async function push() {
  await act(async () => {
    for (const listener of changed) listener();
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  changed.clear();
  streamed.clear();
  summaries.clear();
  getSession.mockReset();
  setSessionHistory.mockReset();
  getSession.mockResolvedValue(imported('old'));
  Object.assign(window, {
    b4m: {
      chat: {
        getSession,
        setSessionHistory,
        getQueuedMessages: async () => [],
        onSessionSummary: (listener: (summary: ChatSessionSummary) => void) => {
          summaries.add(listener);
          return () => summaries.delete(listener);
        },
        onQueueChanged: () => () => {},
        onStreamEvent: (listener: (event: ChatStreamEvent) => void) => {
          streamed.add(listener);
          return () => streamed.delete(listener);
        },
      },
      claudeImport: {
        onSessionsChanged: (listener: () => void) => {
          changed.add(listener);
          return () => changed.delete(listener);
        },
      },
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
describe('open imported transcripts', () => {
  it('does not restore preparation from a read overtaken by workspace completion', async () => {
    const pending = deferred<ChatSession | null>();
    getSession.mockReturnValueOnce(pending.promise);
    await show();

    await act(async () => {
      for (const listener of streamed) {
        listener({ type: 'workspace', sessionId: 'cc-import', running: false, base: 'main' });
      }
      pending.resolve({ ...imported('old'), preparingWorkspace: { since: 1, base: 'main' } });
    });

    expect(conversation.preparing).toBeNull();
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('refreshes after source sync without replacing the user-selected model', async () => {
    await show();
    getSession.mockResolvedValue({
      ...imported('synced'),
      model: 'other',
      title: 'New source title',
      importOrigin: { ...imported('').importOrigin!, sourceUpdatedAt: '2026-10-02T00:00:00.000Z' },
    });
    await push();
    expect(host.textContent).toBe('synced');
    expect(conversation.session?.model).toBe('m');
    expect(conversation.session?.title).toBe('New source title');
    expect(conversation.session?.importOrigin?.sourceUpdatedAt).toBe('2026-10-02T00:00:00.000Z');
  });
  it('does not re-read ordinary conversations or continued imports', async () => {
    getSession.mockResolvedValue({ ...imported('own'), importOrigin: undefined });
    await show();
    await push();
    expect(getSession).toHaveBeenCalledTimes(1);
    getSession.mockResolvedValue({
      ...imported('continued'),
      importOrigin: { ...imported('').importOrigin!, forkedAt: at },
    });
    await show('cc-other');
    await push();
    expect(getSession).toHaveBeenCalledTimes(2);
  });
  it('ignores an older read that finishes after a newer sync', async () => {
    await show();
    const old = deferred<ChatSession | null>();
    getSession.mockReturnValueOnce(old.promise);
    await push();
    getSession.mockResolvedValue(imported('newest'));
    await push();
    await act(async () => old.resolve(imported('stale')));
    expect(host.textContent).toBe('newest');
  });
  it('does not replace a reply that starts while refresh is in flight', async () => {
    await show();
    const pending = deferred<ChatSession | null>();
    getSession.mockReturnValueOnce(pending.promise);
    await push();
    await act(async () => {
      for (const listener of streamed) listener({ type: 'start', sessionId: 'cc-import', messageId: 'own-reply' });
    });
    await act(async () => pending.resolve(imported('stale')));
    expect(host.textContent).toBe('old,');
    expect(conversation.streaming).toBe(true);
    expect(conversation.messages.at(-1)?.id).toBe('own-reply');
  });
  it('ignores a refresh that resolves after selecting another conversation', async () => {
    await show();
    const pending = deferred<ChatSession | null>();
    getSession.mockReturnValueOnce(pending.promise);
    await push();
    getSession.mockResolvedValue({ ...imported('another'), id: 'other' });
    await show('other');
    await act(async () => pending.resolve(imported('stale')));
    expect(host.textContent).toBe('another');
  });
  it('reports a failed refresh and keeps the last transcript', async () => {
    await show();
    getSession.mockRejectedValue(new Error('disk unavailable'));
    await push();
    expect(host.textContent).toBe('old');
    expect(conversation.sendError).toContain('disk unavailable');
  });
});

it('reports a failed history toggle without an unhandled rejection', async () => {
  await show();
  setSessionHistory.mockRejectedValue(new Error('Index unavailable'));
  await act(async () => {
    await conversation.setHistory(true);
  });
  expect(conversation.notice).toContain('Index unavailable');
  expect(conversation.session?.historyEnabled).not.toBe(true);
});

it('does not apply a history toggle response to a different conversation', async () => {
  await show();
  const pending = deferred<ChatSession>();
  setSessionHistory.mockReturnValue(pending.promise);
  let toggle!: Promise<void>;
  await act(async () => {
    toggle = conversation.setHistory(true);
  });
  getSession.mockResolvedValue({ ...imported('other'), id: 'other' });
  await show('other');
  await act(async () => {
    pending.resolve({ ...imported('old'), historyEnabled: true });
    await toggle;
  });
  expect(conversation.session?.id).toBe('other');
  expect(conversation.session?.historyEnabled).not.toBe(true);
});

it('keeps newer consent pushed by another window when an older toggle response arrives', async () => {
  await show();
  const pending = deferred<ChatSession>();
  setSessionHistory.mockReturnValue(pending.promise);
  let toggle!: Promise<void>;
  await act(async () => {
    toggle = conversation.setHistory(true);
  });
  const { messages: _messages, ...summary } = imported('old');
  await act(async () => {
    for (const listener of summaries) listener({ ...summary, messageCount: 1, historyEnabled: false });
    pending.resolve({ ...imported('old'), historyEnabled: true });
    await toggle;
  });
  expect(conversation.session?.historyEnabled).toBe(false);
});

it('does not change consent using the previous conversation while the selected one loads', async () => {
  await show();
  const pending = deferred<ChatSession | null>();
  getSession.mockReturnValue(pending.promise);
  await show('other');
  expect(conversation.session?.id).toBe('cc-import');
  await act(async () => conversation.setHistory(true));
  expect(setSessionHistory).not.toHaveBeenCalled();
  await act(async () => pending.resolve({ ...imported('other'), id: 'other' }));
});

it('applies history consent updates pushed by another window', async () => {
  await show();
  const { messages: _messages, ...summary } = imported('old');
  for (const enabled of [true, false]) {
    await act(async () => {
      for (const listener of summaries) listener({ ...summary, messageCount: 1, historyEnabled: enabled });
    });
    expect(conversation.session?.historyEnabled).toBe(enabled);
  }
});

it('re-reads consent when another window changes it during the initial session load', async () => {
  const pending = deferred<ChatSession | null>();
  getSession.mockReturnValueOnce(pending.promise);
  await show();
  const { messages: _messages, ...summary } = imported('old');
  getSession.mockResolvedValue({ ...imported('old'), historyEnabled: true });
  await act(async () => {
    for (const listener of summaries) listener({ ...summary, messageCount: 1, historyEnabled: true });
    pending.resolve(imported('old'));
  });
  expect(getSession).toHaveBeenCalledTimes(2);
  expect(conversation.session?.historyEnabled).toBe(true);
});
