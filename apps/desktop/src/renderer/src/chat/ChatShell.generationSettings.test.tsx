// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatModelOption, ChatSession, ChatSessionSummary } from '@shared/chat';
import type { GenerationSettings } from '@shared/generation';
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

const MODEL: ChatModelOption = {
  id: 'local:ollama:qwen3:8b',
  name: 'qwen3:8b',
  backend: 'ollama',
  controls: {
    temperature: { min: 0, max: 2, step: 0.05, default: 0.6, scope: 'request' },
    topK: { min: 0, max: 200, step: 1, default: 20, scope: 'request' },
  },
};

const summary = (id: string, title: string, updatedAt: string): ChatSessionSummary =>
  ({ id, title, mode: 'chat', messageCount: 0, createdAt: updatedAt, updatedAt }) as ChatSessionSummary;

const SESSIONS = [
  summary('first', 'First', '2026-10-02T00:00:00.000Z'),
  summary('second', 'Second', '2026-10-01T00:00:00.000Z'),
];
const setSessionGeneration = vi.fn<(id: string, generation: GenerationSettings) => Promise<ChatSessionSummary>>();

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

beforeEach(() => {
  window.localStorage.clear();
  setSessionGeneration.mockReset();
  setSessionGeneration.mockImplementation(async (id, generation) => ({
    ...(SESSIONS.find(entry => entry.id === id) as ChatSessionSummary),
    generation,
  }));
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
      getAppInfo: async () => ({ homeDirectory: '/home/test' }),
      chat: quietBridge({
        listSessions: async () => SESSIONS,
        getSession: async (id: string) =>
          ({ ...SESSIONS.find(entry => entry.id === id), model: MODEL.id, messages: [] }) as unknown as ChatSession,
        setSessionGeneration,
        getQueuedMessages: async () => [],
        getSessionStatuses: async () => [],
        listModels: async () => ({ models: [MODEL] }),
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
  vi.unstubAllGlobals();
});

const find = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const el = (testId: string) => {
  const found = find(testId);
  if (!found) throw new Error(`no ${testId}`);
  return found;
};

async function renderShell() {
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
  await act(async () => el('chat-session-item').click());
  await act(async () => undefined);
}

async function fill(field: string, text: string) {
  const input = el(`generation-settings-${field}-input`) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(target: Element, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  });
  await act(async () => undefined);
}

async function openParams() {
  // Params at its default sits in the composer's tune tray, which stays open once opened.
  if (!find('generation-settings-btn')) await act(async () => el('composer-tune-btn').click());
  await act(async () => el('generation-settings-btn').click());
}

describe('Params across a chat switch', () => {
  it('closes on Mod+2 from inside the dialog and saves nothing typed in the old chat', async () => {
    await renderShell();
    expect(el('chat-session-title').textContent).toBe('First');
    await openParams();
    await fill('temperature', '0.5');
    const temperature = el('generation-settings-temperature-input');
    await press(temperature, { key: '2', code: 'Digit2', ctrlKey: true });
    expect(el('chat-session-title').textContent).toBe('Second');
    expect(find('generation-settings-menu')).toBeNull();
    await act(async () => temperature.blur());
    expect(setSessionGeneration).not.toHaveBeenCalled();

    await openParams();
    expect((el('generation-settings-temperature-input') as HTMLInputElement).value).toBe('');
    await fill('topK', '30');
    await press(el('generation-settings-topK-input'), { key: 'Enter' });
    expect(setSessionGeneration).toHaveBeenCalledExactlyOnceWith('second', { topK: 30 });
  });

  it('does not carry a save still on its way in the old chat into the next one', async () => {
    setSessionGeneration.mockImplementationOnce(() => new Promise<ChatSessionSummary>(() => {}));
    await renderShell();
    await openParams();
    await fill('temperature', '0.5');
    const temperature = el('generation-settings-temperature-input');
    await press(temperature, { key: 'Enter' });
    expect(setSessionGeneration).toHaveBeenLastCalledWith('first', { temperature: 0.5 });

    await press(temperature, { key: '2', code: 'Digit2', ctrlKey: true });
    expect(el('chat-session-title').textContent).toBe('Second');
    await openParams();
    await fill('topK', '30');
    await press(el('generation-settings-topK-input'), { key: 'Enter' });
    expect(setSessionGeneration).toHaveBeenLastCalledWith('second', { topK: 30 });
  });
});

describe('Composer chat settings across a chat switch', () => {
  const OPUS: ChatModelOption = {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    supportsReasoningEffort: true,
    supportsOneHourCache: true,
    controls: {
      effort: { levels: ['low', 'high'], scope: 'request' },
      temperature: { min: 0, max: 1, step: 0.05, default: 1, scope: 'request' },
    },
  };
  const CONTROLS = [
    'approval-mode-btn',
    'model-picker-btn',
    'effort-picker-btn',
    'generation-settings-btn',
    'prompt-cache-ttl-picker-btn',
  ];
  const disabled = (testId: string) => (el(testId) as HTMLButtonElement).disabled;

  it("stay disabled while they still show the previous chat's settings", async () => {
    let answerSecond: () => void = () => {};
    const chat = window.b4m.chat as unknown as Record<string, unknown>;
    chat.listModels = async () => ({ models: [MODEL, OPUS] });
    chat.getSession = (id: string) => {
      const read = { ...SESSIONS.find(entry => entry.id === id), messages: [] };
      if (id === 'first') return Promise.resolve({ ...read, model: OPUS.id } as unknown as ChatSession);
      return new Promise<ChatSession>(
        resolve => (answerSecond = () => resolve({ ...read, model: OPUS.id } as unknown as ChatSession))
      );
    };
    await renderShell();
    await act(async () => el('composer-tune-btn').click());
    for (const testId of CONTROLS) expect(disabled(testId), testId).toBe(false);

    await act(async () => document.querySelectorAll<HTMLElement>('[data-testid="chat-session-item"]')[1].click());
    expect(find('chat-thread-opening')).not.toBeNull();
    for (const testId of CONTROLS) expect(disabled(testId), testId).toBe(true);

    await act(async () => answerSecond());
    expect(el('chat-session-title').textContent).toBe('Second');
    for (const testId of CONTROLS) expect(disabled(testId), testId).toBe(false);
  });

  it('stay disabled, and the composer cannot send, when the chat being opened fails to read', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const chat = window.b4m.chat as unknown as Record<string, unknown>;
    chat.sendMessage = sendMessage;
    chat.listModels = async () => ({ models: [MODEL, OPUS] });
    chat.getSession = async (id: string) => {
      if (id === 'second') throw new Error('database locked');
      return { ...SESSIONS.find(entry => entry.id === id), model: OPUS.id, messages: [] } as unknown as ChatSession;
    };
    await renderShell();
    await act(async () => el('composer-tune-btn').click());
    await act(async () => document.querySelectorAll<HTMLElement>('[data-testid="chat-session-item"]')[1].click());
    await act(async () => undefined);
    expect(find('chat-thread-opening')).toBeNull();
    if (!find('generation-settings-btn')) await act(async () => el('composer-tune-btn').click());
    for (const testId of ['approval-mode-btn', 'model-picker-btn']) expect(disabled(testId), testId).toBe(true);
    for (const testId of CONTROLS.filter(find)) expect(disabled(testId), testId).toBe(true);
    const input = el('chat-composer-input') as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('This conversation could not be opened');
    await act(async () => el('chat-send-btn').click());
    expect(sendMessage).not.toHaveBeenCalled();

    await act(async () => document.querySelectorAll<HTMLElement>('[data-testid="chat-session-item"]')[0].click());
    await act(async () => undefined);
    if (!find('generation-settings-btn')) await act(async () => el('composer-tune-btn').click());
    for (const testId of CONTROLS) expect(disabled(testId), testId).toBe(false);
    expect((el('chat-composer-input') as HTMLTextAreaElement).disabled).toBe(false);
  });

  const SETTERS = [
    'setSessionModel',
    'setSessionReasoningEffort',
    'setSessionPromptCacheTtl',
    'setApprovalMode',
  ] as const;

  it.each([
    ['approval-mode-btn', 'approval-mode-option-'],
    ['model-picker-btn', 'model-picker-option'],
    ['effort-picker-btn', 'effort-picker-option'],
    ['prompt-cache-ttl-picker-btn', 'prompt-cache-ttl-picker-option-'],
  ])('closes the open %s menu on Mod+2 and calls no setter', async (button, option) => {
    const setters = SETTERS.map(name => vi.fn(async () => null));
    const chat = window.b4m.chat as unknown as Record<string, unknown>;
    SETTERS.forEach((name, index) => (chat[name] = setters[index]));
    chat.listModels = async () => ({ models: [MODEL, OPUS] });
    chat.getSession = async (id: string) =>
      ({ ...SESSIONS.find(entry => entry.id === id), model: OPUS.id, messages: [] }) as unknown as ChatSession;
    await renderShell();
    await act(async () => el('composer-tune-btn').click());
    await act(async () => el(button).click());
    const open = () => document.querySelector(`[data-testid^="${option}"]`);
    expect(open()).not.toBeNull();

    await press(el(button), { key: '2', code: 'Digit2', ctrlKey: true });
    expect(el('chat-session-title').textContent).toBe('Second');
    expect(open()).toBeNull();
    for (const setter of setters) expect(setter).not.toHaveBeenCalled();
  });
});
