// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatModelOption, ChatSession, ChatSessionSummary } from '@shared/chat';
import type { ModelSettings } from '@shared/modelSettings';
import { EMPTY_SIDEBAR_SECTIONS } from '@shared/sidebarSections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ChatShell } from './ChatShell';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./CustomizePanel', () => ({ CustomizeNavItem: () => null, CustomizeScreen: () => null }));

let closeModels: (() => void) | undefined;
vi.mock('../models/ModelsScreen', () => ({
  ModelsScreen: ({ onClose }: { onClose: () => void }) => {
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

const QWEN = 'local:ollama:qwen3.5:0.8b';
const GEMMA = 'local:ollama:gemma4:12b-it-qat';

const local = (id: string, name: string): ChatModelOption => ({
  id,
  name,
  backend: 'ollama',
  controls: { effort: { levels: ['low', 'medium', 'high'], scope: 'request' } },
});
const MODELS = [local(QWEN, 'qwen3.5:0.8b'), local(GEMMA, 'gemma4:12b-it-qat')];

const summary = (id: string, title: string, model: string, updatedAt: string): ChatSessionSummary =>
  ({
    id,
    title,
    mode: 'chat',
    model,
    messageCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt,
  }) as ChatSessionSummary;
const SESSIONS = [
  summary('s-qwen', 'Qwen chat', QWEN, '2026-10-01T00:00:02.000Z'),
  summary('s-gemma', 'Gemma chat', GEMMA, '2026-10-01T00:00:01.000Z'),
  summary('s-qwen-notes', 'Qwen notes', QWEN, '2026-10-01T00:00:00.000Z'),
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
const getModelSettings = vi.fn<(id: string) => Promise<ModelSettings | null>>();

function stubBridge() {
  (window as unknown as { b4m: unknown }).b4m = new Proxy(
    {
      chat: quietBridge({
        listSessions: async () => SESSIONS,
        getSession: async (id: string) =>
          ({ ...SESSIONS.find(session => session.id === id), messages: [] }) as ChatSession,
        getQueuedMessages: async () => [],
        getSessionStatuses: async () => [],
        listModels: async () => ({ models: MODELS }),
        listArtifacts: async () => ({ artifacts: [], total: 0 }),
        getModelSettings,
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
  closeModels = undefined;
  window.localStorage.clear();
  getModelSettings.mockReset();
  stubBridge();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

async function openShell() {
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
}

async function openSession(title: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[data-testid="chat-session-item"]')].find(row =>
    row.textContent?.includes(title)
  );
  await act(async () => item?.click());
  await act(async () => undefined);
}

async function defaultLabel(): Promise<string | undefined> {
  // Effort at its default sits in the composer's tune tray, which stays open once opened.
  if (!document.querySelector('[data-testid="effort-picker-btn"]')) {
    await act(async () => document.querySelector<HTMLElement>('[data-testid="composer-tune-btn"]')?.click());
  }
  await act(async () => document.querySelector<HTMLElement>('[data-testid="effort-picker-btn"]')?.click());
  const label = [...document.querySelectorAll('[data-testid="effort-picker-option"]')]
    .map(option => option.textContent ?? '')
    .find(text => text.includes('Default'));
  await act(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  return label?.match(/Default(?: \(\w+\))?/)?.[0];
}

describe('the effort default shown for the conversation model', () => {
  it('re-reads the default on returning from the Models screen', async () => {
    getModelSettings.mockResolvedValue({ effort: 'low' });
    await openShell();
    await openSession('Qwen chat');
    expect(getModelSettings).toHaveBeenCalledWith(QWEN);
    expect(await defaultLabel()).toBe('Default (Low)');

    await act(async () => document.querySelector<HTMLElement>('[data-testid="chat-models-btn"]')?.click());
    getModelSettings.mockResolvedValue({ effort: 'high' });
    await act(async () => closeModels?.());
    await act(async () => undefined);
    expect(getModelSettings).toHaveBeenCalledTimes(2);
    expect(await defaultLabel()).toBe('Default (High)');
  });

  it('drops a late answer for the model the conversation has left', async () => {
    let answerQwen: (settings: ModelSettings) => void = () => undefined;
    getModelSettings.mockImplementation(id =>
      id === QWEN
        ? new Promise<ModelSettings>(resolve => {
            answerQwen = resolve;
          })
        : Promise.resolve({ effort: 'high' })
    );
    await openShell();
    await openSession('Qwen chat');
    await openSession('Gemma chat');
    expect(await defaultLabel()).toBe('Default (High)');

    await act(async () => answerQwen({ effort: 'low' }));
    expect(await defaultLabel()).toBe('Default (High)');
  });

  it('shows no default for a model whose answer is still pending, not the previous model default', async () => {
    getModelSettings.mockImplementation(id =>
      id === QWEN ? Promise.resolve({ effort: 'low' }) : new Promise<ModelSettings>(() => undefined)
    );
    await openShell();
    await openSession('Qwen chat');
    expect(await defaultLabel()).toBe('Default (Low)');

    await openSession('Gemma chat');
    expect(await defaultLabel()).toBe('Default');
  });
});

describe('a failed read of the model defaults', () => {
  const readError = () => document.querySelector('[data-testid="chat-model-defaults-error"]')?.textContent ?? null;

  async function roundTripModels() {
    await act(async () => document.querySelector<HTMLElement>('[data-testid="chat-models-btn"]')?.click());
    await act(async () => closeModels?.());
    await act(async () => undefined);
  }

  it('says so in the chat when the first read fails, and not in another chat', async () => {
    getModelSettings.mockImplementation(id =>
      id === QWEN ? Promise.reject(new Error('store unreadable')) : Promise.resolve({ effort: 'high' })
    );
    await openShell();
    await openSession('Qwen chat');
    expect(readError()).toContain('built-in ones');
    expect(readError()).toContain('store unreadable');
    expect(await defaultLabel()).toBe('Default');

    await openSession('Gemma chat');
    expect(readError()).toBeNull();
    expect(await defaultLabel()).toBe('Default (High)');
  });

  it('keeps a failure that lands after the chat was left out of the chat now open', async () => {
    let failQwen: ((error: Error) => void) | undefined;
    getModelSettings.mockImplementation(id => {
      if (id !== QWEN) return Promise.resolve({ effort: 'high' });
      if (failQwen) return Promise.reject(new Error('store unreadable'));
      return new Promise<ModelSettings>((_resolve, reject) => {
        failQwen = reject;
      });
    });
    await openShell();
    await openSession('Qwen chat');
    await openSession('Gemma chat');
    await act(async () => failQwen?.(new Error('store unreadable')));
    expect(readError()).toBeNull();
    expect(await defaultLabel()).toBe('Default (High)');

    await openSession('Qwen chat');
    expect(readError()).toContain('store unreadable');
  });

  it('keeps the last good defaults and says they may be stale when a later read fails', async () => {
    getModelSettings.mockResolvedValue({ effort: 'low' });
    await openShell();
    await openSession('Qwen chat');
    expect(readError()).toBeNull();

    getModelSettings.mockRejectedValue(new Error('store unreadable'));
    await roundTripModels();
    expect(getModelSettings).toHaveBeenCalledTimes(2);
    expect(readError()).toContain('last ones it read');
    expect(await defaultLabel()).toBe('Default (Low)');
  });

  it('clears the notice once a later read succeeds', async () => {
    getModelSettings.mockRejectedValue(new Error('store unreadable'));
    await openShell();
    await openSession('Qwen chat');
    expect(readError()).toContain('built-in ones');

    getModelSettings.mockResolvedValue({ effort: 'high' });
    await roundTripModels();
    expect(readError()).toBeNull();
    expect(await defaultLabel()).toBe('Default (High)');
  });

  it('drops a stored failure for a model once another chat reads it fine, and keeps one for another model', async () => {
    const pending = () => new Promise<ModelSettings>(() => undefined);
    const reads = { qwen: 0, gemma: 0 };
    getModelSettings.mockImplementation(id => {
      if (id === GEMMA) return ++reads.gemma === 1 ? Promise.reject(new Error('gemma unreadable')) : pending();
      if (++reads.qwen === 1) return Promise.reject(new Error('store unreadable'));
      return reads.qwen === 2 ? Promise.resolve({ effort: 'high' }) : pending();
    });
    await openShell();
    await openSession('Qwen chat');
    expect(readError()).toContain('store unreadable');
    await openSession('Gemma chat');
    expect(readError()).toContain('gemma unreadable');
    await openSession('Qwen notes');
    expect(readError()).toBeNull();

    await openSession('Qwen chat');
    expect(readError()).toBeNull();
    await openSession('Gemma chat');
    expect(readError()).toContain('gemma unreadable');
  });
});
