// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatProject, ChatSession, ChatSessionSummary } from '@shared/chat';
import { EMPTY_SIDEBAR_SECTIONS } from '@shared/sidebarSections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ChatShell } from './ChatShell';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./CustomizePanel', () => ({ CustomizeNavItem: () => null, CustomizeScreen: () => null }));
// The chips' own behaviour is SessionChips.test.tsx's; here it only matters where they are drawn.
vi.mock('./SessionChips', () => ({
  SessionChips: ({ layout = 'row' }: { layout?: string }) => <div data-testid={`session-chips-${layout}`} />,
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

let root: Root | null = null;
let host: HTMLElement | null = null;

/** The width every element reports, which is the thread region's as far as the panel can tell. */
function paneWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width } as DOMRect);
}

beforeEach(() => {
  window.localStorage.clear();
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
          ({ ...SESSIONS.find(entry => entry.id === id), messages: [] }) as unknown as ChatSession,
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

describe('the session panel in the shell', () => {
  it('docks over the thread of a Code session with a folder, holding the chips the composer used to', async () => {
    paneWidth(1600);
    await open('bound');

    expect(get('session-panel').dataset.variant).toBe('docked');
    expect(get('chat-toggle-session-panel-btn').getAttribute('aria-expanded')).toBe('true');
    expect(get('session-panel').contains(find('session-chips-panel'))).toBe(true);
    expect(find('session-chips-row')).toBeNull();
  });

  it('hides from the header button and remembers it', async () => {
    paneWidth(1600);
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
    await open('bound');
    expect(find('session-panel')).toBeNull();

    await act(async () => get('chat-toggle-session-panel-btn').click());
    expect(get('session-panel').dataset.variant).toBe('popover');

    await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(find('session-panel')).toBeNull();
    // A popover is transient: the docked preference is untouched.
    expect(window.localStorage.getItem('b4m.sessionPanel.open')).toBeNull();
  });

  it('is not offered on an unbound Code session, whose chips stay above the composer', async () => {
    paneWidth(1600);
    await open('unbound');
    expect(find('chat-toggle-session-panel-btn')).toBeNull();
    expect(find('session-panel')).toBeNull();
    expect(find('session-chips-row')).not.toBeNull();
  });

  it('is not offered on a Chat session', async () => {
    paneWidth(1600);
    await open('chatting', 'chat');
    expect(find('chat-toggle-session-panel-btn')).toBeNull();
    expect(find('session-panel')).toBeNull();
  });
});
