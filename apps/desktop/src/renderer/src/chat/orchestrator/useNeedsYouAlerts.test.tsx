// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AttentionNotice, AttentionOpenEvent } from '@shared/attention';
import type { ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNeedsYouAlerts } from './useNeedsYouAlerts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const chime = vi.hoisted(() => ({ playChime: vi.fn() }));
vi.mock('./chime', () => chime);

const session = (id: string, parentId?: string, title = `Session ${id}`): ChatSessionSummary =>
  ({
    id,
    title,
    mode: 'code',
    messageCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...(parentId && { origin: { parentSessionId: parentId, seedPrompt: `seed ${id}` } }),
  }) as ChatSessionSummary;

const DEFAULT_SESSIONS = [session('root', undefined, 'Audit'), session('child', 'root', 'Review the auth middleware')];

let sessions = DEFAULT_SESSIONS;
let container: HTMLDivElement;
let root: Root;
let openListener: ((event: AttentionOpenEvent) => void) | null;
const notify = vi.fn(async (_notice: AttentionNotice) => undefined);
const claim = vi.fn(async (sessionIds: string[]) => sessionIds);
const setBadgeCount = vi.fn(async (_count: number) => undefined);
const onOpen = vi.fn();
let focused = false;

const Probe = ({ statuses, loaded }: { statuses: ReadonlyMap<string, ChatSessionStatus>; loaded: boolean }) => {
  useNeedsYouAlerts(sessions, statuses, loaded, onOpen);
  return null;
};
const render = (entries: Record<string, ChatSessionStatus>, loaded = true) =>
  act(async () => root.render(<Probe statuses={new Map(Object.entries(entries))} loaded={loaded} />));

beforeEach(() => {
  focused = false;
  sessions = DEFAULT_SESSIONS;
  openListener = null;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  (window as unknown as { b4m: unknown }).b4m = {
    chat: {
      getSession: vi.fn(async () => ({
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            content: '',
            createdAt: '2026-10-01T00:00:00.000Z',
            toolCalls: [
              { id: 'c1', name: 'bash', input: { command: 'pnpm test' }, status: 'awaiting-approval', approvalId: 'a' },
            ],
          },
        ],
      })),
    },
    attention: {
      notify,
      claim,
      setBadgeCount,
      onOpen: (listener: (event: AttentionOpenEvent) => void) => {
        openListener = listener;
        return () => {
          openListener = null;
        };
      },
    },
  };
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('useNeedsYouAlerts', () => {
  it('notifies once when an agent starts needing the user while the window is in the background', async () => {
    await render({ child: 'processing' });
    await render({ child: 'needs-action' });
    expect(notify).toHaveBeenCalledTimes(1);
    const notice = notify.mock.calls[0][0];
    expect(notice).toMatchObject({ sessionId: 'child', rootId: 'root', body: 'bash pnpm test' });
    expect(notice.title).toMatch(/ needs you$/);
    expect(notice.title).not.toContain('Review the auth middleware');

    await render({ child: 'needs-action' });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for a plain session with no agents', async () => {
    sessions = [...DEFAULT_SESSIONS, { ...DEFAULT_SESSIONS[0], id: 'plain', title: 'Plain' }];
    await render({ plain: 'processing' });
    await render({ plain: 'needs-action' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not announce sessions that were already waiting when the window opened', async () => {
    await render({}, false);
    await render({ child: 'needs-action' }, true);
    expect(chime.playChime).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(setBadgeCount).toHaveBeenLastCalledWith(1);

    await render({ child: 'processing' });
    await render({ child: 'needs-action', root: 'needs-action' });
    expect(notify.mock.calls.map(([notice]) => notice.sessionId)).toEqual(['child', 'root']);
  });

  it('notifies again for a fresh entry after the last was answered', async () => {
    await render({});
    await render({ child: 'needs-action' });
    await render({ child: 'processing' });
    await render({ child: 'needs-action' });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('stays silent for entries another window has already claimed', async () => {
    claim.mockResolvedValueOnce([]);
    await render({});
    await render({ child: 'needs-action' });
    expect(claim).toHaveBeenCalledWith(['child']);
    expect(chime.playChime).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('names the session itself when the parent is the one waiting', async () => {
    await render({});
    await render({ root: 'needs-action' });
    expect(notify.mock.calls[0][0]).toMatchObject({ sessionId: 'root', rootId: 'root', title: 'Audit needs you' });
  });

  it('stays quiet while the window is focused, but still chimes', async () => {
    focused = true;
    await render({});
    await render({ child: 'needs-action' });
    expect(notify).not.toHaveBeenCalled();
    expect(chime.playChime).toHaveBeenCalledTimes(1);
  });

  it('keeps the dock badge at the number of sessions waiting', async () => {
    await render({ child: 'needs-action', root: 'needs-action' });
    expect(setBadgeCount).toHaveBeenLastCalledWith(2);
    await render({ child: 'processing', root: 'done' });
    expect(setBadgeCount).toHaveBeenLastCalledWith(0);
  });

  it('leaves archived and deleted sessions out of the dock badge', async () => {
    sessions = [
      session('root', undefined, 'Audit'),
      { ...session('child', 'root'), archived: true },
      session('live', 'root'),
    ];
    await render({ child: 'needs-action', root: 'needs-action', gone: 'needs-action' });
    expect(setBadgeCount).toHaveBeenLastCalledWith(1);
  });

  it('clears the dock badge when it unmounts, as on sign-out', async () => {
    await render({ child: 'needs-action' });
    expect(setBadgeCount).toHaveBeenLastCalledWith(1);
    act(() => root.unmount());
    expect(setBadgeCount).toHaveBeenLastCalledWith(0);
    root = createRoot(container);
  });

  it('hands a clicked notice to onOpen', async () => {
    await render({});
    act(() => openListener?.({ sessionId: 'child', rootId: 'root' }));
    expect(onOpen).toHaveBeenCalledWith({ sessionId: 'child', rootId: 'root' });
  });
});
