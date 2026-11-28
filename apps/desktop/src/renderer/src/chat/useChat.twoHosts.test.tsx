// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession, ChatSessionSummary, ChatStreamEvent } from '@shared/chat';
import { LOCAL_HOST_ID } from '@shared/hostBridge';
import type { HostConnectionState } from '@shared/hostConnection';
import { chatBackedHostBridge, type FakeRemoteHostOptions } from '../__fixtures__/chatBackedHostBridge';
import { sessionDirectory, summaryHostId } from '../host/sessionDirectory';
import { sessionListCache } from '../host/sessionListCache';
import { sessionHostMemory } from '../host/sessionHostMemory';
import { useSessionCapabilities } from '../host/sessionCapabilities';
import { SESSION_PAGE_SIZE } from '@shared/sessionPage';
import { useTaskDecisions } from './TaskDecisionCards';
import { useSettledTurns } from './useSettledTurns';
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

const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 9, 10);
/** `count` rows on `directory`, newest first, `stepMs` apart from T0 back. */
const rowsEvery = (prefix: string, directory: string, count: number, stepMs: number): ChatSessionSummary[] =>
  Array.from({ length: count }, (_, index) =>
    summary(`${prefix}-${index}`, directory, new Date(T0 - index * stepMs).toISOString())
  );

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
function stubTwoHosts(
  prefix: string,
  remote: Partial<FakeRemoteHostOptions> = {},
  chat: Record<string, unknown> = {},
  localRows?: ChatSessionSummary[]
) {
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
      listSessions: async () => localRows ?? [localRow],
      getSession: vi.fn(async () => null),
      getQueuedMessages: async () => [],
      onStreamEvent: () => () => undefined,
      ...chat,
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

  it('asks a remembered remote session of its own host, past that host first page', async () => {
    const deep = rowsEvery('remembered', '/srv/api', SESSION_PAGE_SIZE + 1, HOUR_MS);
    const target = deep[SESSION_PAGE_SIZE];
    sessionHostMemory.remember(target.id, DEVBOX);
    const { remote } = stubTwoHosts('remembered', { sessions: deep });
    const sessions = await render<SessionsController>(() => useSessions([target.id]));

    expect(sessions().sessions.find(row => row.id === target.id)?.hostId).toBe(DEVBOX);
    const firstListing = remote.requests.find(request => request.method === 'session/page');
    expect(firstListing?.params.include).toEqual([target.id]);
  });

  it('asks a host that connects later for a kept session no host has listed', async () => {
    const deep = rowsEvery('late', '/srv/api', SESSION_PAGE_SIZE + 1, HOUR_MS);
    const target = deep[SESSION_PAGE_SIZE];
    const { remote } = stubTwoHosts('late', { sessions: deep, connected: false });
    const sessions = await render<SessionsController>(() => useSessions([target.id]));
    expect(sessions().sessions.some(row => row.id === target.id)).toBe(false);

    await act(async () => remote.setConnected(true));
    await act(async () => undefined);
    expect(sessions().sessions.find(row => row.id === target.id)?.hostId).toBe(DEVBOX);
  });

  it('marks a host still connecting at launch as pending, not stale, until it lists or fails', async () => {
    const { remote, remoteRow } = stubTwoHosts('pending', { connected: 'connecting' });
    const sessions = await render<SessionsController>(() => useSessions());
    expect(sessions().hostListings.get(DEVBOX)).toBe('pending');

    await act(async () => remote.setConnected(true));
    await act(async () => undefined);
    expect(sessions().hostListings.get(DEVBOX)).toBe('live');
    expect(sessions().sessions.some(row => row.id === remoteRow.id)).toBe(true);

    await act(async () => remote.setConnected(false));
    await act(async () => remote.setConnected('connecting'));
    expect(sessions().hostListings.get(DEVBOX)).toBe('stale');
  });

  it('marks a host that fails to connect at launch as stale', async () => {
    const { remote } = stubTwoHosts('nolink', { connected: 'connecting' });
    const sessions = await render<SessionsController>(() => useSessions());
    await act(async () => remote.setConnected(false));
    expect(sessions().hostListings.get(DEVBOX)).toBe('stale');
  });

  it.each<[string, HostConnectionState]>([
    ['failed', { status: 'failed', failure: { kind: 'sshFailed', detail: 'no route', stderrTail: '' } }],
    ['needsInstall', { status: 'needsInstall' }],
    ['needsSignIn', { status: 'needsSignIn' }],
    ['needsUpdate', { status: 'needsUpdate', required: true }],
  ])('leaves pending once a connecting host lands in %s, so no skeleton stays', async (_name, landed) => {
    const { remote } = stubTwoHosts(`landed-${_name}`, { connected: 'connecting' });
    const sessions = await render<SessionsController>(() => useSessions());
    expect(sessions().hostListings.get(DEVBOX)).toBe('pending');
    await act(async () => remote.setState(landed));
    expect(sessions().hostListings.get(DEVBOX)).toBe('stale');
  });

  it('pages two hosts of different density without a hole in the merged list', async () => {
    // A busy local host: a session a minute. A quiet remote one: a session an hour.
    const local = rowsEvery('dense', '/work/repo', SESSION_PAGE_SIZE + 50, 60_000);
    const quiet = rowsEvery('sparse', '/srv/api', SESSION_PAGE_SIZE + 50, HOUR_MS);
    const { remote } = stubTwoHosts('density', { sessions: quiet }, {}, local);
    const sessions = await render<SessionsController>(() => useSessions());
    const everything = [...local, ...quiet];
    const gapFree = () => {
      const shown = sessions().sessions;
      const oldest = shown.at(-1)?.updatedAt ?? '';
      const expected = everything.filter(row => row.updatedAt >= oldest).map(row => row.id);
      expect(new Set(shown.map(row => row.id))).toEqual(new Set(expected));
    };

    gapFree();
    expect(sessions().sessions.filter(row => row.hostId === DEVBOX)).toHaveLength(2);

    const remotePages = () => remote.requests.filter(request => request.method === 'session/page').length;
    const before = remotePages();
    await act(async () => sessions().loadMore());
    await act(async () => undefined);
    gapFree();
    expect(remotePages()).toBe(before);
    expect(sessions().sessions.filter(row => !row.hostId)).toHaveLength(local.length);

    await act(async () => sessions().loadMore());
    await act(async () => undefined);
    gapFree();
    expect(sessions().sessions).toHaveLength(everything.length);
  });

  it('moves the capability gate once the directory learns a session is remote', async () => {
    stubTwoHosts('gate');
    const capabilities = await render(() => useSessionCapabilities('gate-learned-later'));
    expect(capabilities().desktopChat).toBe(true);

    await act(async () => {
      sessionDirectory.record(DEVBOX, ['gate-learned-later']);
    });
    expect(capabilities().desktopChat).toBe(false);
  });

  it('reads statuses and task decisions only from a host that joins, not again from the others', async () => {
    const getSessionStatuses = vi.fn(async () => []);
    const listTaskDecisions = vi.fn(async () => []);
    const { remote } = stubTwoHosts(
      'feeds',
      { connected: false },
      { getSessionStatuses, listTaskDecisions, onTaskDecisions: () => () => undefined }
    );
    await render(() => [useSettledTurns(), useTaskDecisions()]);
    expect(getSessionStatuses).toHaveBeenCalledTimes(1);
    expect(listTaskDecisions).toHaveBeenCalledTimes(1);

    await act(async () => remote.setConnected(true));
    await act(async () => remote.setConnected(false));
    await act(async () => remote.setConnected(true));
    await act(async () => undefined);
    expect(getSessionStatuses).toHaveBeenCalledTimes(1);
    expect(listTaskDecisions).toHaveBeenCalledTimes(1);
    const remoteReads = remote.requests.filter(
      request => request.method === 'session/statuses' || request.method === 'taskDecision/list'
    );
    expect(remoteReads.map(request => request.method).sort()).toEqual([
      'session/statuses',
      'session/statuses',
      'taskDecision/list',
      'taskDecision/list',
    ]);
  });
});
