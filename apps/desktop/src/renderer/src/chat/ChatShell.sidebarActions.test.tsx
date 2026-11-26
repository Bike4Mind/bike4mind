// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSession, ChatSessionSummary } from '@shared/chat';
import type { SidebarSectionsState } from '@shared/sidebarSections';
import type { SessionWorktreeRemoval } from '@shared/worktreeRemoval';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ChatShell } from './ChatShell';
import { clearLastSession } from './lastSession';
import { chatBackedHostBridge } from '../__fixtures__/chatBackedHostBridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./CustomizePanel', () => ({ CustomizeScreen: () => null, useCustomizeAttention: () => undefined }));
// Only its send matters here, and its pickers and menus are a good share of every render.
vi.mock('./Composer', () => ({
  Composer: ({ onSend }: { onSend: (text: string) => void }) => (
    <button data-testid="test-send" onClick={() => onSend('First prompt')}>
      Send
    </button>
  ),
}));
// The 3D engine's iframe would make jsdom boot a whole extra window on every mount.
vi.mock('./model3d/modelEngineFrame', async importOriginal => ({
  ...(await importOriginal<typeof import('./model3d/modelEngineFrame')>()),
  ModelEngineFrame: class {
    warm() {
      return this;
    }
    dispose() {}
    async build() {
      return null;
    }
  },
}));

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
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

const OPEN: ChatSessionSummary = {
  id: 'open-1',
  title: 'Open thread',
  model: 'test-model',
  mode: 'chat',
  approvalMode: 'ask',
  reasoningEffort: 'medium',
  messageCount: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const FRESH: ChatSessionSummary = { ...OPEN, id: 'fresh-1', title: 'Fresh thread' };

const work: SidebarSectionsState = { sections: [{ id: 'work', name: 'Work' }], assignments: {} };
const placed: SidebarSectionsState = { ...work, assignments: { 'fresh-1': 'work' } };

const safe: SessionWorktreeRemoval = {
  path: '/repo/.b4m/worktrees/test',
  branch: 'b4m/test',
  safe: true,
  removable: true,
  reason: null,
};

/**
 * Everything ChatShell reaches over IPC that this test does not care about: subscriptions hand
 * back an unsubscribe, and every call resolves to an empty list.
 */
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
let resolveRename: (value: ChatSessionSummary | null) => void = () => {};
let createSession = vi.fn<(request?: unknown) => Promise<unknown>>();
const deleteSession = vi.fn<(sessionId: string, removeWorktree: boolean) => Promise<void>>();
const inspectWorktreeRemoval = vi.fn<(sessionId: string) => Promise<SessionWorktreeRemoval | null>>();

beforeEach(() => {
  deleteSession.mockReset();
  deleteSession.mockResolvedValue(undefined);
  inspectWorktreeRemoval.mockReset();
  inspectWorktreeRemoval.mockResolvedValue(safe);
  createSession = vi.fn(() => Promise.resolve({ session: FRESH, sidebarSections: placed }));
  clearLastSession();
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
  (window as unknown as { b4m: unknown }).b4m = new Proxy(
    {
      host: chatBackedHostBridge(),
      chat: quietBridge({
        defaultsForNewSession: async () => ({ model: 'test-model', approvalMode: 'auto', reasoningEffort: 'default' }),
        listSessions: async () => (createSession.mock.calls.length ? [FRESH, OPEN] : [OPEN]),
        getSession: async (id: string) =>
          ({ ...(id === FRESH.id ? FRESH : OPEN), messages: [] }) as unknown as ChatSession,
        getQueuedMessages: async () => [],
        getSessionStatuses: async () => [],
        listModels: async () => ({ models: [] }),
        createSession,
        sendMessage: async () => ({ ok: true, messageId: 'first' }),
        renameSession: (_id: string, _title: string) =>
          new Promise<ChatSessionSummary | null>(resolve => (resolveRename = resolve)),
        inspectWorktreeRemoval,
        deleteSession,
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
  clearLastSession();
  vi.unstubAllGlobals();
});

const query = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const el = (testId: string) => {
  const found = query(testId);
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

async function openSession() {
  await mount();
  await act(async () => el('chat-session-item').click());
  await act(async () => undefined);
  expect(el('chat-session-title').textContent).toBe(OPEN.title);
}

describe('renaming the open session from the sidebar', () => {
  it('updates the conversation header as well as the row, and the header rename claims Escape', async () => {
    await openSession();

    act(() => {
      el('chat-session-title-text').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    const input = el('chat-session-rename-input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, 'Renamed thread');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    // Before main answers: the header shows the optimistic title.
    expect(el('chat-session-title').textContent).toBe('Renamed thread');

    // A refusal rolls the header back with the row.
    await act(async () => resolveRename(null));
    expect(el('chat-session-title').textContent).toBe('Open thread');
    expect(el('chat-session-title-text').textContent).toBe('Open thread');

    // Cancelling the header rename claims Escape, so the orchestrator dock does not also hide.
    act(() => el('chat-session-title').click());
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      el('chat-rename-input').dispatchEvent(escape);
    });
    expect(escape.defaultPrevented).toBe(true);
    expect(el('chat-session-title').textContent).toBe('Open thread');
  });
});

// The dialog's own choices (default, unchecked, cancel, unsafe) are DeleteSessionDialog.test.tsx's;
// here only the wiring through the real sessions owner.
describe('deleting the open session from the sidebar', () => {
  async function openDeleteDialog() {
    await openSession();
    await act(async () => el('chat-session-menu-btn').click());
    await act(async () => el('chat-delete-session-btn').click());
    expect(inspectWorktreeRemoval).toHaveBeenCalledExactlyOnceWith(OPEN.id);
    expect(el('delete-session-dialog')).toBeTruthy();
    expect(deleteSession).not.toHaveBeenCalled();
  }

  function expectSessionDeleted() {
    expect(query('chat-session-item')).toBeNull();
    expect(query('chat-session-title')).toBeNull();
    expect(query('delete-session-dialog')).toBeNull();
  }

  it('forwards the default safe cleanup choice through the real sessions owner', async () => {
    await openDeleteDialog();
    await act(async () => el('delete-session-confirm-btn').click());
    expect(deleteSession).toHaveBeenCalledExactlyOnceWith(OPEN.id, true);
    expectSessionDeleted();
  });

  it('preserves the row and open conversation on refusal, then retries without cleanup', async () => {
    deleteSession.mockRejectedValueOnce(new Error('Worktree is locked'));
    await openDeleteDialog();
    await act(async () => el('delete-session-confirm-btn').click());
    expect(deleteSession).toHaveBeenNthCalledWith(1, OPEN.id, true);
    expect(el('chat-session-title-text').textContent).toBe(OPEN.title);
    expect(el('chat-session-title').textContent).toBe(OPEN.title);
    expect(el('delete-session-error').textContent).toContain('Worktree is locked');
    await act(async () => el('delete-session-confirm-btn').click());
    expect(deleteSession).toHaveBeenCalledTimes(2);
    expect(deleteSession).toHaveBeenNthCalledWith(2, OPEN.id, false);
    expectSessionDeleted();
  });
});

describe("starting a new session from a section's header", () => {
  it('keeps the section draft out of the sidebar until the first send', async () => {
    await mount();

    await act(async () => el('sidebar-section-new-btn').click());
    await act(async () => undefined);

    expect(createSession).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="chat-session-title-text"]')?.textContent).not.toBe('Fresh thread');
    await act(async () => el('test-send').click());
    expect(createSession).toHaveBeenCalledWith({ sectionId: 'work' });
    expect(el('chat-session-title').textContent).toBe('Fresh thread');
    expect(inSection('work', 'chat-session-title-text').textContent).toBe('Fresh thread');
  });

  it('says so when main could not save the placement', async () => {
    createSession.mockResolvedValue({ session: FRESH, placementFailed: true });
    await mount();

    await act(async () => el('sidebar-section-new-btn').click());
    await act(async () => undefined);
    expect(createSession).not.toHaveBeenCalled();
    await act(async () => el('test-send').click());

    expect(el('chat-section-error').textContent).toBe('Could not put the new session in its section.');
  });
});
