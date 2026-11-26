// @vitest-environment jsdom
import { chatBackedHostBridge } from '../../__fixtures__/chatBackedHostBridge';
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AttentionNotice, AttentionOpenEvent, NotifyScope } from '@shared/attention';
import type { ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writePresenter } from './orchestratorPrefs';
import { PRESENTER_NOTICE_BODY, PRESENTER_NOTICE_TITLE, useNeedsYouAlerts } from './useNeedsYouAlerts';

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
const takePendingOpen = vi.fn(async (): Promise<AttentionOpenEvent | null> => null);
let focused = false;
let scope: NotifyScope = 'agents';
let viewingId: string | null = null;

let unread: ReadonlySet<string> = new Set();
const Probe = ({ statuses, loaded }: { statuses: ReadonlyMap<string, ChatSessionStatus>; loaded: boolean }) => {
  useNeedsYouAlerts(sessions, statuses, loaded, onOpen, viewingId, unread);
  return null;
};
const render = (entries: Record<string, ChatSessionStatus>, loaded = true) =>
  act(async () => root.render(<Probe statuses={new Map(Object.entries(entries))} loaded={loaded} />));

beforeEach(() => {
  focused = false;
  scope = 'agents';
  viewingId = null;
  unread = new Set();
  sessions = DEFAULT_SESSIONS;
  openListener = null;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  (window as unknown as { b4m: unknown }).b4m = {
    host: chatBackedHostBridge(),
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
      takePendingOpen,
      getNotifyScope: vi.fn(async () => scope),
      onNotifyScope: () => () => undefined,
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
  window.localStorage.clear();
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

  it('does not announce an unread finished reply, but announces a request that lands on it', async () => {
    await render({ child: 'processing' });
    unread = new Set(['child']);
    await render({ child: 'needs-action' });
    expect(notify).not.toHaveBeenCalled();
    expect(chime.playChime).not.toHaveBeenCalled();
    unread = new Set();
    await render({ child: 'needs-action' });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for a plain session with no agents', async () => {
    sessions = [...DEFAULT_SESSIONS, { ...DEFAULT_SESSIONS[0], id: 'plain', title: 'Plain' }];
    await render({ plain: 'processing' });
    await render({ plain: 'needs-action' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('still counts a waiting plain session on the dock badge under the agents scope', async () => {
    sessions = [...DEFAULT_SESSIONS, { ...DEFAULT_SESSIONS[0], id: 'plain', title: 'Plain' }];
    await render({ plain: 'processing' });
    await render({ plain: 'needs-action' });
    expect(chime.playChime).not.toHaveBeenCalled();
    expect(setBadgeCount).toHaveBeenLastCalledWith(1);
    await render({ plain: 'done' });
    expect(setBadgeCount).toHaveBeenLastCalledWith(0);
  });

  describe('with the all scope', () => {
    const PLAIN = { ...DEFAULT_SESSIONS[0], id: 'plain', title: 'Plain' };

    beforeEach(() => {
      scope = 'all';
      sessions = [...DEFAULT_SESSIONS, PLAIN];
    });

    it('notifies, chimes and badges for a plain session that starts needing the user', async () => {
      await render({ plain: 'processing' });
      await render({ plain: 'needs-action' });
      expect(chime.playChime).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith({
        sessionId: 'plain',
        rootId: 'plain',
        title: 'Plain needs you',
        body: 'bash pnpm test',
      });
      expect(setBadgeCount).toHaveBeenLastCalledWith(1);
    });

    it('stays quiet for an archived plain session', async () => {
      sessions = [...DEFAULT_SESSIONS, { ...PLAIN, archived: true }];
      await render({ plain: 'processing' });
      await render({ plain: 'needs-action' });
      expect(chime.playChime).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      expect(setBadgeCount).toHaveBeenLastCalledWith(0);
    });

    it('does not announce the plain session the user is viewing in a focused window', async () => {
      viewingId = 'plain';
      focused = true;
      await render({ plain: 'processing' });
      await render({ plain: 'needs-action' });
      expect(chime.playChime).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      expect(setBadgeCount).toHaveBeenLastCalledWith(1);
    });

    it('claims the viewed plain session, so another window cannot announce it', async () => {
      viewingId = 'plain';
      focused = true;
      await render({ plain: 'processing' });
      await render({ plain: 'needs-action' });
      expect(claim).toHaveBeenCalledWith(['plain']);
      expect(chime.playChime).not.toHaveBeenCalled();
    });

    it('stays silent in a second window when the viewing window claimed the entry first', async () => {
      claim.mockResolvedValueOnce([]);
      await render({ plain: 'processing' });
      await render({ plain: 'needs-action' });
      expect(chime.playChime).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });

    it('still announces an agent the user is viewing in a focused window', async () => {
      viewingId = 'child';
      focused = true;
      await render({ child: 'processing' });
      await render({ child: 'needs-action' });
      expect(chime.playChime).toHaveBeenCalledTimes(1);
    });

    it('announces the viewed plain session once the window is in the background', async () => {
      viewingId = 'plain';
      await render({ plain: 'processing' });
      await render({ plain: 'needs-action' });
      expect(notify).toHaveBeenCalledTimes(1);
    });
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

  it('still announces when the claim itself fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    claim.mockRejectedValueOnce(new Error('ipc down'));
    await render({});
    await render({ child: 'needs-action' });
    expect(chime.playChime).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ sessionId: 'child' });
  });

  it('sends the notice with the fallback body when the session cannot be read', async () => {
    const chat = (window as unknown as { b4m: { chat: { getSession: ReturnType<typeof vi.fn> } } }).b4m.chat;
    chat.getSession.mockRejectedValueOnce(new Error('gone'));
    await render({});
    await render({ child: 'needs-action' });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ sessionId: 'child', body: 'Waiting for your answer' });
  });

  it('names the session itself when the parent is the one waiting', async () => {
    await render({});
    await render({ root: 'needs-action' });
    expect(notify.mock.calls[0][0]).toMatchObject({ sessionId: 'root', rootId: 'root', title: 'Audit needs you' });
  });

  describe('Presenter mode', () => {
    it('on: still alerts, with only the generic title and no session title or request', async () => {
      writePresenter(true);
      await render({});
      await render({ child: 'needs-action', root: 'needs-action' });
      expect(chime.playChime).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls.map(([notice]) => notice)).toEqual([
        { sessionId: 'child', rootId: 'root', title: PRESENTER_NOTICE_TITLE, body: PRESENTER_NOTICE_BODY },
        { sessionId: 'root', rootId: 'root', title: PRESENTER_NOTICE_TITLE, body: PRESENTER_NOTICE_BODY },
      ]);
      const shown = JSON.stringify(notify.mock.calls);
      for (const real of ['Audit', 'Review the auth middleware', 'pnpm test']) expect(shown).not.toContain(real);
    });

    it('off: names the session and spells out the request', async () => {
      writePresenter(false);
      await render({});
      await render({ root: 'needs-action' });
      expect(notify.mock.calls[0][0]).toEqual({
        sessionId: 'root',
        rootId: 'root',
        title: 'Audit needs you',
        body: 'bash pnpm test',
      });
    });
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

  it('opens the notice that reopened the window, once its session is listed', async () => {
    takePendingOpen.mockResolvedValueOnce({ sessionId: 'child', rootId: 'root' });
    sessions = [];
    await render({}, false);
    expect(onOpen).not.toHaveBeenCalled();

    sessions = DEFAULT_SESSIONS;
    await render({});
    await render({});
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith({ sessionId: 'child', rootId: 'root' });
  });

  it('opens nothing when no notice reopened the window', async () => {
    await render({});
    expect(takePendingOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('keeps the reopening notice when the take runs twice, as StrictMode does', async () => {
    takePendingOpen.mockResolvedValueOnce({ sessionId: 'child', rootId: 'root' }).mockResolvedValueOnce(null);
    await act(async () =>
      root.render(
        <StrictMode>
          <Probe statuses={new Map()} loaded />
        </StrictMode>
      )
    );
    await act(async () => undefined);
    expect(takePendingOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledWith({ sessionId: 'child', rootId: 'root' });
  });
});
