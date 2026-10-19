// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSession, ChatSessionSummary } from '@shared/chat';
import type { SidebarSectionsState } from '@shared/sidebarSections';
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

const OPEN: ChatSessionSummary = {
  id: 'open-1',
  title: 'Open thread',
  mode: 'chat',
  messageCount: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
} as ChatSessionSummary;

const FRESH: ChatSessionSummary = { ...OPEN, id: 'fresh-1', title: 'Fresh thread' };

const work: SidebarSectionsState = { sections: [{ id: 'work', name: 'Work' }], assignments: {} };
const placed: SidebarSectionsState = { ...work, assignments: { 'fresh-1': 'work' } };

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
let createSession = vi.fn<(request?: unknown) => Promise<unknown>>();

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
  createSession = vi.fn(() => Promise.resolve({ session: FRESH, sidebarSections: placed }));
  (window as unknown as { b4m: unknown }).b4m = new Proxy(
    {
      chat: quietBridge({
        listSessions: async () => [OPEN],
        getSession: async (id: string) =>
          ({ ...(id === FRESH.id ? FRESH : OPEN), messages: [] }) as unknown as ChatSession,
        getQueuedMessages: async () => [],
        getSessionStatuses: async () => [],
        listModels: async () => ({ models: [] }),
        createSession,
      }),
      sidebar: quietBridge({ getSections: async () => work }),
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
  vi.unstubAllGlobals();
});

const el = (testId: string) => {
  const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`no ${testId}`);
  return found;
};

/** What the sidebar draws inside one user section; throws when the section is not there. */
const inSection = (sectionId: string, testId: string) => {
  const found = document.querySelector<HTMLElement>(
    `[data-testid="sidebar-section"][data-section-id="${sectionId}"] [data-testid="${testId}"]`
  );
  if (!found) throw new Error(`no ${testId} in section ${sectionId}`);
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

describe("starting a new session from a section's header", () => {
  it('asks main for the section and opens the new row', async () => {
    await mount();

    await act(async () => el('sidebar-section-new-btn').click());
    await act(async () => undefined);

    expect(createSession).toHaveBeenCalledWith({ sectionId: 'work' });
    expect(el('chat-session-title').textContent).toBe('Fresh thread');
    expect(inSection('work', 'chat-session-title-text').textContent).toBe('Fresh thread');
  });

  it('says so when main could not save the placement', async () => {
    createSession.mockResolvedValue({ session: FRESH, placementFailed: true });
    await mount();

    await act(async () => el('sidebar-section-new-btn').click());
    await act(async () => undefined);

    expect(el('chat-section-error').textContent).toBe('Could not put the new session in its section.');
  });
});
