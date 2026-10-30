// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSession, ChatSessionSummary } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ChatShell } from './ChatShell';
import { setWorktreeByDefault } from './worktreeDefault';

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

const PROJECT = {
  directory: '/repo',
  name: 'repo',
  branch: 'main',
  workspace: false,
  workingDirectory: '/repo',
};

const FIRST: ChatSessionSummary = {
  id: 'code-1',
  title: 'First',
  mode: 'code',
  project: PROJECT,
  messageCount: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
} as ChatSessionSummary;

const SECOND: ChatSessionSummary = { ...FIRST, id: 'code-2', title: 'Second' };
const FRESH: ChatSessionSummary = { ...FIRST, id: 'code-3', title: 'Fresh thread' };

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
let createCodeSession = vi.fn<(request?: unknown) => Promise<unknown>>();
let inspectProject = vi.fn<(directory: string) => Promise<unknown>>();

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
  // Opens on a Code session, so the sidebar draws the project group and its "+".
  window.localStorage.setItem('b4m.chat.lastSession', JSON.stringify({ id: FIRST.id, mode: 'code' }));
  createCodeSession = vi.fn(() => Promise.resolve({ ok: true, session: FRESH }));
  inspectProject = vi.fn(async () => ({
    directory: PROJECT.directory,
    name: PROJECT.name,
    isRepository: true,
    branches: ['main'],
    currentBranch: 'main',
  }));
  (window as unknown as { b4m: unknown }).b4m = new Proxy(
    {
      chat: quietBridge({
        listSessions: async () => [FIRST, SECOND],
        getSession: async (id: string) =>
          ({ ...(id === FRESH.id ? FRESH : FIRST), messages: [] }) as unknown as ChatSession,
        getQueuedMessages: async () => [],
        getSessionStatuses: async () => [],
        listModels: async () => ({ models: [] }),
        // The bridge's `[]` default is truthy, so the changes bar would render it as a reading.
        workspaceChanges: async () => null,
        inspectProject,
        createCodeSession,
      }),
      sidebar: quietBridge({ getSections: async () => ({ sections: [], assignments: {} }) }),
      getAppInfo: async () => ({ homeDirectory: '/home/user' }),
    },
    {
      get(target, name: string | symbol) {
        if (typeof name !== 'string') return undefined;
        return name in target ? target[name as 'chat' | 'sidebar'] : quietBridge({});
      },
    }
  );
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setWorktreeByDefault(false);
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

const el = (testId: string) => {
  const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`no ${testId}`);
  return found;
};

async function mount() {
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

async function clickNewInProject() {
  const before = inspectProject.mock.calls.length;
  await act(async () => el('project-new-btn').click());
  await act(async () => undefined);
  const creationOrder = createCodeSession.mock.invocationCallOrder.at(-1);
  if (creationOrder === undefined) throw new Error('No Code session was created.');
  // The new session's workspace setup also inspects its folder after creation. Only
  // inspections before createCodeSession can decide whether to request a worktree.
  return inspectProject.mock.invocationCallOrder.slice(before).filter(order => order < creationOrder).length;
}

describe("starting a new session from a project group's header", () => {
  it('starts it in a worktree when the user wants that by default', async () => {
    setWorktreeByDefault(true);
    await mount();

    expect(await clickNewInProject()).toBe(1);

    expect(inspectProject).toHaveBeenCalledWith(PROJECT.directory);
    expect(createCodeSession).toHaveBeenCalledWith({ directory: PROJECT.directory, workspace: true });
    expect(el('chat-session-title').textContent).toBe('Fresh thread');
  });

  it('creates without inspecting git or requesting a worktree when the preference is off', async () => {
    await mount();

    expect(await clickNewInProject()).toBe(0);

    expect(createCodeSession).toHaveBeenCalledWith({ directory: PROJECT.directory });
  });
});
