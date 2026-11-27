// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionStatusEvent, ChatSessionSummary } from '@shared/chat';
import { LOCAL_HOST_ID, type HostBridgeApi, type HostNotificationDelivery } from '@shared/hostBridge';
import { HOST_ERROR_CODES, hostNotification } from '@shared/hostProtocol';
import { SESSION_PAGE_SIZE } from '@shared/sessionPage';
import { sessionEvents } from '../host/sessionEvents';
import {
  useConversation,
  useSessionStatusFeed,
  useSessions,
  type ConversationController,
  type SessionStatusFeed,
  type SessionsController,
} from './useChat';
import { localHostConnections } from '../__fixtures__/chatBackedHostBridge';

const summary = (id: string, title = id) =>
  ({
    id,
    title,
    mode: 'chat',
    messageCount: 0,
    createdAt: '2026-10-01',
    updatedAt: '2026-10-01',
  }) as ChatSessionSummary;
const page = (sessions: ChatSessionSummary[]) => ({ sessions, related: [], nextCursor: null, total: sessions.length });
const status = (sessionId: string, value: ChatSessionStatusEvent['status']): ChatSessionStatusEvent => ({
  sessionId,
  status: value,
});

// The session list and statuses come only from the host bridge: the chat stubs below have no
// listSessions, getSessionStatuses, onSessionSummary or onSessionStatus to fall back on.
function stubHost(results: Record<string, unknown>, chat: Record<string, unknown> = {}) {
  const listeners = new Set<(delivery: HostNotificationDelivery) => void>();
  const host: HostBridgeApi = {
    request: vi.fn(async (_hostId: string, method: string, params?: unknown) => {
      if (!(method in results)) {
        return { ok: false as const, error: { code: -32601, message: `Not stubbed: ${method}` } };
      }
      const answer = results[method];
      return { ok: true as const, result: typeof answer === 'function' ? answer(params) : answer };
    }),
    onNotification: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  vi.stubGlobal('b4m', {
    host: { ...localHostConnections(), ...host },
    chat: { onStreamEvent: () => () => undefined, ...chat },
    claudeImport: { onSessionsChanged: () => () => undefined },
  });
  const push = (hostId: string, method: string, params: unknown) =>
    act(() => listeners.forEach(listener => listener({ hostId, notification: hostNotification(method, params) })));
  return { host, push, listeners };
}

const roots: Array<{ root: Root; element: HTMLElement }> = [];

async function render<T>(useHook: () => T): Promise<() => T> {
  let latest: T | undefined;
  function Harness() {
    latest = useHook();
    return null;
  }
  const element = document.createElement('div');
  document.body.appendChild(element);
  const root = createRoot(element);
  roots.push({ root, element });
  await act(async () => root.render(<Harness />));
  return () => {
    if (latest === undefined) throw new Error('not rendered');
    return latest;
  };
}

beforeEach(() => vi.useRealTimers());

afterEach(() => {
  for (const { root, element } of roots.splice(0)) {
    act(() => root.unmount());
    element.remove();
  }
  vi.unstubAllGlobals();
});

describe('the session list through the local host', () => {
  it('lists the first page of sessions with session/page on the local host', async () => {
    const { host } = stubHost({ 'session/page': page([summary('s1'), summary('s2')]) });

    const sessions = await render<SessionsController>(useSessions);

    expect(host.request).toHaveBeenCalledWith(LOCAL_HOST_ID, 'session/page', {
      limit: SESSION_PAGE_SIZE,
      cursor: null,
      include: [],
    });
    expect(sessions().sessions.map(entry => entry.id)).toEqual(['s1', 's2']);
    expect(sessions().loading).toBe(false);
  });

  it('patches a row from a local session/summaryChanged and ignores another host', async () => {
    const { push } = stubHost({ 'session/page': page([summary('s1'), summary('s2')]) });
    const sessions = await render<SessionsController>(useSessions);

    push('devbox', 'session/summaryChanged', { summary: summary('s1', 'From elsewhere') });
    push(LOCAL_HOST_ID, 'session/summaryChanged', { summary: summary('s2', 'Renamed') });

    expect(sessions().sessions.map(entry => entry.title)).toEqual(['s1', 'Renamed']);
  });

  it('patches the list in every window that holds it', async () => {
    const { push, listeners } = stubHost({ 'session/page': page([summary('s1')]) });
    const first = await render<SessionsController>(useSessions);
    const second = await render<SessionsController>(useSessions);

    push(LOCAL_HOST_ID, 'session/summaryChanged', { summary: summary('s1', 'Renamed') });

    expect(first().sessions[0].title).toBe('Renamed');
    expect(second().sessions[0].title).toBe('Renamed');
    // Each window listens for summaries and for failed spawns.
    expect(listeners.size).toBe(4);
  });

  it('drops its notification listeners on unmount', async () => {
    const { listeners } = stubHost({ 'session/page': page([]) });
    await render<SessionsController>(useSessions);
    expect(listeners.size).toBe(2);

    for (const { root } of roots) act(() => root.unmount());
    roots.splice(0);

    expect(listeners.size).toBe(0);
  });
});

describe('session statuses through the local host', () => {
  it('folds the session/statuses snapshot in and marks the feed loaded', async () => {
    const { host } = stubHost({ 'session/statuses': { statuses: [status('s1', 'processing')] } });

    const feed = await render<SessionStatusFeed>(useSessionStatusFeed);

    expect(host.request).toHaveBeenCalledWith(LOCAL_HOST_ID, 'session/statuses', undefined);
    expect(feed().loaded).toBe(true);
    expect(feed().statuses.get('s1')).toBe('processing');
  });

  it('applies local session/statusChanged pushes, ignores other hosts, and keeps a push over a staler snapshot', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const { host, push } = stubHost({});
    vi.mocked(host.request).mockImplementation(
      () => new Promise(resolve => (answer = result => resolve({ ok: true, result })))
    );
    const feed = await render<SessionStatusFeed>(useSessionStatusFeed);

    push(LOCAL_HOST_ID, 'session/statusChanged', { event: status('s1', 'needs-action') });
    push('devbox', 'session/statusChanged', { event: status('s2', 'processing') });
    await act(async () => answer({ statuses: [status('s1', 'processing'), status('s3', 'needs-action')] }));

    expect(feed().statuses.get('s1')).toBe('needs-action');
    expect(feed().statuses.has('s2')).toBe(false);
    expect(feed().statuses.get('s3')).toBe('needs-action');
  });
});

describe('session actions through the local host', () => {
  const question = { parentTitle: 'Parent', finished: [{ id: 'c1', title: 'Done' }], kept: [] };
  const archived = (id: string) => ({ ...summary(id), archived: true }) as ChatSessionSummary;

  it('archives at once when the host asks for no confirmation', async () => {
    const confirmArchive = vi.fn();
    const { host } = stubHost(
      { 'session/page': page([summary('s1')]), 'session/setArchived': { summary: archived('s1') } },
      { confirmArchive }
    );
    const sessions = await render<SessionsController>(useSessions);

    await act(async () => sessions().toggleArchived(sessions().sessions[0]));

    expect(host.request).toHaveBeenCalledWith(LOCAL_HOST_ID, 'session/setArchived', {
      sessionId: 's1',
      archived: true,
    });
    expect(confirmArchive).not.toHaveBeenCalled();
    expect(sessions().sessions[0].archived).toBe(true);
  });

  it('asks the user first and repeats the request with their answer when sub-sessions are still going', async () => {
    const confirmArchive = vi.fn(async () => ({ confirmed: true as const, archiveChildIds: ['c1'] }));
    const { host } = stubHost(
      {
        'session/page': page([summary('s1')]),
        'session/setArchived': (params: { confirmed?: boolean }) =>
          params.confirmed ? { summary: archived('s1') } : { summary: null, confirmationRequired: question },
      },
      { confirmArchive }
    );
    const sessions = await render<SessionsController>(useSessions);

    await act(async () => sessions().toggleArchived(sessions().sessions[0]));

    expect(confirmArchive).toHaveBeenCalledExactlyOnceWith(question);
    expect(host.request).toHaveBeenLastCalledWith(LOCAL_HOST_ID, 'session/setArchived', {
      sessionId: 's1',
      archived: true,
      confirmed: true,
      archiveChildIds: ['c1'],
    });
    expect(sessions().sessions[0].archived).toBe(true);
  });

  it('changes nothing when the user cancels the archive confirmation', async () => {
    const confirmArchive = vi.fn(async () => null);
    const { host } = stubHost(
      {
        'session/page': page([summary('s1')]),
        'session/setArchived': { summary: null, confirmationRequired: question },
      },
      { confirmArchive }
    );
    const sessions = await render<SessionsController>(useSessions);

    await act(async () => sessions().toggleArchived(sessions().sessions[0]));

    const archiveRequests = vi.mocked(host.request).mock.calls.filter(([, method]) => method === 'session/setArchived');
    expect(archiveRequests).toHaveLength(1);
    expect(sessions().sessions[0].archived).toBeUndefined();
  });

  it('deletes from the sidebar with discard allowed, since the user saw the worktree dialog', async () => {
    const { host } = stubHost({ 'session/page': page([summary('s1')]), 'session/delete': {} });
    const sessions = await render<SessionsController>(useSessions);

    await act(async () => void (await sessions().remove('s1', true)));

    expect(host.request).toHaveBeenCalledWith(LOCAL_HOST_ID, 'session/delete', {
      sessionId: 's1',
      removeWorktree: true,
      allowDiscard: true,
    });
    expect(sessions().sessions).toEqual([]);
  });
});

describe('a held context notice across a reconnect', () => {
  const budgetWarning = { kind: 'run-budget', message: 'This run has used 80% of its budget.' } as const;

  function stubConversationHost(held: { notices: (typeof budgetWarning)[] }) {
    return stubHost({
      'session/get': () => ({
        session: { id: 's1', title: 's1', mode: 'chat', messages: [] },
        cursor: { epoch: 'e1', seq: 0 },
        ...(held.notices.length > 0 ? { notices: held.notices } : {}),
      }),
      'session/subscribe': { cursor: { epoch: 'e1', seq: 0 } },
      'session/unsubscribe': {},
      'queue/list': { queued: [] },
    });
  }

  const reconnect = () => act(async () => sessionEvents.resumeHost(LOCAL_HOST_ID));

  it('takes the banner from session/contextNotice, then re-seeds it from session/get after a reconnect', async () => {
    const held = { notices: [] as (typeof budgetWarning)[] };
    const { push } = stubConversationHost(held);
    const conversation = await render<ConversationController>(() => useConversation('s1', () => undefined));

    // The host holds the warning from the moment it sends it.
    held.notices = [budgetWarning];
    push(LOCAL_HOST_ID, 'session/contextNotice', {
      event: { type: 'context-notice', sessionId: 's1', ...budgetWarning },
    });
    expect(conversation().notice).toBe(budgetWarning.message);

    // Cleared while the window was cut off: no push reaches it, and the read after the reconnect drops it.
    await reconnect();
    expect(conversation().notice).toBe(budgetWarning.message);
    held.notices = [];
    await reconnect();
    expect(conversation().notice).toBeNull();

    // Set while cut off: the read after the reconnect shows it.
    held.notices = [budgetWarning];
    await reconnect();
    expect(conversation().notice).toBe(budgetWarning.message);
  });

  it('reads the session and its queue again when a resumed subscription needs a snapshot', async () => {
    const { host } = stubConversationHost({ notices: [] });
    const answer = vi.mocked(host.request).getMockImplementation();
    await render<ConversationController>(() => useConversation('s1', () => undefined));
    const reads = (method: string) =>
      vi.mocked(host.request).mock.calls.filter(([, called]) => called === method).length;
    const snapshot = () => ({ session: reads('session/get'), queue: reads('queue/list') });

    // A plain resume announces a resync of host-wide state; it is the baseline.
    const start = snapshot();
    await reconnect();
    const plain = snapshot();

    vi.mocked(host.request).mockImplementation(async (hostId, method, params) =>
      method === 'session/subscribe' && (params as { after?: unknown }).after
        ? { ok: false as const, error: { code: HOST_ERROR_CODES.snapshotRequired, message: 'gone' } }
        : answer!(hostId, method, params)
    );
    await reconnect();
    const resynced = snapshot();

    // The open session's own resync adds a read of it and of its queue on top of the baseline.
    expect(resynced.session - plain.session).toBeGreaterThan(plain.session - start.session);
    expect(resynced.queue - plain.queue).toBeGreaterThan(plain.queue - start.queue);
  });

  it('ignores a notice inside session/event, which a host still sends for 1.2 clients', async () => {
    const { push } = stubConversationHost({ notices: [] });
    const conversation = await render<ConversationController>(() => useConversation('s1', () => undefined));

    push(LOCAL_HOST_ID, 'session/event', {
      sessionId: 's1',
      seq: 1,
      epoch: 'e1',
      event: { type: 'context-notice', sessionId: 's1', ...budgetWarning },
    });

    expect(conversation().notice).toBeNull();
  });
});

describe('settled turns through the local host', () => {
  it('counts a turn when a session status shows its settled counter rising, once per rise', async () => {
    const { push } = stubHost({
      'session/statuses': { statuses: [{ sessionId: 's1', status: 'done', settledTurns: 2 }] },
    });
    const conversation = await render<ConversationController>(() => useConversation(null, () => undefined));
    expect(conversation().settledTurns).toBe(0);

    push(LOCAL_HOST_ID, 'session/statusChanged', { event: { sessionId: 's1', status: 'processing', settledTurns: 2 } });
    expect(conversation().settledTurns).toBe(0);
    push(LOCAL_HOST_ID, 'session/statusChanged', { event: { sessionId: 's1', status: 'done', settledTurns: 3 } });
    push(LOCAL_HOST_ID, 'session/statusChanged', { event: { sessionId: 's1', status: 'done', settledTurns: 3 } });
    expect(conversation().settledTurns).toBe(1);
  });

  it('counts a reconnect as a turn that may have settled unheard', async () => {
    stubHost({ 'session/statuses': { statuses: [] } });
    const conversation = await render<ConversationController>(() => useConversation(null, () => undefined));

    await act(async () => sessionEvents.resumeHost(LOCAL_HOST_ID));

    expect(conversation().settledTurns).toBe(1);
  });
});
