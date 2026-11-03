// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSession, ChatSessionSummary } from '@shared/chat';
import type { ShareDirectoryResult } from '@shared/directoryRequest';
import { EMPTY_SIDEBAR_SECTIONS } from '@shared/sidebarSections';
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

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

/** Session reads for these ids wait on the promise, so a test can order the load against a share. */
const heldLoads = new Map<string, Promise<void>>();

function stubBridge(sessions: ChatSessionSummary[]) {
  const stored = new Map(sessions.map(session => [session.id, session]));
  createSession.mockImplementation(async () => {
    const session = summary('fresh');
    stored.set(session.id, session);
    return { session };
  });
  (window as unknown as { b4m: unknown }).b4m = new Proxy(
    {
      chat: quietBridge({
        listSessions: async () => sessions,
        getSession: async (id: string) => {
          await heldLoads.get(id);
          const session = stored.get(id);
          return session ? ({ ...session, messages: [] } as unknown as ChatSession) : null;
        },
        getQueuedMessages: async () => [],
        getSessionStatuses: async () => [],
        listModels: async () => ({ models: [] }),
        listArtifacts: async () => ({ artifacts: [], total: 0 }),
        createSession,
        pickProjectDirectory,
        addContextDirectory,
        removeContextDirectory,
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
  for (const mock of [createSession, pickProjectDirectory, addContextDirectory, removeContextDirectory])
    mock.mockReset();
  heldLoads.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderShell(): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <ChatShell />
      </CssVarsProvider>
    );
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
    // The first-run seed never lands, which leaves the window with no conversation at all.
    createSession.mockImplementationOnce(() => new Promise(() => undefined));
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

  it('with no conversation yet, ignores a second Add folder while the first is still under way', async () => {
    stubBridge([]);
    createSession.mockImplementationOnce(() => new Promise(() => undefined));
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
    createSession.mockImplementationOnce(() => new Promise(() => undefined));
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

  it('does not let a slow first-run seed replace the chat Add folder started', async () => {
    const stored = stubBridge([]);
    const seed = deferred<{ session: ChatSessionSummary }>();
    createSession.mockImplementationOnce(() => seed.promise);
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockResolvedValue({ status: 'added', path: NOTES, session: summary('fresh', 'chat', [NOTES]) });
    await addFolderFromMenu();
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);

    const seeded = summary('seeded', 'chat', undefined, 'Seeded');
    stored.set('seeded', seeded);
    await act(async () => seed.resolve({ session: seeded }));
    await act(async () => undefined);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);
  });

  it('shares into the new chat only once it has loaded', async () => {
    stubBridge([]);
    createSession.mockImplementationOnce(() => new Promise(() => undefined));
    const loaded = deferred<void>();
    heldLoads.set('fresh', loaded.promise);
    await renderShell();

    pickProjectDirectory.mockResolvedValue(NOTES);
    addContextDirectory.mockResolvedValue({ status: 'added', path: NOTES, session: summary('fresh', 'chat', [NOTES]) });
    await addFolderFromMenu();
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(addContextDirectory).not.toHaveBeenCalled();

    await act(async () => loaded.resolve());
    await act(async () => undefined);
    expect(addContextDirectory).toHaveBeenCalledExactlyOnceWith('fresh', NOTES);
    expect(chips().map(chip => chip.textContent)).toEqual([NOTES]);
  });

  it('does not share a folder the user removed again when the new chat is reopened', async () => {
    const stored = stubBridge([]);
    createSession.mockImplementationOnce(() => new Promise(() => undefined));
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
