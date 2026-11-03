// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSession, ChatSessionSummary, ChatStreamEvent } from '@shared/chat';
import { REQUEST_DIRECTORY_TOOL_NAME, type ShareDirectoryResult } from '@shared/directoryRequest';
import { EMPTY_SIDEBAR_SECTIONS } from '@shared/sidebarSections';
import { NO_SKILLS } from '@shared/skills';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ChatShell } from './ChatShell';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./CustomizePanel', () => ({ CustomizeNavItem: () => null, CustomizeScreen: () => null }));

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const NOTES = '/work/notes';
const LAST_SESSION_KEY = 'b4m.chat.lastSession';

const summary = (
  id: string,
  mode: 'chat' | 'code' = 'chat',
  grantedDirectories?: string[],
  title = 'New conversation'
): ChatSessionSummary =>
  ({
    id,
    title,
    mode,
    model: 'claude-opus-4-5-20251101',
    messageCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...(grantedDirectories ? { grantedDirectories } : {}),
  }) as ChatSessionSummary;

function quietBridge(overrides: Record<string, unknown>) {
  return new Proxy(overrides, {
    get(target, name: string | symbol) {
      if (typeof name !== 'string') return undefined;
      if (name in target) return target[name];
      if (name.startsWith('on')) return () => () => undefined;
      return async () => [];
    },
  });
}

const createSession = vi.fn<() => Promise<{ session: ChatSessionSummary }>>();
const pickProjectDirectory = vi.fn<() => Promise<string | null>>();
const addContextDirectory = vi.fn<(sessionId: string, path?: string) => Promise<ShareDirectoryResult>>();
const removeContextDirectory = vi.fn<(sessionId: string, directory: string) => Promise<ChatSessionSummary | null>>();
const deleteSession = vi.fn<(sessionId: string, removeWorktree: boolean) => Promise<void>>();

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

/** The first-run seed fails, which leaves the window with no conversation at all. */
const seedFails = () => createSession.mockRejectedValueOnce(new Error('seed failed'));

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** Session reads for these ids wait on the promise, so a test can order the load against a share. */
const heldLoads = new Map<string, Promise<void>>();

const streamListeners = new Set<(event: ChatStreamEvent) => void>();
const emit = (event: ChatStreamEvent) => streamListeners.forEach(listener => listener(event));

function stubBridge(sessions: ChatSessionSummary[], chatOverrides: Record<string, unknown> = {}) {
  const stored = new Map(sessions.map(session => [session.id, session]));
  createSession.mockImplementation(async () => {
    const session = summary('fresh');
    stored.set(session.id, session);
    return { session };
  });
  deleteSession.mockImplementation(async id => void stored.delete(id));
  (window as unknown as { b4m: unknown }).b4m = new Proxy(
    {
      chat: quietBridge({
        listSessions: async () => sessions,
        getSession: async (id: string) => {
          const session = stored.get(id);
          await heldLoads.get(id);
          return session ? ({ ...session, messages: [] } as unknown as ChatSession) : null;
        },
        getQueuedMessages: async () => [],
        getSessionStatuses: async () => [],
        listModels: async () => ({ models: [] }),
        listSkills: async () => NO_SKILLS,
        listArtifacts: async () => ({ artifacts: [], total: 0 }),
        createSession,
        deleteSession,
        pickProjectDirectory,
        // Main stores a grant before it answers, so a load that lands afterwards reads it back.
        addContextDirectory: async (id: string, path?: string) => {
          const result = await addContextDirectory(id, path);
          if (result.status === 'added') stored.set(result.session.id, result.session);
          return result;
        },
        removeContextDirectory: async (id: string, directory: string) => {
          const updated = await removeContextDirectory(id, directory);
          if (updated) stored.set(updated.id, updated);
          return updated;
        },
        onStreamEvent: (listener: (event: ChatStreamEvent) => void) => {
          streamListeners.add(listener);
          return () => streamListeners.delete(listener);
        },
        ...chatOverrides,
      }),
      sidebar: quietBridge({ getSections: async () => EMPTY_SIDEBAR_SECTIONS }),
      getAppInfo: async () => ({ homeDirectory: '/home/test' }),
    },
    {
      get(target, name: string | symbol) {
        if (typeof name !== 'string') return undefined;
        return name in target ? target[name as keyof typeof target] : quietBridge({});
      },
    }
  );
  return stored;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  Element.prototype.scrollIntoView = () => undefined;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
  );
  for (const mock of [createSession, pickProjectDirectory, addContextDirectory, removeContextDirectory, deleteSession])
    mock.mockReset();
  heldLoads.clear();
  streamListeners.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderShell(strict = false): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const shell = (
    <CssVarsProvider theme={desktopTheme}>
      <ChatShell />
    </CssVarsProvider>
  );
  await act(async () => {
    root?.render(strict ? <StrictMode>{shell}</StrictMode> : shell);
  });
  await act(async () => undefined);
}

const byTestId = <T extends HTMLElement = HTMLElement>(testid: string) =>
  document.querySelector<T>(`[data-testid="${testid}"]`);
const chips = () => [...document.querySelectorAll<HTMLElement>('[data-testid="session-chip-context"]')];

const sidebarRow = (title: string) =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="chat-session-item"]')].find(row =>
    row.textContent?.includes(title)
  );

async function openSessionRow(title: string): Promise<void> {
  await act(async () => sidebarRow(title)?.click());
  await act(async () => undefined);
}

async function deleteOpenChat(): Promise<void> {
  await act(async () => byTestId('chat-session-menu-btn')?.click());
  await act(async () => byTestId('chat-delete-session-btn')?.click());
  await act(async () => byTestId('delete-session-confirm-btn')?.click());
  await act(async () => undefined);
}

async function typeCommand(text: string): Promise<void> {
  const input = byTestId<HTMLTextAreaElement>('chat-composer-input');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, text);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await act(async () => undefined);
}

async function addFolderFromMenu(): Promise<void> {
  await act(async () => byTestId('composer-plus-btn')?.click());
  await act(async () => byTestId('composer-add-folder-item')?.click());
  await act(async () => undefined);
}

describe('Add folder in a Chat composer', () => {
  it('shares a folder with a new chat before its first message, shows it, and takes it back', async () => {
    stubBridge([summary('blank-1')]);
    await renderShell();
    await act(async () => byTestId('chat-session-item')?.click());
    await act(async () => undefined);
    expect(chips()).toHaveLength(0);

    addContextDirectory.mockResolvedValue({
      status: 'added',
      path: NOTES,
      session: summary('blank-1', 'chat', [NOTES]),
    });
    await addFolderFromMenu();

    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('blank-1', undefined);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);

    removeContextDirectory.mockResolvedValue(summary('blank-1'));
    await act(async () => chips()[0].querySelector('button')?.click());
    expect(removeContextDirectory).toHaveBeenCalledExactlyOnceWith('blank-1', NOTES);
    expect(chips()).toHaveLength(0);
  });

  it('shows main refusing the folder where the user is looking', async () => {
    stubBridge([summary('blank-1')]);
    await renderShell();
    await act(async () => byTestId('chat-session-item')?.click());
    await act(async () => undefined);

    addContextDirectory.mockResolvedValue({
      status: 'refused',
      error: 'The filesystem root cannot be shared. Share the specific folder that is needed.',
    });
    await addFolderFromMenu();

    expect(byTestId('chat-send-error')?.textContent).toContain('filesystem root cannot be shared');
    expect(chips()).toHaveLength(0);
  });

  it('with no conversation yet, picks first and only then starts a chat that gets the folder', async () => {
    stubBridge([]);
    seedFails();
    await renderShell();
    expect(byTestId<HTMLTextAreaElement>('chat-composer-input')?.disabled).toBe(true);
    expect(createSession).toHaveBeenCalledTimes(1);

    pickProjectDirectory.mockResolvedValueOnce(null);
    await addFolderFromMenu();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(addContextDirectory).not.toHaveBeenCalled();

    pickProjectDirectory.mockResolvedValueOnce(NOTES);
    addContextDirectory.mockResolvedValue({ status: 'added', path: NOTES, session: summary('fresh', 'chat', [NOTES]) });
    await addFolderFromMenu();
    await act(async () => undefined);

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('fresh', NOTES);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);
    expect(byTestId<HTMLTextAreaElement>('chat-composer-input')?.disabled).toBe(false);
  });

  it('does not paint a share that returns after the user moved to another chat', async () => {
    stubBridge([summary('alpha', 'chat', undefined, 'Alpha'), summary('beta', 'chat', undefined, 'Beta')]);
    await renderShell();
    await openSessionRow('Alpha');

    const share = deferred<ShareDirectoryResult>();
    addContextDirectory.mockReturnValue(share.promise);
    await addFolderFromMenu();
    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('alpha', undefined);

    await openSessionRow('Beta');
    await act(async () =>
      share.resolve({ status: 'added', path: NOTES, session: summary('alpha', 'chat', [NOTES], 'Alpha') })
    );
    expect(chips()).toHaveLength(0);
  });

  it('shows a refusal that returns after the user moved to another chat only once its own chat is back', async () => {
    stubBridge([summary('alpha', 'chat', undefined, 'Alpha'), summary('beta', 'chat', undefined, 'Beta')]);
    await renderShell();
    await openSessionRow('Alpha');

    const share = deferred<ShareDirectoryResult>();
    addContextDirectory.mockReturnValue(share.promise);
    await addFolderFromMenu();
    await openSessionRow('Beta');
    await act(async () => share.resolve({ status: 'refused', error: 'The filesystem root cannot be shared.' }));
    expect(byTestId('chat-send-error')).toBeNull();
    expect(byTestId('chat-add-folder-error')).toBeNull();

    await openSessionRow('Alpha');
    expect(byTestId('chat-add-folder-error')?.textContent).toBe(
      'Desktop could not share the folder, so the folder was not added: The filesystem root cannot be shared.'
    );
  });

  it('drops a /add-dir refusal for a chat the user left, without an unhandled rejection', async () => {
    // The renderer's tsconfig has no Node types, but vitest runs this file under Node.
    type RejectionHook = (event: 'unhandledRejection', listener: (reason: unknown) => void) => void;
    const node = (globalThis as unknown as { process: { on: RejectionHook; off: RejectionHook } }).process;
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => void rejections.push(reason);
    node.on('unhandledRejection', onRejection);
    try {
      stubBridge([summary('alpha', 'chat', undefined, 'Alpha'), summary('beta', 'chat', undefined, 'Beta')]);
      await renderShell();
      await openSessionRow('Alpha');

      const share = deferred<ShareDirectoryResult>();
      addContextDirectory.mockReturnValue(share.promise);
      await typeCommand('/add-dir /nowhere');
      await openSessionRow('Beta');
      await act(async () => share.resolve({ status: 'refused', error: 'Not a folder.' }));
      await act(() => new Promise(resolve => setTimeout(resolve, 0)));
      expect(rejections).toEqual([]);

      await openSessionRow('Alpha');
      expect(byTestId('chat-send-error')).toBeNull();
      expect(byTestId('chat-add-folder-error')).toBeNull();
    } finally {
      node.off('unhandledRejection', onRejection);
    }
  });

  it('does not show "already shared" for a share that returns after the user moved to another chat', async () => {
    stubBridge([summary('alpha', 'chat', undefined, 'Alpha'), summary('beta', 'chat', undefined, 'Beta')]);
    await renderShell();
    await openSessionRow('Alpha');

    const share = deferred<ShareDirectoryResult>();
    addContextDirectory.mockReturnValue(share.promise);
    await addFolderFromMenu();
    await openSessionRow('Beta');
    await act(async () => share.resolve({ status: 'already', path: NOTES }));
    expect(byTestId('chat-notice')).toBeNull();
  });

  it('shows the home-folder warning for a share that lands after the user left, in its own chat only', async () => {
    stubBridge([summary('alpha', 'chat', undefined, 'Alpha'), summary('beta', 'chat', undefined, 'Beta')]);
    await renderShell();
    await openSessionRow('Alpha');

    const share = deferred<ShareDirectoryResult>();
    addContextDirectory.mockReturnValue(share.promise);
    await addFolderFromMenu();
    await openSessionRow('Beta');
    await act(async () =>
      share.resolve({
        status: 'added',
        path: NOTES,
        warning: 'This is your home folder.',
        session: summary('alpha', 'chat', [NOTES], 'Alpha'),
      })
    );
    expect(byTestId('chat-notice')).toBeNull();
    expect(byTestId('chat-add-folder-notice')).toBeNull();
    expect(chips()).toHaveLength(0);

    await openSessionRow('Alpha');
    expect(byTestId('chat-add-folder-notice')?.textContent).toBe(
      `Shared ${NOTES} with this conversation. This is your home folder.`
    );
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);
  });

  it('shares into the chat the first-run seed opened while the picker was up, without making another', async () => {
    const stored = stubBridge([]);
    const seed = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => seed.promise);
    await renderShell();

    const picked = deferred<string | null>();
    pickProjectDirectory.mockReturnValue(picked.promise);
    addContextDirectory.mockResolvedValue({
      status: 'added',
      path: NOTES,
      session: summary('seeded', 'chat', [NOTES]),
    });
    await addFolderFromMenu();

    const seeded = summary('seeded');
    stored.set('seeded', seeded);
    await act(async () => seed.resolve({ session: seeded }));
    await act(async () => undefined);
    await act(async () => picked.resolve(NOTES));
    await act(async () => undefined);

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('seeded', NOTES);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);
    expect(byTestId('chat-add-folder-error')).toBeNull();
  });

  it('shows no alert over the seeded chat when the picker returns after the seed and a chat could not be made', async () => {
    const stored = stubBridge([]);
    const seed = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => seed.promise);
    createSession.mockRejectedValue(new Error('disk full'));
    await renderShell();

    const picked = deferred<string | null>();
    pickProjectDirectory.mockReturnValue(picked.promise);
    addContextDirectory.mockResolvedValue({
      status: 'added',
      path: NOTES,
      session: summary('seeded', 'chat', [NOTES]),
    });
    await addFolderFromMenu();

    const seeded = summary('seeded');
    stored.set('seeded', seeded);
    await act(async () => seed.resolve({ session: seeded }));
    await act(async () => undefined);
    await act(async () => picked.resolve(NOTES));
    await act(async () => undefined);

    expect(byTestId('chat-add-folder-error')).toBeNull();
    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('seeded', NOTES);
  });

  it('words a picker failure and a chat-creation failure differently, without the IPC wrapper', async () => {
    stubBridge([]);
    seedFails();
    await renderShell();

    pickProjectDirectory.mockRejectedValueOnce(
      new Error("Error invoking remote method 'chat:pickProjectDirectory': Error: dialog unavailable")
    );
    await addFolderFromMenu();
    expect(byTestId('chat-add-folder-error')?.textContent).toBe(
      'Desktop could not open the folder picker, so the folder was not added: dialog unavailable'
    );

    pickProjectDirectory.mockResolvedValueOnce(NOTES);
    createSession.mockRejectedValueOnce(
      new Error("Error invoking remote method 'chat:createSession': Error: disk full")
    );
    await addFolderFromMenu();
    expect(byTestId('chat-add-folder-error')?.textContent).toBe(
      'Desktop could not start a conversation, so the folder was not added: disk full'
    );
  });

  it('clears the alert when a retry starts, even if the picker is then cancelled', async () => {
    stubBridge([]);
    seedFails();
    createSession.mockRejectedValueOnce(new Error('disk full'));
    await renderShell();

    pickProjectDirectory.mockResolvedValueOnce(NOTES);
    await addFolderFromMenu();
    expect(byTestId('chat-add-folder-error')).not.toBeNull();

    pickProjectDirectory.mockResolvedValueOnce(null);
    await addFolderFromMenu();
    expect(byTestId('chat-add-folder-error')).toBeNull();
  });

  it('clears the alert once a chat opens', async () => {
    const stored = stubBridge([]);
    const seed = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => seed.promise);
    await renderShell();

    pickProjectDirectory.mockRejectedValueOnce(new Error('dialog unavailable'));
    await addFolderFromMenu();
    expect(byTestId('chat-add-folder-error')).not.toBeNull();

    const seeded = summary('seeded');
    stored.set('seeded', seeded);
    await act(async () => seed.resolve({ session: seeded }));
    await act(async () => undefined);
    expect(byTestId('chat-add-folder-error')).toBeNull();
  });

  it('does not leave the Chat alert up in a Code pane with no sessions', async () => {
    stubBridge([]);
    seedFails();
    createSession.mockRejectedValueOnce(new Error('disk full'));
    await renderShell();

    pickProjectDirectory.mockResolvedValueOnce(NOTES);
    await addFolderFromMenu();
    expect(byTestId('chat-add-folder-error')).not.toBeNull();

    await act(async () => byTestId('mode-switch-code-btn')?.click());
    await act(async () => undefined);
    expect(byTestId('chat-add-folder-error')).toBeNull();
  });

  it('with no conversation yet, ignores a second Add folder while the first is still under way', async () => {
    stubBridge([]);
    seedFails();
    await renderShell();

    const picked = deferred<string | null>();
    pickProjectDirectory.mockReturnValue(picked.promise);
    addContextDirectory.mockResolvedValue({ status: 'added', path: NOTES, session: summary('fresh', 'chat', [NOTES]) });
    await addFolderFromMenu();
    await addFolderFromMenu();
    expect(pickProjectDirectory).toHaveBeenCalledTimes(1);

    await act(async () => picked.resolve(NOTES));
    await act(async () => undefined);
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('fresh', NOTES);
  });

  it('with no conversation yet, says why no chat was started and lets the user try again', async () => {
    stubBridge([]);
    seedFails();
    createSession.mockRejectedValueOnce(new Error('disk full'));
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    await addFolderFromMenu();
    expect(byTestId('chat-add-folder-error')?.textContent).toContain('disk full');
    expect(addContextDirectory).not.toHaveBeenCalled();

    addContextDirectory.mockResolvedValue({ status: 'added', path: NOTES, session: summary('fresh', 'chat', [NOTES]) });
    await addFolderFromMenu();
    expect(byTestId('chat-add-folder-error')).toBeNull();
    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('fresh', NOTES);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);
  });

  it('does not let a slow first-run seed replace a chat the user started with New', async () => {
    const stored = stubBridge([]);
    const seed = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => seed.promise);
    await renderShell();

    const other = summary('other', 'chat', undefined, 'Other');
    stored.set('other', other);
    createSession.mockResolvedValueOnce({ session: other });
    await act(async () => byTestId('chat-new-session-btn')?.click());
    await act(async () => undefined);
    const seeded = summary('seeded', 'chat', undefined, 'Seeded');
    stored.set('seeded', seeded);
    await act(async () => seed.resolve({ session: seeded }));
    await act(async () => undefined);

    addContextDirectory.mockResolvedValue({ status: 'added', path: NOTES, session: summary('other', 'chat', [NOTES]) });
    await addFolderFromMenu();
    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('other', undefined);
  });

  it('joins a first-run seed still in flight when the folder is picked, making no second chat', async () => {
    const stored = stubBridge([]);
    const seed = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => seed.promise);
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockResolvedValue({
      status: 'added',
      path: NOTES,
      session: summary('seeded', 'chat', [NOTES]),
    });
    await addFolderFromMenu();
    expect(addContextDirectory).not.toHaveBeenCalled();

    const seeded = summary('seeded');
    stored.set('seeded', seeded);
    await act(async () => seed.resolve({ session: seeded }));
    await act(async () => undefined);

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('seeded', NOTES);
    expect(document.querySelectorAll('[data-testid="chat-session-item"]')).toHaveLength(1);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);
  });

  it('joins a first-run seed that settled before the picked folder came back but has not opened yet', async () => {
    const stored = stubBridge([]);
    const seed = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => seed.promise);
    await renderShell();

    const picked = deferred<string | null>();
    pickProjectDirectory.mockReturnValue(picked.promise);
    addContextDirectory.mockResolvedValue({
      status: 'added',
      path: NOTES,
      session: summary('seeded', 'chat', [NOTES]),
    });
    await addFolderFromMenu();

    const seeded = summary('seeded');
    stored.set('seeded', seeded);
    // One act scope holds every render until it ends, so the seed's chat is not open yet when the pick returns.
    await act(async () => {
      seed.resolve({ session: seeded });
      await tick();
      picked.resolve(NOTES);
      await tick();
    });
    await act(async () => undefined);

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('seeded', NOTES);
    expect(document.querySelectorAll('[data-testid="chat-session-item"]')).toHaveLength(1);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);
  });

  it('makes its own chat when the first-run seed it was waiting on fails', async () => {
    stubBridge([]);
    const seed = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => seed.promise);
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockResolvedValue({ status: 'added', path: NOTES, session: summary('fresh', 'chat', [NOTES]) });
    await addFolderFromMenu();
    await act(async () => seed.reject(new Error('disk busy')));
    await act(async () => undefined);

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('fresh', NOTES);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);
    expect(byTestId('chat-add-folder-error')).toBeNull();
  });

  it('makes its own chat when the first-run seed it was waiting on never settles', async () => {
    stubBridge([]);
    createSession.mockImplementationOnce(() => new Promise(() => undefined));
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockResolvedValue({ status: 'added', path: NOTES, session: summary('fresh', 'chat', [NOTES]) });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await addFolderFromMenu();
      await act(async () => void (await vi.advanceTimersByTimeAsync(1_000)));
      expect(createSession).toHaveBeenCalledTimes(1);

      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
    } finally {
      vi.useRealTimers();
    }
    await act(async () => undefined);

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('fresh', NOTES);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);
  });

  it('opens its own chat over a first-run seed that landed after the wait ended', async () => {
    window.localStorage.removeItem(LAST_SESSION_KEY);
    const stored = stubBridge([]);
    const seed = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => seed.promise);
    const made = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => made.promise);
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockResolvedValue({ status: 'added', path: NOTES, session: summary('made', 'chat', [NOTES]) });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await addFolderFromMenu();
      await act(async () => void (await vi.advanceTimersByTimeAsync(3_500)));
    } finally {
      vi.useRealTimers();
    }
    expect(createSession).toHaveBeenCalledTimes(2);
    const seeded = summary('seeded');
    const fresh = summary('made');
    stored.set('seeded', seeded);
    stored.set('made', fresh);
    await act(async () => seed.resolve({ session: seeded }));
    await act(async () => undefined);
    await act(async () => made.resolve({ session: fresh }));
    await act(async () => undefined);

    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('made', NOTES);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);
    expect(JSON.parse(window.localStorage.getItem(LAST_SESSION_KEY) ?? 'null')).toEqual({ id: 'made', mode: 'chat' });
  });

  it('shares into a late first-run chat that opened when the chat Add folder was making fails', async () => {
    const stored = stubBridge([]);
    const seed = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => seed.promise);
    const made = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => made.promise);
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockResolvedValue({
      status: 'added',
      path: NOTES,
      session: summary('seeded', 'chat', [NOTES]),
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await addFolderFromMenu();
      await act(async () => void (await vi.advanceTimersByTimeAsync(3_500)));
    } finally {
      vi.useRealTimers();
    }
    const seeded = summary('seeded');
    stored.set('seeded', seeded);
    await act(async () => seed.resolve({ session: seeded }));
    await act(async () => undefined);
    await act(async () => made.reject(new Error('disk full')));
    await act(async () => undefined);

    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('seeded', NOTES);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);
    expect(byTestId('chat-add-folder-error')).toBeNull();
  });

  it('shares into a chat the user opened during the first-run wait, making none', async () => {
    const stored = stubBridge([]);
    createSession.mockImplementationOnce(() => new Promise(() => undefined));
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockResolvedValue({ status: 'added', path: NOTES, session: summary('other', 'chat', [NOTES]) });
    const other = summary('other', 'chat', undefined, 'Other');
    stored.set('other', other);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await addFolderFromMenu();
      createSession.mockResolvedValueOnce({ session: other });
      await act(async () => byTestId('chat-new-session-btn')?.click());
      await act(async () => void (await vi.advanceTimersByTimeAsync(3_500)));
    } finally {
      vi.useRealTimers();
    }
    await act(async () => undefined);

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('other', NOTES);
    expect(document.querySelectorAll('[data-testid="chat-session-item"]')).toHaveLength(1);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);
  });

  it('shares into a late first-run chat that already has messages and removes the one it made', async () => {
    const stored = stubBridge([]);
    const seed = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => seed.promise);
    const made = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => made.promise);
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockResolvedValue({
      status: 'added',
      path: NOTES,
      session: summary('seeded', 'chat', [NOTES]),
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await addFolderFromMenu();
      await act(async () => void (await vi.advanceTimersByTimeAsync(3_500)));
    } finally {
      vi.useRealTimers();
    }
    const seeded = { ...summary('seeded'), messageCount: 2 };
    const fresh = summary('made');
    stored.set('seeded', seeded);
    stored.set('made', fresh);
    await act(async () => seed.resolve({ session: seeded }));
    await act(async () => undefined);
    await act(async () => made.resolve({ session: fresh }));
    await act(async () => undefined);

    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('seeded', NOTES);
    expect(deleteSession).toHaveBeenCalledExactlyOnceWith('made', false);
    expect(document.querySelectorAll('[data-testid="chat-session-item"]')).toHaveLength(1);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);
  });

  it('shares into a late first-run chat the user sent in while the new chat was being made, and removes the new one', async () => {
    const stored = stubBridge([], { sendMessage: async () => ({ ok: true }) });
    const seed = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => seed.promise);
    const made = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => made.promise);
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockResolvedValue({
      status: 'added',
      path: NOTES,
      session: summary('seeded', 'chat', [NOTES]),
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await addFolderFromMenu();
      await act(async () => void (await vi.advanceTimersByTimeAsync(3_500)));
    } finally {
      vi.useRealTimers();
    }
    const seeded = summary('seeded');
    const fresh = summary('made');
    stored.set('seeded', seeded);
    stored.set('made', fresh);
    await act(async () => seed.resolve({ session: seeded }));
    await act(async () => undefined);
    heldLoads.set('seeded', new Promise(() => undefined));
    await typeCommand('hello');
    await act(async () => made.resolve({ session: fresh }));
    await act(async () => undefined);

    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('seeded', NOTES);
    expect(deleteSession).toHaveBeenCalledExactlyOnceWith('made', false);
  });

  it('shares into the late first-run chat when it lands in the same tick the new chat fails', async () => {
    const stored = stubBridge([]);
    const seed = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => seed.promise);
    const made = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => made.promise);
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockResolvedValue({
      status: 'added',
      path: NOTES,
      session: summary('seeded', 'chat', [NOTES]),
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await addFolderFromMenu();
      await act(async () => void (await vi.advanceTimersByTimeAsync(3_500)));
    } finally {
      vi.useRealTimers();
    }
    const seeded = summary('seeded');
    stored.set('seeded', seeded);
    seed.resolve({ session: seeded });
    made.reject(new Error('disk full'));
    await act(async () => undefined);
    await act(async () => undefined);

    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('seeded', NOTES);
    expect(byTestId('chat-add-folder-error')).toBeNull();
  });

  it('tells the user when the empty chat it made cannot be removed after sharing into the late first-run chat', async () => {
    const stored = stubBridge([]);
    const seed = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => seed.promise);
    const made = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => made.promise);
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockResolvedValue({
      status: 'added',
      path: NOTES,
      session: summary('seeded', 'chat', [NOTES]),
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await addFolderFromMenu();
      await act(async () => void (await vi.advanceTimersByTimeAsync(3_500)));
    } finally {
      vi.useRealTimers();
    }
    const seeded = { ...summary('seeded'), messageCount: 2 };
    const fresh = summary('made');
    stored.set('seeded', seeded);
    stored.set('made', fresh);
    await act(async () => seed.resolve({ session: seeded }));
    await act(async () => undefined);
    deleteSession.mockRejectedValue(new Error('locked'));
    await act(async () => made.resolve({ session: fresh }));
    await act(async () => undefined);

    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('seeded', NOTES);
    expect(byTestId('chat-add-folder-notice')?.textContent).toContain('could not remove the empty conversation');
  });

  describe('when the new chat fails after the first-run wait', () => {
    async function waitOutSeed() {
      const stored = stubBridge([], { createCodeSession: () => new Promise(() => undefined) });
      const seed = deferred<{ session: ChatSessionSummary }>();
      createSession.mockImplementationOnce(() => seed.promise);
      const made = deferred<{ session: ChatSessionSummary }>();
      createSession.mockImplementationOnce(() => made.promise);
      await renderShell();
      pickProjectDirectory.mockResolvedValue(NOTES);
      addContextDirectory.mockResolvedValue({
        status: 'added',
        path: NOTES,
        session: summary('seeded', 'chat', [NOTES]),
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        await addFolderFromMenu();
        await act(async () => void (await vi.advanceTimersByTimeAsync(3_500)));
      } finally {
        vi.useRealTimers();
      }
      const seeded = summary('seeded');
      stored.set('seeded', seeded);
      return { stored, seed, made, seeded };
    }

    it('shares nothing when the shell unmounted before the first-run chat landed', async () => {
      const { seed, made, seeded } = await waitOutSeed();
      act(() => root?.unmount());
      root = null;
      seed.resolve({ session: seeded });
      made.reject(new Error('disk full'));
      await tick();
      await tick();

      expect(addContextDirectory).not.toHaveBeenCalled();
    });

    it('shares nothing when the window is in Code mode when the first-run chat lands', async () => {
      const { seed, made, seeded } = await waitOutSeed();
      await act(async () => byTestId('mode-switch-code-btn')?.click());
      await act(async () => undefined);
      await act(async () => seed.resolve({ session: seeded }));
      await act(async () => made.reject(new Error('disk full')));
      await act(async () => undefined);

      expect(addContextDirectory).not.toHaveBeenCalled();
    });

    it('shares nothing into the first-run chat when the user has another chat open', async () => {
      const { stored, seed, made, seeded } = await waitOutSeed();
      const other = summary('other', 'chat', undefined, 'Other');
      stored.set('other', other);
      createSession.mockResolvedValueOnce({ session: other });
      await act(async () => byTestId('chat-new-session-btn')?.click());
      await act(async () => undefined);
      await act(async () => seed.resolve({ session: seeded }));
      await act(async () => made.reject(new Error('disk full')));
      await act(async () => undefined);

      expect(addContextDirectory).not.toHaveBeenCalledWith('seeded', NOTES);
    });
  });

  it('shares a folder from the no-chat path under StrictMode', async () => {
    stubBridge([]);
    seedFails();
    await renderShell(true);

    pickProjectDirectory.mockResolvedValueOnce(NOTES);
    addContextDirectory.mockResolvedValue({ status: 'added', path: NOTES, session: summary('fresh', 'chat', [NOTES]) });
    await addFolderFromMenu();
    await act(async () => undefined);

    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('fresh', NOTES);
  });

  it('makes no chat when the shell unmounts while Add folder waits on the first-run seed', async () => {
    stubBridge([]);
    createSession.mockImplementationOnce(() => new Promise(() => undefined));
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await addFolderFromMenu();
      act(() => root?.unmount());
      root = null;
      await vi.advanceTimersByTimeAsync(3_500);
    } finally {
      vi.useRealTimers();
    }

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(addContextDirectory).not.toHaveBeenCalled();
  });

  it('shares nothing when the shell unmounts while the chat Add folder is making is created', async () => {
    stubBridge([]);
    seedFails();
    const made = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => made.promise);
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    await addFolderFromMenu();
    expect(createSession).toHaveBeenCalledTimes(2);
    act(() => root?.unmount());
    root = null;
    await made.resolve({ session: summary('fresh') });
    await tick();

    expect(addContextDirectory).not.toHaveBeenCalled();
  });

  it('shares into the first-run chat that lands within the wait after a switch to Code mode', async () => {
    const stored = stubBridge([], { createCodeSession: () => new Promise(() => undefined) });
    const seed = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => seed.promise);
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockResolvedValue({
      status: 'added',
      path: NOTES,
      session: summary('seeded', 'chat', [NOTES]),
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await addFolderFromMenu();
      await act(async () => byTestId('mode-switch-code-btn')?.click());
      const seeded = summary('seeded');
      stored.set('seeded', seeded);
      await act(async () => seed.resolve({ session: seeded }));
      await act(async () => void (await vi.advanceTimersByTimeAsync(1_000)));
    } finally {
      vi.useRealTimers();
    }
    await act(async () => undefined);

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('seeded', NOTES);
  });

  it('makes no chat when the window switched to Code mode while Add folder waited on the first-run seed', async () => {
    stubBridge([], { createCodeSession: () => new Promise(() => undefined) });
    createSession.mockImplementationOnce(() => new Promise(() => undefined));
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await addFolderFromMenu();
      await act(async () => byTestId('mode-switch-code-btn')?.click());
      await act(async () => void (await vi.advanceTimersByTimeAsync(3_500)));
    } finally {
      vi.useRealTimers();
    }
    await act(async () => undefined);

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(addContextDirectory).not.toHaveBeenCalled();
  });

  it('makes its own chat when the first-run chat it was waiting on is deleted before the folder is picked', async () => {
    const stored = stubBridge([]);
    const seed = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => seed.promise);
    await renderShell();

    const picked = deferred<string | null>();
    pickProjectDirectory.mockReturnValue(picked.promise);
    addContextDirectory.mockResolvedValue({ status: 'added', path: NOTES, session: summary('fresh', 'chat', [NOTES]) });
    await addFolderFromMenu();
    const seeded = summary('seeded');
    stored.set('seeded', seeded);
    await act(async () => seed.resolve({ session: seeded }));
    await act(async () => undefined);
    await deleteOpenChat();

    await act(async () => picked.resolve(NOTES));
    await act(async () => undefined);

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('fresh', NOTES);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);
  });

  it('after the seed chat is deleted, Add folder with no chat open makes its own chat and shares into it', async () => {
    const stored = stubBridge([]);
    const seeded = summary('seeded');
    stored.set('seeded', seeded);
    createSession.mockResolvedValueOnce({ session: seeded });
    await renderShell();
    await deleteOpenChat();
    expect(document.querySelectorAll('[data-testid="chat-session-item"]')).toHaveLength(0);

    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockResolvedValue({ status: 'added', path: NOTES, session: summary('fresh', 'chat', [NOTES]) });
    await addFolderFromMenu();
    await act(async () => undefined);

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('fresh', NOTES);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);
  });

  it('does not hand the folder to a Code session the seed is still making', async () => {
    const codeSeed = deferred<{ ok: true; session: ChatSessionSummary }>();
    const stored = stubBridge([], { createCodeSession: () => codeSeed.promise });
    seedFails();
    const made = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => made.promise);
    await renderShell();
    await act(async () => byTestId('mode-switch-code-btn')?.click());
    await act(async () => byTestId('mode-switch-chat-btn')?.click());
    await act(async () => undefined);

    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockResolvedValue({ status: 'added', path: NOTES, session: summary('fresh', 'chat', [NOTES]) });
    await addFolderFromMenu();
    const coded = summary('code-seed', 'code');
    stored.set('code-seed', coded);
    await act(async () => codeSeed.resolve({ ok: true, session: coded }));
    await act(async () => undefined);
    await act(async () => made.resolve({ session: summary('fresh') }));
    await act(async () => undefined);

    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('fresh', NOTES);
  });

  it('drops a folder picked after the window switched to Code mode', async () => {
    stubBridge([summary('code-1', 'code', undefined, 'Code one')]);
    seedFails();
    await renderShell();

    const picked = deferred<string | null>();
    pickProjectDirectory.mockReturnValue(picked.promise);
    await addFolderFromMenu();
    await act(async () => byTestId('mode-switch-code-btn')?.click());
    await act(async () => undefined);
    await act(async () => picked.resolve(NOTES));
    await act(async () => undefined);

    expect(addContextDirectory).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('does not open the chat Add folder made in Code mode when the switch came while it was being made', async () => {
    window.localStorage.removeItem(LAST_SESSION_KEY);
    const stored = stubBridge([], { createCodeSession: () => new Promise(() => undefined) });
    seedFails();
    const made = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => made.promise);
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockResolvedValue({ status: 'added', path: NOTES, session: summary('fresh', 'chat', [NOTES]) });
    await addFolderFromMenu();
    await act(async () => byTestId('mode-switch-code-btn')?.click());
    await act(async () => undefined);
    const fresh = summary('fresh');
    stored.set('fresh', fresh);
    await act(async () => made.resolve({ session: fresh }));
    await act(async () => undefined);
    expect(window.localStorage.getItem(LAST_SESSION_KEY)).toBeNull();

    await act(async () => byTestId('mode-switch-chat-btn')?.click());
    await act(async () => undefined);
    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('fresh', NOTES);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);
  });

  it('does not open the first-run chat in Code mode when the switch came while it was being made', async () => {
    window.localStorage.removeItem(LAST_SESSION_KEY);
    const stored = stubBridge([], { createCodeSession: () => new Promise(() => undefined) });
    const seed = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => seed.promise);
    await renderShell();

    await act(async () => byTestId('mode-switch-code-btn')?.click());
    await act(async () => undefined);
    const seeded = summary('seeded');
    stored.set('seeded', seeded);
    await act(async () => seed.resolve({ session: seeded }));
    await act(async () => undefined);
    expect(window.localStorage.getItem(LAST_SESSION_KEY)).toBeNull();

    await act(async () => byTestId('mode-switch-chat-btn')?.click());
    await act(async () => undefined);
    expect(JSON.parse(window.localStorage.getItem(LAST_SESSION_KEY) ?? 'null')).toEqual({ id: 'seeded', mode: 'chat' });
  });

  it('shares into the new chat by id without waiting for it to load', async () => {
    stubBridge([]);
    seedFails();
    const loaded = deferred<void>();
    heldLoads.set('fresh', loaded.promise);
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockResolvedValue({ status: 'added', path: NOTES, session: summary('fresh', 'chat', [NOTES]) });
    await addFolderFromMenu();
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('fresh', NOTES);

    await act(async () => loaded.resolve());
    await act(async () => undefined);
    expect(addContextDirectory).toHaveBeenCalledTimes(1);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);
  });

  it('still shares into the new chat when the user leaves it before it loads, and never again on reopen', async () => {
    const stored = stubBridge([]);
    seedFails();
    heldLoads.set('fresh', new Promise(() => undefined));
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockResolvedValue({ status: 'added', path: NOTES, session: summary('fresh', 'chat', [NOTES]) });
    await addFolderFromMenu();
    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('fresh', NOTES);

    const other = summary('other', 'chat', undefined, 'Other');
    stored.set('other', other);
    createSession.mockResolvedValueOnce({ session: other });
    await act(async () => byTestId('chat-new-session-btn')?.click());
    await act(async () => undefined);
    heldLoads.delete('fresh');
    await openSessionRow('New conversation');

    expect(addContextDirectory).toHaveBeenCalledTimes(1);
  });

  it('reads a chat again when a share lands during its first read, then reads main on reopen', async () => {
    const stored = stubBridge([]);
    seedFails();
    const firstRead = deferred<void>();
    heldLoads.set('fresh', firstRead.promise);
    await renderShell();

    const share = deferred<ShareDirectoryResult>();
    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockReturnValue(share.promise);
    await addFolderFromMenu();
    await act(async () => share.resolve({ status: 'added', path: NOTES, session: summary('fresh', 'chat', [NOTES]) }));
    await act(async () => firstRead.resolve());
    await act(async () => undefined);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);

    const other = summary('other', 'chat', undefined, 'Other');
    stored.set('other', other);
    createSession.mockResolvedValueOnce({ session: other });
    await act(async () => byTestId('chat-new-session-btn')?.click());
    await act(async () => undefined);
    // Another window takes the folder back while this one looks elsewhere.
    stored.set('fresh', summary('fresh'));
    await openSessionRow('New conversation');
    expect(chips()).toHaveLength(0);
  });

  it('reads a chat from main on reopen, not from a share made while it was open', async () => {
    const stored = stubBridge([
      summary('alpha', 'chat', undefined, 'Alpha'),
      summary('beta', 'chat', undefined, 'Beta'),
    ]);
    await renderShell();
    await openSessionRow('Alpha');
    addContextDirectory.mockResolvedValue({
      status: 'added',
      path: NOTES,
      session: summary('alpha', 'chat', [NOTES], 'Alpha'),
    });
    await addFolderFromMenu();
    expect(chips()).toHaveLength(1);

    await openSessionRow('Beta');
    stored.set('alpha', summary('alpha', 'chat', undefined, 'Alpha'));
    await openSessionRow('Alpha');
    expect(chips()).toHaveLength(0);
  });

  it('keeps a share that lands while a chat the user came back to is being read again', async () => {
    stubBridge([summary('alpha', 'chat', undefined, 'Alpha'), summary('beta', 'chat', undefined, 'Beta')]);
    await renderShell();
    await openSessionRow('Alpha');
    const share = deferred<ShareDirectoryResult>();
    addContextDirectory.mockReturnValue(share.promise);
    await addFolderFromMenu();

    heldLoads.set('beta', new Promise(() => undefined));
    await openSessionRow('Beta');
    const reread = deferred<void>();
    heldLoads.set('alpha', reread.promise);
    await openSessionRow('Alpha');
    await act(async () =>
      share.resolve({ status: 'added', path: NOTES, session: summary('alpha', 'chat', [NOTES], 'Alpha') })
    );
    await act(async () => reread.resolve());
    await act(async () => undefined);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);
  });

  it('reads main on reopen after leaving a chat whose first read a share landed during', async () => {
    const stored = stubBridge([]);
    seedFails();
    heldLoads.set('fresh', new Promise(() => undefined));
    await renderShell();

    const share = deferred<ShareDirectoryResult>();
    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockReturnValue(share.promise);
    await addFolderFromMenu();
    await act(async () => share.resolve({ status: 'added', path: NOTES, session: summary('fresh', 'chat', [NOTES]) }));

    const other = summary('other', 'chat', undefined, 'Other');
    stored.set('other', other);
    createSession.mockResolvedValueOnce({ session: other });
    await act(async () => byTestId('chat-new-session-btn')?.click());
    await act(async () => undefined);
    heldLoads.delete('fresh');
    stored.set('fresh', summary('fresh'));
    await openSessionRow('New conversation');
    expect(chips()).toHaveLength(0);
  });

  it("does not lay one chat's share over another chat's read that was in flight when it landed", async () => {
    stubBridge([summary('alpha', 'chat', undefined, 'Alpha'), summary('beta', 'chat', undefined, 'Beta')]);
    await renderShell();
    await openSessionRow('Alpha');
    const share = deferred<ShareDirectoryResult>();
    addContextDirectory.mockReturnValue(share.promise);
    await addFolderFromMenu();

    const betaRead = deferred<void>();
    heldLoads.set('beta', betaRead.promise);
    await openSessionRow('Beta');
    await act(async () =>
      share.resolve({ status: 'added', path: NOTES, session: summary('alpha', 'chat', [NOTES], 'Alpha') })
    );
    await act(async () => betaRead.resolve());
    await act(async () => undefined);
    expect(chips()).toHaveLength(0);
  });

  it('does not make the Add folder chat take over a chat the user started while it was being created', async () => {
    const stored = stubBridge([]);
    seedFails();
    const made = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => made.promise);
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockResolvedValue({ status: 'added', path: NOTES, session: summary('fresh', 'chat', [NOTES]) });
    await addFolderFromMenu();

    const other = summary('other', 'chat', undefined, 'Other');
    stored.set('other', other);
    createSession.mockResolvedValueOnce({ session: other });
    await act(async () => byTestId('chat-new-session-btn')?.click());
    await act(async () => undefined);

    const fresh = summary('fresh');
    stored.set('fresh', fresh);
    await act(async () => made.resolve({ session: fresh }));
    await act(async () => undefined);

    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('fresh', NOTES);
    expect(chips()).toHaveLength(0);
  });

  it("leaves the open chat's error up when Add folder shares into the chat it made in the background", async () => {
    const stored = stubBridge([]);
    seedFails();
    const made = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => made.promise);
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    await addFolderFromMenu();

    const other = summary('other', 'chat', undefined, 'Other');
    stored.set('other', other);
    createSession.mockResolvedValueOnce({ session: other });
    await act(async () => byTestId('chat-new-session-btn')?.click());
    await act(async () => undefined);
    addContextDirectory.mockResolvedValueOnce({ status: 'refused', error: 'Not a folder.' });
    await typeCommand('/add-dir /nowhere');
    expect(byTestId('chat-send-error')?.textContent).toContain('Not a folder.');

    addContextDirectory.mockResolvedValue({ status: 'added', path: NOTES, session: summary('fresh', 'chat', [NOTES]) });
    const fresh = summary('fresh');
    stored.set('fresh', fresh);
    await act(async () => made.resolve({ session: fresh }));
    await act(async () => undefined);

    expect(addContextDirectory).toHaveBeenLastCalledWith('fresh', NOTES);
    expect(byTestId('chat-send-error')?.textContent).toContain('Not a folder.');
  });

  it('shows no start-failure alert in a chat the user opened while the chat was being created', async () => {
    const stored = stubBridge([]);
    seedFails();
    const made = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => made.promise);
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    await addFolderFromMenu();

    const other = summary('other', 'chat', undefined, 'Other');
    stored.set('other', other);
    createSession.mockResolvedValueOnce({ session: other });
    await act(async () => byTestId('chat-new-session-btn')?.click());
    await act(async () => undefined);
    await act(async () => made.reject(new Error('disk full')));
    await act(async () => undefined);

    expect(byTestId('chat-add-folder-error')).toBeNull();
  });

  it('shows no start-failure alert in the Code pane when the user switched modes while the chat was being created', async () => {
    stubBridge([]);
    seedFails();
    const made = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => made.promise);
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    await addFolderFromMenu();
    await act(async () => byTestId('mode-switch-code-btn')?.click());
    await act(async () => undefined);
    await act(async () => made.reject(new Error('disk full')));
    await act(async () => undefined);

    expect(byTestId('chat-add-folder-error')).toBeNull();
  });

  it('shows a main-side throw from the share in the open chat, saying the folder was not added, until clicked', async () => {
    stubBridge([summary('blank-1')]);
    await renderShell();
    await act(async () => byTestId('chat-session-item')?.click());
    await act(async () => undefined);

    addContextDirectory.mockRejectedValue(
      new Error("Error invoking remote method 'chat:addContextDirectory': Error: share store offline")
    );
    await addFolderFromMenu();

    expect(byTestId('chat-add-folder-error')?.textContent).toBe(
      'Desktop could not share the folder, so the folder was not added: share store offline'
    );
    expect(chips()).toHaveLength(0);

    await act(async () => byTestId('chat-add-folder-error')?.click());
    expect(byTestId('chat-add-folder-error')).toBeNull();
  });

  it('shows a throw from the share into a freshly made chat on that chat', async () => {
    stubBridge([]);
    seedFails();
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockRejectedValue(new Error('share store offline'));
    await addFolderFromMenu();
    await act(async () => undefined);

    expect(byTestId('chat-add-folder-error')?.textContent).toBe(
      'Desktop could not share the folder, so the folder was not added: share store offline'
    );
  });

  it('keeps a share failure off other chats and shows it when its own chat is open', async () => {
    stubBridge([summary('alpha', 'chat', undefined, 'Alpha'), summary('beta', 'chat', undefined, 'Beta')]);
    await renderShell();
    await openSessionRow('Alpha');

    const share = deferred<ShareDirectoryResult>();
    addContextDirectory.mockReturnValue(share.promise);
    await addFolderFromMenu();
    await openSessionRow('Beta');
    await act(async () => share.reject(new Error('share store offline')));
    await act(async () => undefined);
    expect(byTestId('chat-add-folder-error')).toBeNull();

    await openSessionRow('Alpha');
    expect(byTestId('chat-add-folder-error')?.textContent).toContain('share store offline');
  });

  it('keeps a reason that itself contains quotes and colons', async () => {
    stubBridge([]);
    seedFails();
    await renderShell();

    pickProjectDirectory.mockResolvedValueOnce(NOTES);
    createSession.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'chat:create-session': Error: could not write '/data/sessions': EACCES: permission denied"
      )
    );
    await addFolderFromMenu();
    expect(byTestId('chat-add-folder-error')?.textContent).toBe(
      "Desktop could not start a conversation, so the folder was not added: could not write '/data/sessions': EACCES: permission denied"
    );
  });

  it('ends the alert without a dangling colon when main gave no reason', async () => {
    stubBridge([]);
    seedFails();
    await renderShell();

    pickProjectDirectory.mockResolvedValueOnce(NOTES);
    createSession.mockRejectedValueOnce(new Error("Error invoking remote method 'chat:create-session': Error"));
    await addFolderFromMenu();
    expect(byTestId('chat-add-folder-error')?.textContent).toBe(
      'Desktop could not start a conversation, so the folder was not added'
    );
  });

  it('does not share a folder the user removed again when the new chat is reopened', async () => {
    const stored = stubBridge([]);
    seedFails();
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockResolvedValue({ status: 'added', path: NOTES, session: summary('fresh', 'chat', [NOTES]) });
    await addFolderFromMenu();
    expect(chips()).toHaveLength(1);
    removeContextDirectory.mockResolvedValue(summary('fresh'));
    await act(async () => chips()[0].querySelector('button')?.click());
    expect(chips()).toHaveLength(0);

    const other = summary('other', 'chat', undefined, 'Other');
    stored.set('other', other);
    createSession.mockResolvedValueOnce({ session: other });
    await act(async () => byTestId('chat-new-session-btn')?.click());
    await act(async () => undefined);
    await openSessionRow('New conversation');

    expect(addContextDirectory).toHaveBeenCalledTimes(1);
    expect(chips()).toHaveLength(0);
  });

  it("drops a chat's share-failure alert once /add-dir succeeds there", async () => {
    stubBridge([summary('blank-1')]);
    await renderShell();
    await act(async () => byTestId('chat-session-item')?.click());
    await act(async () => undefined);

    addContextDirectory.mockRejectedValueOnce(new Error('share store offline'));
    await addFolderFromMenu();
    expect(byTestId('chat-add-folder-error')).not.toBeNull();

    addContextDirectory.mockResolvedValue({
      status: 'added',
      path: NOTES,
      session: summary('blank-1', 'chat', [NOTES]),
    });
    await typeCommand(`/add-dir ${NOTES}`);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);
    expect(byTestId('chat-add-folder-error')).toBeNull();
  });

  it("drops a chat's share-failure alert once the model's folder request is granted there", async () => {
    const stored = stubBridge([summary('blank-1')]);
    await renderShell();
    await act(async () => byTestId('chat-session-item')?.click());
    await act(async () => undefined);

    addContextDirectory.mockRejectedValueOnce(new Error('share store offline'));
    await addFolderFromMenu();
    expect(byTestId('chat-add-folder-error')).not.toBeNull();

    stored.set('blank-1', summary('blank-1', 'chat', [NOTES]));
    await act(async () =>
      emit({
        type: 'tool-end',
        sessionId: 'blank-1',
        messageId: 'reply-1',
        call: {
          id: 'call-1',
          name: REQUEST_DIRECTORY_TOOL_NAME,
          input: { outcome: { status: 'granted' } },
          status: 'done',
        },
      })
    );
    await act(async () => undefined);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);
    expect(byTestId('chat-add-folder-error')).toBeNull();
  });

  it("keeps one chat's share-failure alert when Add folder is used in another chat", async () => {
    stubBridge([summary('alpha', 'chat', undefined, 'Alpha'), summary('beta', 'chat', undefined, 'Beta')]);
    await renderShell();
    await openSessionRow('Alpha');
    addContextDirectory.mockRejectedValueOnce(new Error('share store offline'));
    await addFolderFromMenu();
    expect(byTestId('chat-add-folder-error')).not.toBeNull();

    await openSessionRow('Beta');
    addContextDirectory.mockResolvedValue({
      status: 'added',
      path: NOTES,
      session: summary('beta', 'chat', [NOTES], 'Beta'),
    });
    await addFolderFromMenu();
    expect(chips()).toHaveLength(1);

    await openSessionRow('Alpha');
    expect(byTestId('chat-add-folder-error')?.textContent).toContain('share store offline');
  });

  it('keeps a refusal for a chat the user left and shows it when that chat is reopened', async () => {
    const stored = stubBridge([]);
    seedFails();
    const made = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => made.promise);
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockResolvedValue({ status: 'refused', error: 'The filesystem root cannot be shared.' });
    await addFolderFromMenu();

    const other = summary('other', 'chat', undefined, 'Other');
    stored.set('other', other);
    createSession.mockResolvedValueOnce({ session: other });
    await act(async () => byTestId('chat-new-session-btn')?.click());
    await act(async () => undefined);
    const fresh = summary('fresh');
    stored.set('fresh', fresh);
    await act(async () => made.resolve({ session: fresh }));
    await act(async () => undefined);
    expect(byTestId('chat-add-folder-error')).toBeNull();

    await openSessionRow('New conversation');
    expect(byTestId('chat-add-folder-error')?.textContent).toContain('filesystem root cannot be shared');
  });

  it('shows a refusal that lands after a switch to Code mode once its chat is back in Chat mode', async () => {
    stubBridge([summary('alpha', 'chat', undefined, 'Alpha'), summary('code-1', 'code', undefined, 'Code one')]);
    await renderShell();
    await openSessionRow('Alpha');

    const share = deferred<ShareDirectoryResult>();
    addContextDirectory.mockReturnValue(share.promise);
    await addFolderFromMenu();
    await act(async () => byTestId('mode-switch-code-btn')?.click());
    await act(async () => undefined);
    await act(async () => share.resolve({ status: 'refused', error: 'The filesystem root cannot be shared.' }));
    await act(async () => undefined);
    expect(byTestId('chat-add-folder-error')).toBeNull();

    await act(async () => byTestId('mode-switch-chat-btn')?.click());
    await act(async () => undefined);
    expect(byTestId('chat-add-folder-error')?.textContent).toContain('filesystem root cannot be shared');
  });

  it('shows a refusal, an "already" notice and a warning for a freshly made chat in that chat', async () => {
    for (const [result, testId, text] of [
      [{ status: 'refused', error: 'The filesystem root cannot be shared.' }, 'chat-send-error', 'filesystem root'],
      [{ status: 'already', path: NOTES }, 'chat-notice', 'already shared'],
      [
        {
          status: 'added',
          path: NOTES,
          warning: 'This is your home folder.',
          session: summary('fresh', 'chat', [NOTES]),
        },
        'chat-notice',
        'home folder',
      ],
    ] as const) {
      stubBridge([]);
      seedFails();
      await renderShell();

      const share = deferred<ShareDirectoryResult>();
      pickProjectDirectory.mockResolvedValue(NOTES);
      addContextDirectory.mockReturnValue(share.promise);
      await addFolderFromMenu();
      await act(async () => share.resolve(result as ShareDirectoryResult));
      await act(async () => undefined);

      expect(byTestId(testId)?.textContent).toContain(text);
      expect(byTestId('chat-add-folder-error')).toBeNull();
      act(() => root?.unmount());
      host?.remove();
      root = null;
      host = null;
    }
  });

  it('does not bring back a failure from before any chat existed after the seed chat is deleted', async () => {
    const stored = stubBridge([]);
    const seed = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => seed.promise);
    await renderShell();

    pickProjectDirectory.mockRejectedValueOnce(new Error('dialog unavailable'));
    await addFolderFromMenu();
    expect(byTestId('chat-add-folder-error')).not.toBeNull();

    const seeded = summary('seeded');
    stored.set('seeded', seeded);
    await act(async () => seed.resolve({ session: seeded }));
    await act(async () => undefined);
    expect(byTestId('chat-add-folder-error')).toBeNull();

    await deleteOpenChat();
    expect(byTestId('chat-add-folder-error')).toBeNull();
  });

  it('does not bring back a start failure after the chat the user opened meanwhile is deleted', async () => {
    const stored = stubBridge([]);
    seedFails();
    const made = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => made.promise);
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    await addFolderFromMenu();

    const other = summary('other', 'chat', undefined, 'Other');
    stored.set('other', other);
    createSession.mockResolvedValueOnce({ session: other });
    await act(async () => byTestId('chat-new-session-btn')?.click());
    await act(async () => undefined);
    await act(async () => made.reject(new Error('disk full')));
    await act(async () => undefined);

    await deleteOpenChat();
    expect(byTestId('chat-add-folder-error')).toBeNull();
  });

  it('clears a stale error in the seeded chat when the picked folder is shared into it', async () => {
    const stored = stubBridge([]);
    const seed = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => seed.promise);
    await renderShell();

    const picked = deferred<string | null>();
    pickProjectDirectory.mockReturnValue(picked.promise);
    await addFolderFromMenu();
    const seeded = summary('seeded');
    stored.set('seeded', seeded);
    await act(async () => seed.resolve({ session: seeded }));
    await act(async () => undefined);

    addContextDirectory.mockResolvedValueOnce({ status: 'refused', error: 'Not a folder.' });
    await typeCommand('/add-dir /nowhere');
    expect(byTestId('chat-send-error')).not.toBeNull();

    addContextDirectory.mockResolvedValue({
      status: 'added',
      path: NOTES,
      session: summary('seeded', 'chat', [NOTES]),
    });
    await act(async () => picked.resolve(NOTES));
    await act(async () => undefined);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);
    expect(byTestId('chat-send-error')).toBeNull();
  });

  it('keeps Add folder off while the open chat is still loading', async () => {
    const loaded = deferred<void>();
    heldLoads.set('alpha', loaded.promise);
    stubBridge([summary('alpha')]);
    await renderShell();

    const addFolderItem = async () => {
      if (!byTestId('composer-add-folder-item')) await act(async () => byTestId('composer-plus-btn')?.click());
      return byTestId('composer-add-folder-item');
    };
    expect((await addFolderItem())?.getAttribute('aria-disabled')).toBe('true');
    await act(async () => (await addFolderItem())?.click());
    expect(addContextDirectory).not.toHaveBeenCalled();

    await act(async () => loaded.resolve());
    await act(async () => undefined);
    expect((await addFolderItem())?.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('follows the window mode, not the previous mode, when the mode is switched', async () => {
    stubBridge([summary('chat-1', 'chat', undefined, 'Chat one'), summary('code-1', 'code', undefined, 'Code one')]);
    await renderShell();
    expect(byTestId('composer-plus-btn')).not.toBeNull();

    const codeLoad = deferred<void>();
    heldLoads.set('code-1', codeLoad.promise);
    await act(async () => byTestId('mode-switch-code-btn')?.click());
    await act(async () => undefined);
    expect(byTestId('composer-plus-btn')).toBeNull();
    expect(byTestId('composer-attach-btn')).not.toBeNull();
    await act(async () => codeLoad.resolve());
    await act(async () => undefined);

    const chatLoad = deferred<void>();
    heldLoads.set('chat-1', chatLoad.promise);
    await act(async () => byTestId('mode-switch-chat-btn')?.click());
    await act(async () => undefined);
    expect(byTestId('composer-plus-btn')).toBeNull();
    await act(async () => chatLoad.resolve());
    await act(async () => undefined);
    expect(byTestId('composer-plus-btn')).not.toBeNull();
  });

  it('leaves "+" the attach button in a Code session', async () => {
    stubBridge([summary('code-1', 'code')]);
    createSession.mockImplementation(() => new Promise(() => undefined));
    await renderShell();
    await act(async () => byTestId('mode-switch-code-btn')?.click());
    await act(async () => byTestId('chat-session-item')?.click());
    await act(async () => undefined);

    expect(byTestId('chat-code-workspace-setup')).not.toBeNull();
    expect(byTestId('composer-plus-btn')).toBeNull();
    expect(byTestId('composer-attach-btn')).not.toBeNull();
  });
});
