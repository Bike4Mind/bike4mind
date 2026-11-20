// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSession, ChatSessionSummary } from '@shared/chat';
import { EMPTY_SIDEBAR_SECTIONS } from '@shared/sidebarSections';
import type { WorktreeRemoval } from '@shared/worktreeRemoval';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ChatShell } from './ChatShell';
import { clearLastSession } from './lastSession';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./CustomizePanel', () => ({ CustomizeNavItem: () => null, CustomizeScreen: () => null }));

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

const active: ChatSessionSummary = {
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
const safe: WorktreeRemoval = {
  path: '/repo/.b4m/worktrees/test',
  branch: 'b4m/test',
  safe: true,
  reason: null,
};

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
const deleteSession = vi.fn<(sessionId: string, removeWorktree: boolean) => Promise<void>>();
const inspectWorktreeRemoval = vi.fn<(sessionId: string) => Promise<WorktreeRemoval | null>>();

beforeEach(() => {
  deleteSession.mockReset();
  deleteSession.mockResolvedValue(undefined);
  inspectWorktreeRemoval.mockReset();
  inspectWorktreeRemoval.mockResolvedValue(safe);
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
      chat: quietBridge({
        listSessions: async () => [active],
        getSession: async (): Promise<ChatSession> => ({ ...active, messages: [] }),
        getQueuedMessages: async () => [],
        getSessionStatuses: async () => [],
        listModels: async () => ({ models: [] }),
        inspectWorktreeRemoval,
        deleteSession,
      }),
      sidebar: quietBridge({ getSections: async () => EMPTY_SIDEBAR_SECTIONS }),
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
const element = (testId: string) => {
  const found = query(testId);
  if (!found) throw new Error(`Missing ${testId}`);
  return found;
};
const checkbox = () => {
  const input = element('delete-session-worktree-checkbox').querySelector('input');
  if (!input) throw new Error('Missing cleanup checkbox input');
  return input;
};

async function openDeleteDialog() {
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
  await act(async () => element('chat-session-item').click());
  expect(element('chat-session-title').textContent).toBe(active.title);
  await act(async () => element('chat-session-menu-btn').click());
  await act(async () => element('chat-delete-session-btn').click());
  expect(inspectWorktreeRemoval).toHaveBeenCalledExactlyOnceWith(active.id);
  expect(element('delete-session-dialog')).toBeTruthy();
  expect(deleteSession).not.toHaveBeenCalled();
}

function expectSessionPreserved() {
  expect(element('chat-session-title-text').textContent).toBe(active.title);
  expect(element('chat-session-title').textContent).toBe(active.title);
}

function expectSessionDeleted() {
  expect(query('chat-session-item')).toBeNull();
  expect(query('chat-session-title')).toBeNull();
  expect(query('delete-session-dialog')).toBeNull();
}

describe('deleting the open session from the sidebar', () => {
  it('forwards the default safe cleanup choice through the real sessions owner', async () => {
    await openDeleteDialog();
    expect(checkbox().checked).toBe(true);
    await act(async () => element('delete-session-confirm-btn').click());
    expect(deleteSession).toHaveBeenCalledExactlyOnceWith(active.id, true);
    expectSessionDeleted();
  });

  it('forwards an unchecked cleanup choice', async () => {
    await openDeleteDialog();
    await act(async () => checkbox().click());
    expect(checkbox().checked).toBe(false);
    await act(async () => element('delete-session-confirm-btn').click());
    expect(deleteSession).toHaveBeenCalledExactlyOnceWith(active.id, false);
    expectSessionDeleted();
  });

  it('cancels without calling the delete bridge or changing the open session', async () => {
    await openDeleteDialog();
    await act(async () => element('delete-session-cancel-btn').click());
    expect(deleteSession).not.toHaveBeenCalled();
    expect(query('delete-session-dialog')).toBeNull();
    expectSessionPreserved();
  });

  it('preserves the row and open conversation on refusal, then retries without cleanup', async () => {
    deleteSession.mockRejectedValueOnce(new Error('Worktree is locked'));
    await openDeleteDialog();
    await act(async () => element('delete-session-confirm-btn').click());
    expect(deleteSession).toHaveBeenNthCalledWith(1, active.id, true);
    expectSessionPreserved();
    expect(element('delete-session-error').textContent).toContain('Worktree is locked');
    expect(checkbox().checked).toBe(false);
    await act(async () => element('delete-session-confirm-btn').click());
    expect(deleteSession).toHaveBeenCalledTimes(2);
    expect(deleteSession).toHaveBeenNthCalledWith(2, active.id, false);
    expectSessionDeleted();
  });
});
