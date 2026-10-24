// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession, ChatStreamEvent } from '@shared/chat';
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
const streamed = new Set<(event: ChatStreamEvent) => void>();
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
  getSession.mockReset();
  getSession.mockResolvedValue(imported('old'));
  Object.assign(window, {
    b4m: {
      chat: {
        getSession,
        getQueuedMessages: async () => [],
        onSessionSummary: () => () => {},
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
