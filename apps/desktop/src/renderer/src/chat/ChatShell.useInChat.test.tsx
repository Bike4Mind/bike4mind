// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatModelOption, ChatSession, ChatSessionSummary } from '@shared/chat';
import { EMPTY_SIDEBAR_SECTIONS } from '@shared/sidebarSections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installedCache } from '../models/installedCache';
import type { ChatWith } from '../models/modelTarget';
import { desktopTheme } from '../theme';
import { ChatShell } from './ChatShell';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./CustomizePanel', () => ({ CustomizeNavItem: () => null, CustomizeScreen: () => null }));

let offered: ChatWith | undefined;
let shownError: string | null | undefined;
let closeModels: (() => void) | undefined;
vi.mock('../models/ModelsScreen', () => ({
  ModelsScreen: ({
    chatWith,
    chatError,
    onClose,
  }: {
    chatWith?: ChatWith;
    chatError?: string | null;
    onClose: () => void;
  }) => {
    offered = chatWith;
    shownError = chatError;
    closeModels = onClose;
    return <div data-testid="models-screen" />;
  },
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

window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const HOSTED = 'claude-opus-4-5-20251101';
const LOCAL_ID = 'local:ollama:qwen3.5:0.8b';
const LAB_ID = 'local:srv-lab:qwen3.5:0.8b';
const SLOW_ID = 'local:srv-slow:qwen3.5:0.8b';

// The hosted model of the same name sits ahead of the local one, so a match that ignored the backend would pick it.
const MODELS: ChatModelOption[] = [
  { id: HOSTED, name: 'Claude Opus 4.5', backend: 'anthropic' },
  { id: 'qwen/qwen3.5:0.8b', name: 'qwen3.5:0.8b', backend: 'openrouter' },
  { id: LOCAL_ID, name: 'qwen3.5:0.8b', backend: 'ollama', supportsTools: true },
  {
    id: 'local:srv-gpu:qwen3.5:0.8b',
    name: 'qwen3.5:0.8b',
    backend: 'local-srv-gpu',
    server: { id: 'gpu', name: 'GPU box' },
    unavailable: 'GPU box is not answering.',
  },
  { id: LAB_ID, name: 'qwen3.5:0.8b', backend: 'local-srv-lab', server: { id: 'lab', name: 'Lab box' } },
  {
    id: SLOW_ID,
    name: 'qwen3.5:0.8b',
    backend: 'local-srv-slow',
    server: { id: 'slow', name: 'Slow box' },
    unavailable: 'Slow box is still listing its models',
    pending: true,
  },
];

const summary = (id: string, model: string): ChatSessionSummary =>
  ({
    id,
    title: 'New conversation',
    mode: 'chat',
    model,
    messageCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
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

let root: Root | null = null;
let host: HTMLElement | null = null;
const createSession = vi.fn(async () => ({ session: summary('fresh-1', HOSTED) }));
const setSessionModel = vi.fn(async (id: string, model: string) => ({ ...summary(id, model), messages: [] }));
const deleteSession = vi.fn(async () => undefined);

function stubBridge() {
  (window as unknown as { b4m: unknown }).b4m = new Proxy(
    {
      chat: quietBridge({
        listSessions: async () => [summary('old-1', HOSTED)],
        getSession: async (id: string) => ({ ...summary(id, HOSTED), messages: [] }) as ChatSession,
        getQueuedMessages: async () => [],
        getSessionStatuses: async () => [],
        listModels: async () => ({ models: MODELS }),
        listArtifacts: async () => ({ artifacts: [], total: 0 }),
        createSession,
        setSessionModel,
        deleteSession,
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
}

beforeEach(() => {
  installedCache.clear();
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
  offered = undefined;
  shownError = undefined;
  closeModels = undefined;
  createSession.mockClear();
  setSessionModel.mockClear();
  deleteSession.mockClear();
  stubBridge();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

async function openModels() {
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
  await act(async () => document.querySelector<HTMLElement>('[data-testid="chat-models-btn"]')?.click());
  await act(async () => undefined);
}

describe('Use in chat', () => {
  it('starts a new Chat conversation on the installed model of the server the screen shows', async () => {
    await openModels();
    expect(document.querySelector('[data-testid="models-screen"]')).not.toBeNull();
    expect(offered?.('local', 'nomic-embed-text:latest')).toBeNull();

    const use = offered?.('local', 'Qwen3.5:0.8B');
    expect(use).toBeTypeOf('function');
    await act(async () => use?.());
    await act(async () => undefined);

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(setSessionModel).toHaveBeenCalledWith('fresh-1', LOCAL_ID);
    expect(document.querySelector('[data-testid="models-screen"]')).toBeNull();
  });

  it('routes a saved server model to that server, and offers nothing for a server that is down', async () => {
    await openModels();
    expect(offered?.('gpu', 'qwen3.5:0.8b')).toBeNull();
    await act(async () => offered?.('lab', 'qwen3.5:0.8b')?.());
    expect(setSessionModel).toHaveBeenCalledWith('fresh-1', LAB_ID);
  });

  it('offers a model on a server that is still listing its models', async () => {
    await openModels();
    await act(async () => offered?.('slow', 'qwen3.5:0.8b')?.());
    expect(setSessionModel).toHaveBeenCalledWith('fresh-1', SLOW_ID);
  });

  it('starts one conversation for a double click', async () => {
    await openModels();
    const use = offered?.('local', 'qwen3.5:0.8b');
    await act(async () => {
      use?.();
      use?.();
    });
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('stays on Models with an error, and removes the new conversation, when the model cannot be set', async () => {
    setSessionModel.mockResolvedValueOnce(null as never);
    await openModels();
    await act(async () => offered?.('local', 'qwen3.5:0.8b')?.());
    await act(async () => undefined);
    expect(deleteSession).toHaveBeenCalledWith('fresh-1', false);
    expect(document.querySelector('[data-testid="models-screen"]')).not.toBeNull();
    expect(shownError).toContain('could not start a conversation on that model');

    createSession.mockRejectedValueOnce(new Error('disk full'));
    await act(async () => offered?.('local', 'qwen3.5:0.8b')?.());
    await act(async () => undefined);
    expect(shownError).toContain('disk full');
    expect(document.querySelector('[data-testid="models-screen"]')).not.toBeNull();
  });

  it('says the empty conversation is left behind when removing it fails too', async () => {
    setSessionModel.mockResolvedValueOnce(null as never);
    deleteSession.mockRejectedValueOnce(new Error('locked'));
    await openModels();
    await act(async () => offered?.('local', 'qwen3.5:0.8b')?.());
    await act(async () => undefined);
    expect(deleteSession).toHaveBeenCalledWith('fresh-1', false);
    expect(shownError).toContain('could not remove the empty one');
  });

  it('drops the error when Models is closed, so reopening it does not show a stale one', async () => {
    setSessionModel.mockResolvedValueOnce(null as never);
    await openModels();
    await act(async () => offered?.('local', 'qwen3.5:0.8b')?.());
    await act(async () => undefined);
    expect(shownError).toContain('could not start a conversation on that model');

    await act(async () => closeModels?.());
    await act(async () => document.querySelector<HTMLElement>('[data-testid="chat-models-btn"]')?.click());
    await act(async () => undefined);
    expect(document.querySelector('[data-testid="models-screen"]')).not.toBeNull();
    expect(shownError).toBeNull();
  });
});
