// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSessionSummary } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ChatShell } from './ChatShell';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('./CustomizePanel', () => ({ CustomizeNavItem: () => null, CustomizeScreen: () => null }));
window.matchMedia ??= ((media: string) => ({
  matches: false,
  media,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const summary = (id: string): ChatSessionSummary => ({
  id,
  title: id,
  mode: 'chat',
  model: 'test',
  approvalMode: 'ask',
  reasoningEffort: 'default',
  messageCount: 0,
  createdAt: '2026-10-01',
  updatedAt: '2026-10-01',
});
const createSession = vi.fn();
const pickProjectDirectory = vi.fn();
const addContextDirectory = vi.fn();
let root: Root;
let host: HTMLDivElement;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
const chips = () =>
  [...document.querySelectorAll('[data-testid="session-chip-context"]')].map(chip => chip.textContent);
const bridge = (values: Record<string, unknown>): object =>
  new Proxy(values, {
    get: (target, name: string) =>
      name in target ? target[name] : name.startsWith('on') ? () => () => undefined : async () => [],
  });

beforeEach(() => {
  vi.clearAllMocks();
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
  pickProjectDirectory.mockResolvedValue('/notes');
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

async function mount(sessions: ChatSessionSummary[] = [], strict = false) {
  Object.assign(window, {
    b4m: new Proxy(
      {
        chat: bridge({
          listSessions: async () => sessions,
          getSession: async (id: string) => ({ ...summary(id), messages: [] }),
          listModels: async () => ({ models: [] }),
          getSessionStatuses: async () => [],
          getQueuedMessages: async () => [],
          createSession,
          pickProjectDirectory,
          addContextDirectory,
        }),
        sidebar: bridge({ getSections: async () => ({ sections: [], assignments: {} }) }),
        getAppInfo: async () => ({ homeDirectory: '/home/test' }),
      },
      { get: (target, name: string) => (name in target ? target[name as keyof typeof target] : bridge({})) }
    ),
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const shell = (
    <CssVarsProvider theme={desktopTheme}>
      <ChatShell />
    </CssVarsProvider>
  );
  await act(async () => root.render(strict ? <StrictMode>{shell}</StrictMode> : shell));
}
async function addFolder() {
  await act(async () => el('composer-plus-btn')?.click());
  await act(async () => el('composer-add-folder-item')?.click());
}

describe('Add folder before the first send', () => {
  it('seeds a usable draft and shares locally without creating a sidebar row', async () => {
    await mount();
    expect(el<HTMLTextAreaElement>('chat-composer-input')?.disabled).toBe(false);
    await addFolder();
    expect(chips()).toEqual(['/notes']);
    expect(createSession).not.toHaveBeenCalled();
    expect(addContextDirectory).not.toHaveBeenCalled();
    expect(el('chat-session-item')).toBeNull();
    expect(window.localStorage.getItem('b4m.chat.lastSession')).toBeNull();
    await act(async () => el('session-chip-context')?.querySelector('button')?.click());
    expect(chips()).toEqual([]);
  });

  it('creates nothing when the picker is cancelled, including under StrictMode', async () => {
    pickProjectDirectory.mockResolvedValue(null);
    await mount([], true);
    await addFolder();
    expect(chips()).toEqual([]);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('discards the draft folder when navigating to another conversation', async () => {
    await mount([summary('existing')]);
    await act(async () => el('chat-new-session-btn')?.click());
    await addFolder();
    expect(chips()).toEqual(['/notes']);
    await act(async () => el('chat-session-item')?.click());
    expect(chips()).toEqual([]);
    await act(async () => el('chat-new-session-btn')?.click());
    expect(chips()).toEqual([]);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('drops a picker result that arrives after navigation', async () => {
    let resolve!: (path: string) => void;
    pickProjectDirectory.mockReturnValue(
      new Promise<string>(done => {
        resolve = done;
      })
    );
    await mount([summary('existing')]);
    await act(async () => el('chat-new-session-btn')?.click());
    await addFolder();
    await act(async () => el('chat-session-item')?.click());
    await act(async () => resolve('/notes'));
    expect(chips()).toEqual([]);
    expect(addContextDirectory).not.toHaveBeenCalled();
  });

  it('still shares into an existing conversation through main', async () => {
    addContextDirectory.mockResolvedValue({
      status: 'added',
      path: '/notes',
      session: { ...summary('existing'), grantedDirectories: ['/notes'] },
    });
    await mount([summary('existing')]);
    await addFolder();
    expect(addContextDirectory).toHaveBeenCalledWith('existing', undefined);
    expect(chips()).toEqual(['/notes']);
  });

  it('reports a persisted-chat sharing failure in that conversation', async () => {
    addContextDirectory.mockRejectedValue(new Error('share unavailable'));
    await mount([summary('existing')]);
    await addFolder();
    expect(el('chat-add-folder-error')?.textContent).toContain('share unavailable');
  });
});
