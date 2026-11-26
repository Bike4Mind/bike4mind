// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionSummary } from '@shared/chat';
import type { HostBridgeApi } from '@shared/hostBridge';
import {
  compareSessionsForPage,
  pageSessions,
  SESSION_PAGE_SIZE,
  sessionPageRequestSchema,
  type SessionPageRequest,
} from '@shared/sessionPage';
import { useSessions, type SessionsController } from './useChat';

const summary = (index: number): ChatSessionSummary =>
  ({
    id: `s${index}`,
    title: index % 50 === 0 ? `Deploy notes ${index}` : `Session ${index}`,
    mode: 'chat',
    messageCount: 0,
    createdAt: new Date(Date.UTC(2026, 0, 1) - index * 60_000).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, 1) - index * 60_000).toISOString(),
  }) as ChatSessionSummary;

/** A host that pages `count` sessions for real; `hold` makes the next page wait for `release`. */
function pagingHost(count: number) {
  let all = Array.from({ length: count }, (_, index) => summary(index)).sort(compareSessionsForPage);
  const requests: SessionPageRequest[] = [];
  const held: Array<() => void> = [];
  let holdNext = 0;
  const host: HostBridgeApi = {
    request: vi.fn(async (_hostId: string, method: string, params?: unknown) => {
      if (method === 'session/delete') return { ok: true as const, result: {} };
      if (method !== 'session/page') return { ok: false as const, error: { code: -32601, message: method } };
      const request = sessionPageRequestSchema.parse(params);
      requests.push(request);
      if (holdNext > 0) {
        holdNext--;
        await new Promise<void>(resolve => held.push(resolve));
      }
      return { ok: true as const, result: pageSessions(all, request) };
    }),
    onNotification: () => () => undefined,
  };
  vi.stubGlobal('b4m', {
    host,
    chat: { onStreamEvent: () => () => undefined },
    claudeImport: { onSessionsChanged: () => () => undefined },
  });
  return {
    requests,
    hold: () => holdNext++,
    release: async (index = 0) => {
      await act(async () => held[index]?.());
    },
    releaseAll: async () => {
      await act(async () => held.forEach(release => release()));
    },
    add: (index: number) => (all = [summary(index), ...all].sort(compareSessionsForPage)),
    remove: (id: string) => (all = all.filter(session => session.id !== id)),
  };
}

const roots: Root[] = [];

async function mount(keepIds: readonly string[] = []) {
  let latest: SessionsController | undefined;
  let keep = keepIds;
  function Harness() {
    latest = useSessions(keep);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  await act(async () => root.render(<Harness />));
  const current = () => {
    if (!latest) throw new Error('not rendered');
    return latest;
  };
  const setKeep = async (next: readonly string[]) => {
    keep = next;
    await act(async () => root.render(<Harness />));
  };
  return { current, setKeep };
}

const ids = (controller: SessionsController) => controller.sessions.map(session => session.id);

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('useSessions paging', () => {
  it('loads only the first page, newest first, and reports more to come', async () => {
    const host = pagingHost(250);
    const { current } = await mount();
    expect(current().sessions).toHaveLength(SESSION_PAGE_SIZE);
    expect(ids(current())[0]).toBe('s0');
    expect(current().hasMore).toBe(true);
    expect(current().total).toBe(250);
    expect(host.requests).toEqual([{ limit: SESSION_PAGE_SIZE, cursor: null, include: [] }]);
  });

  it('appends the next page and ignores a second request while one is in flight', async () => {
    const host = pagingHost(250);
    const { current } = await mount();
    host.hold();
    act(() => current().loadMore());
    act(() => current().loadMore());
    expect(current().loadingMore).toBe(true);
    expect(host.requests).toHaveLength(2);
    await host.release();
    expect(current().loadingMore).toBe(false);
    expect(current().sessions).toHaveLength(200);
    expect(ids(current()).slice(99, 101)).toEqual(['s99', 's100']);
  });

  it('stops asking once the last page is in', async () => {
    const host = pagingHost(250);
    const { current } = await mount();
    await act(async () => current().loadMore());
    await act(async () => current().loadMore());
    expect(current().sessions).toHaveLength(250);
    expect(current().hasMore).toBe(false);
    await act(async () => current().loadMore());
    expect(host.requests).toHaveLength(3);
  });

  it('re-reads every loaded page in one request on reload', async () => {
    const host = pagingHost(250);
    const { current } = await mount();
    await act(async () => current().loadMore());
    await act(async () => current().reload());
    expect(host.requests.at(-1)).toEqual({ limit: 200, cursor: null, include: [] });
    expect(current().sessions).toHaveLength(200);
    expect(current().hasMore).toBe(true);
  });

  it('drops a page that a reload overtook, rather than append rows cut from an older listing', async () => {
    const host = pagingHost(250);
    const { current } = await mount();
    host.hold();
    act(() => current().loadMore());
    await act(async () => current().reload());
    await host.release();
    expect(current().sessions).toHaveLength(SESSION_PAGE_SIZE);
    expect(current().loadingMore).toBe(false);
  });

  it('keeps every row when a reload lands first and shifts the list under a page already requested', async () => {
    const host = pagingHost(250);
    const { current } = await mount();
    host.hold();
    host.hold();
    act(() => void current().reload());
    act(() => current().loadMore());
    host.add(-1);
    await host.release(0);
    await host.release(1);
    // The stale page is dropped; the next one starts from the reload's cursor, so s99 is not lost.
    expect(current().loadingMore).toBe(false);
    expect(current().sessions).toHaveLength(SESSION_PAGE_SIZE);
    await act(async () => current().loadMore());
    expect(current().sessions).toHaveLength(2 * SESSION_PAGE_SIZE);
    expect(ids(current())).toContain('s99');
  });

  it('keeps every row when the reload and the page reply land before the next render', async () => {
    const host = pagingHost(250);
    const { current } = await mount();
    host.hold();
    host.hold();
    act(() => void current().reload());
    act(() => current().loadMore());
    host.add(-1);
    await host.releaseAll();
    expect(current().sessions).toHaveLength(SESSION_PAGE_SIZE);
    await act(async () => current().loadMore());
    expect(current().sessions).toHaveLength(2 * SESSION_PAGE_SIZE);
    expect(ids(current())).toContain('s99');
  });

  it('fetches a kept session that no loaded page holds, once', async () => {
    const host = pagingHost(250);
    const { current, setKeep } = await mount(['s240']);
    // Sent on the first page's request, so a restore finds it the moment loading ends.
    expect(host.requests[0].include).toEqual(['s240']);
    expect(ids(current())).toContain('s240');
    await setKeep(['s230']);
    expect(host.requests.at(-1)).toEqual({ limit: 0, cursor: null, include: ['s230'] });
    expect(ids(current())).toContain('s230');
    const asked = host.requests.length;
    await setKeep(['s230', 'gone']);
    await setKeep(['s230', 'gone']);
    expect(host.requests.length).toBe(asked + 1);
  });

  it('does not fetch back a kept session that was deleted', async () => {
    const host = pagingHost(5);
    const { current } = await mount(['s1']);
    host.remove('s1');
    const asked = host.requests.length;
    await act(async () => {
      await current().remove('s1');
    });
    expect(ids(current())).not.toContain('s1');
    expect(host.requests.length).toBe(asked);
  });

  it('searches titles across pages that are not loaded', async () => {
    pagingHost(250);
    const { current } = await mount();
    const found = await current().searchSessions('deploy');
    expect(found.sessions.map(session => session.id)).toEqual(['s0', 's50', 's100', 's150', 's200']);
    expect(found.total).toBe(5);
  });
});
