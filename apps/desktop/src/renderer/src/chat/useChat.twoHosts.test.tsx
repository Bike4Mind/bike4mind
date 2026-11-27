// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession, ChatSessionSummary, ChatStreamEvent } from '@shared/chat';
import { LOCAL_HOST_ID } from '@shared/hostBridge';
import { chatBackedHostBridge, type FakeRemoteHostOptions } from '../__fixtures__/chatBackedHostBridge';
import { sessionDirectory, summaryHostId } from '../host/sessionDirectory';
import { sessionListCache } from '../host/sessionListCache';
import { groupSessions } from './grouping';
import { useConversation, useSessions, type ConversationController, type SessionsController } from './useChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEVBOX = 'devbox';

const summary = (id: string, directory: string, updatedAt = '2026-10-01T00:00:00.000Z'): ChatSessionSummary =>
  ({
    id,
    title: id,
    mode: 'code',
    messageCount: 1,
    createdAt: updatedAt,
    updatedAt,
    project: { directory, name: directory.split('/').pop() ?? directory, branch: 'main' },
  }) as ChatSessionSummary;

const remoteSession = (id: string): ChatSession =>
  ({
    id,
    title: id,
    mode: 'code',
    messages: [
      { id: 'p', role: 'user', content: 'hi', createdAt: '2026-10-01T00:00:00.000Z' },
      { id: 'r', role: 'assistant', content: 'Hi ', createdAt: '2026-10-01T00:00:00.000Z' },
    ],
    replyInFlight: { messageId: 'r', startedAt: 10 },
  }) as ChatSession;

/** Both hosts list a session in /work/repo; ids are unique per test, as the directory is shared. */
function stubTwoHosts(prefix: string, remote: Partial<FakeRemoteHostOptions> = {}) {
  const localRow = summary(`${prefix}-local`, '/work/repo', '2026-10-02T00:00:00.000Z');
  const remoteRow = summary(`${prefix}-remote`, '/work/repo');
  const bridge = chatBackedHostBridge({
    remote: {
      hostId: DEVBOX,
      label: 'Devbox',
      sessions: [remoteRow],
      answer: (method, params) =>
        method === 'session/get' && params.sessionId === remoteRow.id
          ? { session: remoteSession(remoteRow.id), cursor: { epoch: 'test', seq: 0 } }
          : method === 'queue/list'
            ? { queued: [] }
            : undefined,
      ...remote,
    },
  });
  vi.stubGlobal('b4m', {
    host: bridge,
    chat: {
      listSessions: async () => [localRow],
      getSession: vi.fn(async () => null),
      getQueuedMessages: async () => [],
      onStreamEvent: () => () => undefined,
    },
    claudeImport: { onSessionsChanged: () => () => undefined },
  });
  if (!bridge.remote) throw new Error('no remote host');
  return { bridge, remote: bridge.remote, localRow, remoteRow };
}

const roots: Root[] = [];

async function render<T>(useHook: () => T): Promise<() => T> {
  let latest: T | undefined;
  function Harness() {
    latest = useHook();
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  roots.push(root);
  await act(async () => root.render(<Harness />));
  await act(async () => undefined);
  return () => {
    if (latest === undefined) throw new Error('not rendered');
    return latest;
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe('sessions on a second host', () => {
  it('lists both hosts, stamps only the remote rows and groups the same folder twice', async () => {
    const { localRow, remoteRow } = stubTwoHosts('list');
    const sessions = await render<SessionsController>(() => useSessions());

    expect(sessions().sessions.map(row => [row.id, row.hostId])).toEqual([
      [localRow.id, undefined],
      [remoteRow.id, DEVBOX],
    ]);
    expect(sessions().hostListings.get(DEVBOX)).toBe('live');
    expect(sessionDirectory.hostOf(remoteRow.id)).toBe(DEVBOX);

    const { projects } = groupSessions(sessions().sessions, 'code');
    expect(projects.map(group => [group.hostId, group.directory])).toEqual([
      [LOCAL_HOST_ID, '/work/repo'],
      [DEVBOX, '/work/repo'],
    ]);
  });

  it('keeps an offline host rows from the cache, marked stale, and goes live again on reconnect', async () => {
    const { remote, remoteRow } = stubTwoHosts('offline');
    const sessions = await render<SessionsController>(() => useSessions());
    expect(sessionListCache.read(DEVBOX).map(row => row.id)).toEqual([remoteRow.id]);

    await act(async () => remote.setConnected(false));
    expect(sessions().hostListings.get(DEVBOX)).toBe('stale');
    expect(
      sessions()
        .sessions.filter(row => summaryHostId(row) === DEVBOX)
        .map(row => row.id)
    ).toEqual([remoteRow.id]);

    await act(async () => remote.setConnected(true));
    await act(async () => undefined);
    expect(sessions().hostListings.get(DEVBOX)).toBe('live');
  });

  it('shows the last cached list of a host that starts offline', async () => {
    const cached = summary('cached-remote', '/srv/api');
    sessionListCache.write(DEVBOX, [cached]);
    stubTwoHosts('cold', { connected: false });
    const sessions = await render<SessionsController>(() => useSessions());
    expect(sessions().hostListings.get(DEVBOX)).toBe('stale');
    expect(sessions().sessions.find(row => row.id === cached.id)?.hostId).toBe(DEVBOX);
  });

  it('falls back to the cached rows, marked stale, when a connected host fails its first listing', async () => {
    const cached = summary('failing-cached', '/srv/api');
    sessionListCache.write(DEVBOX, [cached]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stubTwoHosts('failing', { failing: ['session/page'] });
    const sessions = await render<SessionsController>(() => useSessions());
    await act(async () => undefined);
    expect(sessions().hostListings.get(DEVBOX)).toBe('stale');
    expect(sessions().sessions.find(row => row.id === cached.id)?.hostId).toBe(DEVBOX);
    expect(sessions().hasMore).toBe(false);
    warn.mockRestore();
  });

  it('opens and streams a remote session from its own host, never through the local one', async () => {
    const { remote, remoteRow } = stubTwoHosts('stream');
    const read = await render(() => {
      const sessions = useSessions();
      const listed = sessions.sessions.some(row => row.id === remoteRow.id);
      const conversation = useConversation(listed ? remoteRow.id : null, () => undefined);
      return { sessions, conversation };
    });
    await act(async () => undefined);
    const conversation = (): ConversationController => read().conversation;

    expect(conversation().session?.id).toBe(remoteRow.id);
    expect(remote.requests.map(request => request.method)).toEqual(
      expect.arrayContaining(['session/get', 'session/subscribe'])
    );
    const localGet = (window as unknown as { b4m: { chat: { getSession: ReturnType<typeof vi.fn> } } }).b4m.chat
      .getSession;
    expect(localGet).not.toHaveBeenCalledWith(remoteRow.id, expect.anything());
    expect(localGet).not.toHaveBeenCalledWith(remoteRow.id);

    const event = (seq: number, part: Partial<ChatStreamEvent>): ChatStreamEvent =>
      ({ sessionId: remoteRow.id, messageId: 'r', seq, ...part }) as ChatStreamEvent;
    await act(async () => {
      remote.emitStreamEvent(event(1, { type: 'delta', text: 'from the devbox' }));
      remote.emitStreamEvent(event(2, { type: 'phase', phase: { kind: 'responding' } }));
    });
    expect(JSON.stringify(conversation().messages)).toContain('from the devbox');
  });
});
