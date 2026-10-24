// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type {
  BackgroundProcessInfo,
  ChatMessage,
  ChatProject,
  ChatSession,
  ChatSessionSummary,
  SendMessageResult,
} from '@shared/chat';
import { EMPTY_SIDEBAR_SECTIONS } from '@shared/sidebarSections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ChatShell } from './ChatShell';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./CustomizePanel', () => ({ CustomizeNavItem: () => null, CustomizeScreen: () => null }));
// The chips' own behaviour is SessionChips.test.tsx's; here it only matters where they are drawn.
vi.mock('./SessionChips', () => ({
  SessionChips: ({
    layout = 'row',
    binding,
    inUse = false,
    project,
  }: {
    layout?: string;
    inUse?: boolean;
    project: ChatProject | null;
    binding: { error: { message: string } | null; chooseDirectory: (directory: string) => Promise<void> };
  }) => (
    <div data-testid={`session-chips-${layout}`} data-in-use={inUse} data-project-directory={project?.directory}>
      <button data-testid={`session-chips-pick-${layout}`} onClick={() => void binding.chooseDirectory('/elsewhere')} />
      {binding.error && <span data-testid={`session-chips-error-${layout}`}>{binding.error.message}</span>}
    </div>
  ),
  GrantedFolderChips: () => null,
}));

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

const PROJECT: ChatProject = {
  directory: '/Users/someone/code/thing',
  name: 'thing',
  branch: 'main',
  workspace: false,
  workingDirectory: '/Users/someone/code/thing',
  contextDirectories: [],
};

const session = (id: string, over: Partial<ChatSessionSummary>): ChatSessionSummary =>
  ({
    id,
    title: id,
    mode: 'code',
    messageCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }) as ChatSessionSummary;

const SESSIONS = [
  session('bound', { project: PROJECT }),
  session('unbound', {}),
  session('chatting', { mode: 'chat' }),
];

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

/** What the bridge reports for the open session; reset in beforeEach. */
let transcript: ChatMessage[] = [];
let processes: BackgroundProcessInfo[] = [];
let updateProject: () => Promise<unknown> = async () => ({ ok: true });
let sendMessage: () => Promise<SendMessageResult>;

let root: Root | null = null;
let host: HTMLElement | null = null;

/** The width every element reports, which is the thread region's as far as the panel can tell. */
function paneWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width } as DOMRect);
}

beforeEach(() => {
  window.localStorage.clear();
  transcript = [];
  processes = [];
  updateProject = async () => ({ ok: true });
  sendMessage = async () => ({ ok: true, messageId: 'm1' });
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
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  (window as unknown as { b4m: unknown }).b4m = new Proxy(
    {
      chat: quietBridge({
        listSessions: async () => SESSIONS,
        getSession: async (id: string) =>
          ({ ...SESSIONS.find(entry => entry.id === id), messages: transcript }) as unknown as ChatSession,
        listBackgroundProcesses: async () => processes,
        inspectProject: async () => ({ currentBranch: 'main', branches: [] }),
        updateProject: () => updateProject(),
        sendMessage: () => sendMessage(),
        getQueuedMessages: async () => [],
        getSessionStatuses: async () => [],
        listModels: async () => ({ models: [] }),
        workspaceChanges: async () => null,
      }),
      sidebar: quietBridge({ getSections: async () => EMPTY_SIDEBAR_SECTIONS }),
      pullRequests: quietBridge({ watch: async () => null }),
    },
    {
      get(target, name: string | symbol) {
        if (typeof name !== 'string') return undefined;
        return name in target ? target[name as keyof typeof target] : quietBridge({});
      },
    }
  );
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const find = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const get = (testId: string) => {
  const found = find(testId);
  if (!found) throw new Error(`no ${testId}`);
  return found;
};

async function open(sessionId: string, mode: 'code' | 'chat' = 'code') {
  window.localStorage.setItem('b4m.chat.lastSession', JSON.stringify({ id: sessionId, mode }));
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
  await act(async () => undefined);
}

async function sendFirstMessage() {
  const input = get('chat-composer-input');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setter) throw new Error('no textarea value setter');
  await act(async () => {
    setter.call(input, 'Fix the login form');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => get('chat-send-btn').click());
}

function deferSend() {
  let resolveSend: (result: SendMessageResult) => void = () => {
    throw new Error('send has not started');
  };
  sendMessage = () =>
    new Promise<SendMessageResult>(resolve => {
      resolveSend = resolve;
    });
  return (result: SendMessageResult) => resolveSend(result);
}

describe('the session panel in the shell', () => {
  it('docks over the thread of a Code session with a folder, holding the chips the composer used to', async () => {
    paneWidth(1600);
    transcript = [{ id: 'm1', role: 'user', content: 'Hello', createdAt: '2026-10-01T00:00:00.000Z' }];
    await open('bound');

    expect(get('session-panel').dataset.variant).toBe('docked');
    expect(get('chat-toggle-session-panel-btn').getAttribute('aria-expanded')).toBe('true');
    expect(get('session-panel').contains(find('session-chips-panel'))).toBe(true);
    expect(find('session-chips-row')).toBeNull();
  });

  it('hides from the header button and remembers it', async () => {
    paneWidth(1600);
    transcript = [{ id: 'm1', role: 'user', content: 'Hello', createdAt: '2026-10-01T00:00:00.000Z' }];
    await open('bound');

    await act(async () => get('chat-toggle-session-panel-btn').click());
    expect(find('session-panel')).toBeNull();
    expect(get('chat-toggle-session-panel-btn').getAttribute('aria-expanded')).toBe('false');
    expect(window.localStorage.getItem('b4m.sessionPanel.open')).toBe('0');

    act(() => root?.unmount());
    host?.remove();
    await open('bound');
    expect(find('session-panel')).toBeNull();
  });

  it('folds into the header button on a narrow pane and opens as a popover that Escape shuts', async () => {
    paneWidth(900);
    transcript = [{ id: 'm1', role: 'user', content: 'Hello', createdAt: '2026-10-01T00:00:00.000Z' }];
    await open('bound');
    expect(find('session-panel')).toBeNull();

    await act(async () => get('chat-toggle-session-panel-btn').click());
    expect(get('session-panel').dataset.variant).toBe('popover');

    await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(find('session-panel')).toBeNull();
    // A popover is transient: the docked preference is untouched.
    expect(window.localStorage.getItem('b4m.sessionPanel.open')).toBeNull();
  });

  it('centers setup in an empty Code transcript without duplicating it above the composer', async () => {
    paneWidth(1600);
    await open('unbound');
    expect(find('chat-toggle-session-panel-btn')).toBeNull();
    expect(find('session-panel')).toBeNull();
    expect(get('chat-code-workspace-setup').contains(find('session-chips-embedded'))).toBe(true);
    expect(find('session-chips-row')).toBeNull();
    expect(find('session-chips-panel')).toBeNull();
    expect(find('chat-thread-empty')).toBeNull();
  });

  it('centers setup for an empty bound Code session instead of opening the panel', async () => {
    paneWidth(1600);
    await open('bound');
    expect(find('session-panel')).toBeNull();
    expect(find('chat-toggle-session-panel-btn')).toBeNull();
    expect(get('chat-code-workspace-setup').contains(find('session-chips-embedded'))).toBe(true);
  });

  it('moves workspace controls into the panel once the Code session has messages', async () => {
    paneWidth(1600);
    transcript = [{ id: 'm1', role: 'user', content: 'Hello', createdAt: '2026-10-01T00:00:00.000Z' }];
    await open('bound');
    expect(get('session-panel').contains(find('session-chips-panel'))).toBe(true);
    expect(find('chat-code-workspace-setup')).toBeNull();
    expect(find('session-chips-row')).toBeNull();
  });

  it('moves the same session into the panel and locks its grounding on the first send', async () => {
    paneWidth(1600);
    const resolveSend = deferSend();
    await open('bound');
    expect(get('session-chips-embedded').dataset.inUse).toBe('false');

    await sendFirstMessage();

    expect(get('chat-message-user').textContent).toContain('Fix the login form');
    expect(get('session-panel').contains(get('session-chips-panel'))).toBe(true);
    expect(get('session-chips-panel').dataset.inUse).toBe('true');
    expect(find('chat-code-workspace-setup')).toBeNull();
    expect(find('session-chips-embedded')).toBeNull();
    expect(find('session-chips-row')).toBeNull();

    await act(async () => resolveSend({ ok: true, messageId: 'm1' }));
    expect(get('session-chips-panel').dataset.inUse).toBe('true');
  });

  it('restores one editable embedded setup when the first send is refused', async () => {
    paneWidth(1600);
    const resolveSend = deferSend();
    await open('bound');
    await sendFirstMessage();
    expect(get('session-chips-panel').dataset.inUse).toBe('true');

    await act(async () => resolveSend({ ok: false, error: 'Could not start the turn' }));

    expect(get('chat-send-error').textContent).toBe('Could not start the turn');
    expect(find('chat-message-user')).toBeNull();
    expect(document.querySelectorAll('[data-testid="chat-code-workspace-setup"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-testid="session-chips-embedded"]')).toHaveLength(1);
    expect(get('session-chips-embedded').dataset.inUse).toBe('false');
    expect(find('session-panel')).toBeNull();
    expect(find('session-chips-panel')).toBeNull();
    expect(find('session-chips-row')).toBeNull();
  });

  it('keeps setup embedded after choosing a folder before the first message', async () => {
    paneWidth(1600);
    updateProject = async () => ({
      ok: true,
      session: session('unbound', { project: { ...PROJECT, directory: '/elsewhere', workingDirectory: '/elsewhere' } }),
    });
    await open('unbound');

    await act(async () => get('session-chips-pick-embedded').click());

    expect(get('session-chips-embedded').dataset.projectDirectory).toBe('/elsewhere');
    expect(get('session-chips-embedded').dataset.inUse).toBe('false');
    expect(get('chat-code-workspace-setup').contains(get('session-chips-embedded'))).toBe(true);
    expect(find('session-panel')).toBeNull();
    expect(find('chat-toggle-session-panel-btn')).toBeNull();
    expect(find('session-chips-row')).toBeNull();
  });

  it('is not offered on a Chat session', async () => {
    paneWidth(1600);
    await open('chatting', 'chat');
    expect(find('chat-toggle-session-panel-btn')).toBeNull();
    expect(find('session-panel')).toBeNull();
  });

  it('puts the plan bar and the running-tasks chip back when the panel is hidden', async () => {
    paneWidth(1600);
    transcript = [
      {
        id: 'm1',
        role: 'assistant',
        content: '',
        createdAt: '2026-10-01T00:00:00.000Z',
        toolCalls: [
          {
            id: 'c1',
            name: 'todo_write',
            status: 'done',
            input: { todos: [{ content: 'Ship it', status: 'in_progress' }] },
          },
        ],
      },
    ];
    processes = [
      {
        id: 'p1',
        sessionId: 'bound',
        command: 'pnpm dev',
        cwd: '/Users/someone/code/thing',
        status: 'running',
        startedAt: '2026-10-01T00:00:00.000Z',
        bufferedChars: 0,
        droppedChars: 0,
      },
    ];
    await open('bound');

    expect(find('session-panel-section-plan')).not.toBeNull();
    expect(find('session-panel-section-background')).not.toBeNull();
    expect(find('chat-todo-panel')).toBeNull();
    expect(find('background-task-chip')).toBeNull();

    await act(async () => get('chat-toggle-session-panel-btn').click());
    expect(find('session-panel')).toBeNull();
    expect(find('chat-todo-panel')).not.toBeNull();
    expect(find('background-task-chip')).not.toBeNull();
  });

  it('shows a project binding error above the composer once the panel is hidden', async () => {
    paneWidth(1600);
    transcript = [{ id: 'm1', role: 'user', content: 'Hello', createdAt: '2026-10-01T00:00:00.000Z' }];
    updateProject = async () => ({ ok: false, error: 'Could not read the repository' });
    await open('bound');

    await act(async () => get('session-chips-pick-panel').click());
    expect(get('session-chips-error-panel').textContent).toBe('Could not read the repository');
    expect(find('session-chips-row')).toBeNull();

    await act(async () => get('chat-toggle-session-panel-btn').click());
    expect(find('session-panel')).toBeNull();
    expect(get('session-chips-error-row').textContent).toBe('Could not read the repository');
  });
});

/**
 * Absolutely positioned elements that a scroller does not clip: their containing block lies
 * outside an overflow box they sit in, so they are laid out against the shell instead of the
 * transcript and a long thread lengthens the window's own document.
 */
function escapingAbsolutes(): HTMLElement[] {
  const positioned = (el: Element) => getComputedStyle(el).position !== 'static';
  const clips = (el: Element) => {
    const style = getComputedStyle(el);
    return [style.overflow, style.overflowX, style.overflowY].some(value => value && value !== 'visible');
  };
  return [...document.querySelectorAll<HTMLElement>('body *')].filter(el => {
    if (getComputedStyle(el).position !== 'absolute') return false;
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      if (positioned(node)) return false;
      if (clips(node)) return true;
    }
    return false;
  });
}

describe('the shell layout', () => {
  it('pins the shell to the viewport so the window itself never scrolls', async () => {
    paneWidth(1600);
    await open('bound');

    const shell = getComputedStyle(get('chat-shell'));
    expect(shell.height).toBe('100vh');
    expect(shell.overflow).toBe('clip');
  });

  it('keeps every absolutely positioned element inside the scroller it sits in', async () => {
    paneWidth(1600);
    const at = '2026-10-01T00:00:00.000Z';
    transcript = [
      { id: 'u1', role: 'user', content: 'First question', createdAt: at },
      { id: 'a1', role: 'assistant', content: 'First answer', createdAt: at },
      { id: 'u2', role: 'user', content: 'Second question', createdAt: at },
      { id: 'a2', role: 'assistant', content: 'Second answer', createdAt: at },
    ] as ChatMessage[];
    await open('bound');

    const statuses = document.querySelectorAll<HTMLElement>('[data-testid="chat-message-user-copy-btn-status"]');
    expect(statuses).toHaveLength(2);
    // The scroller is positioned too, so the walker alone would not notice the button's own wrapper going.
    for (const status of statuses) expect(getComputedStyle(status.parentElement as Element).position).toBe('relative');
    expect(escapingAbsolutes().map(el => el.dataset.testid ?? el.outerHTML.slice(0, 80))).toEqual([]);
  });

  it('docks the session panel outside the transcript scroller, so it does not scroll with the thread', async () => {
    paneWidth(1600);
    transcript = [
      { id: 'u1', role: 'user', content: 'A question', createdAt: '2026-10-01T00:00:00.000Z' },
    ] as ChatMessage[];
    await open('bound');
    expect(get('chat-thread').contains(get('session-panel'))).toBe(false);
  });
});
