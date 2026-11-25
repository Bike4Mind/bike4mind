// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionStatusEvent, ChatSessionSummary } from '@shared/chat';
import { LOCAL_HOST_ID, type HostBridgeApi, type HostNotificationDelivery } from '@shared/hostBridge';
import { hostNotification } from '@shared/hostProtocol';
import { useSessionStatusFeed, useSessions, type SessionStatusFeed, type SessionsController } from './useChat';

const summary = (id: string, title = id) =>
  ({
    id,
    title,
    mode: 'chat',
    messageCount: 0,
    createdAt: '2026-10-01',
    updatedAt: '2026-10-01',
  }) as ChatSessionSummary;
const status = (sessionId: string, value: ChatSessionStatusEvent['status']): ChatSessionStatusEvent => ({
  sessionId,
  status: value,
});

// The session list and statuses come only from the host bridge: the chat stubs below have no
// listSessions, getSessionStatuses, onSessionSummary or onSessionStatus to fall back on.
function stubHost(results: Record<string, unknown>) {
  const listeners = new Set<(delivery: HostNotificationDelivery) => void>();
  const host: HostBridgeApi = {
    request: vi.fn(async (_hostId: string, method: string) =>
      method in results
        ? { ok: true as const, result: results[method] }
        : { ok: false as const, error: { code: -32601, message: `Not stubbed: ${method}` } }
    ),
    onNotification: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  vi.stubGlobal('b4m', {
    host,
    chat: { onStreamEvent: () => () => undefined },
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
  it('lists sessions with session/list on the local host', async () => {
    const { host } = stubHost({ 'session/list': { sessions: [summary('s1'), summary('s2')] } });

    const sessions = await render<SessionsController>(useSessions);

    expect(host.request).toHaveBeenCalledWith(LOCAL_HOST_ID, 'session/list', undefined);
    expect(sessions().sessions.map(entry => entry.id)).toEqual(['s1', 's2']);
    expect(sessions().loading).toBe(false);
  });

  it('patches a row from a local session/summaryChanged and ignores another host', async () => {
    const { push } = stubHost({ 'session/list': { sessions: [summary('s1'), summary('s2')] } });
    const sessions = await render<SessionsController>(useSessions);

    push('devbox', 'session/summaryChanged', { summary: summary('s1', 'From elsewhere') });
    push(LOCAL_HOST_ID, 'session/summaryChanged', { summary: summary('s2', 'Renamed') });

    expect(sessions().sessions.map(entry => entry.title)).toEqual(['s1', 'Renamed']);
  });

  it('patches the list in every window that holds it', async () => {
    const { push, listeners } = stubHost({ 'session/list': { sessions: [summary('s1')] } });
    const first = await render<SessionsController>(useSessions);
    const second = await render<SessionsController>(useSessions);

    push(LOCAL_HOST_ID, 'session/summaryChanged', { summary: summary('s1', 'Renamed') });

    expect(first().sessions[0].title).toBe('Renamed');
    expect(second().sessions[0].title).toBe('Renamed');
    expect(listeners.size).toBe(2);
  });

  it('drops its notification listener on unmount', async () => {
    const { listeners } = stubHost({ 'session/list': { sessions: [] } });
    await render<SessionsController>(useSessions);
    expect(listeners.size).toBe(1);

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
