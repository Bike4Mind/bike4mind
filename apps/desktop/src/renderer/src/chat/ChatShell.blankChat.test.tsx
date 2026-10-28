// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatMessage, ChatSession, ChatSessionSummary, CreationTool } from '@shared/chat';
import { EMPTY_SIDEBAR_SECTIONS } from '@shared/sidebarSections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ChatShell } from './ChatShell';
import { resetCreationToolsCache } from './useCreationTools';

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

const tool = (name: string): CreationTool => ({ name, spendsCredits: true });
const ALL_TOOLS = [
  'generate_image',
  'generate_speech',
  'generate_sound_effect',
  'generate_music',
  'generate_video',
].map(tool);

const HOSTED = 'claude-opus-4-5-20251101';

const summary = (mode: 'chat' | 'code', model: string): ChatSessionSummary =>
  ({
    id: 'blank-1',
    title: 'New conversation',
    mode,
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
const sendMessage = vi.fn(async () => ({ ok: true }));
const listCreationTools = vi.fn();

function stubBridge({
  tools,
  mode = 'chat',
  messages = [],
  model = HOSTED,
}: {
  tools: CreationTool[];
  mode?: 'chat' | 'code';
  messages?: ChatMessage[];
  model?: string;
}) {
  const session = summary(mode, model);
  listCreationTools.mockImplementation(async () => tools);
  (window as unknown as { b4m: unknown }).b4m = new Proxy(
    {
      chat: quietBridge({
        listSessions: async () => [session],
        getSession: async () => ({ ...session, messageCount: messages.length, messages }) as ChatSession,
        getQueuedMessages: async () => [],
        getSessionStatuses: async () => [],
        listModels: async () => ({ models: [] }),
        listCreationTools,
        listArtifacts: async () => ({ artifacts: [], total: 0 }),
        sendMessage,
      }),
      sidebar: quietBridge({ getSections: async () => EMPTY_SIDEBAR_SECTIONS }),
      // A Code session's chips shorten paths against the home directory.
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
  resetCreationToolsCache();
  sendMessage.mockClear();
  listCreationTools.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

async function openBlankSession() {
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
  await act(async () => document.querySelector<HTMLElement>('[data-testid="chat-session-item"]')?.click());
  await act(async () => undefined);
}

const cards = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="chat-empty-suggestion-btn"]')];
const composer = () => document.querySelector<HTMLTextAreaElement>('[data-testid="chat-composer-input"]');

describe('the blank chat', () => {
  it('renders a card for each offered category', async () => {
    stubBridge({ tools: ALL_TOOLS });
    await openBlankSession();

    expect(document.querySelector('[data-testid="chat-empty-greeting"]')?.textContent).toBe(
      'What do you want to make?'
    );
    expect(cards().map(card => card.dataset.category)).toEqual(['image', 'video', 'voice', 'sound', 'music', 'write']);
    for (const card of cards()) {
      expect(card.getAttribute('aria-label')).toContain(
        card.querySelector('[data-testid="chat-empty-suggestion-prompt"]')?.textContent
      );
    }
  });

  it('hides video when generate_video is not offered', async () => {
    stubBridge({ tools: ALL_TOOLS.filter(t => t.name !== 'generate_video') });
    await openBlankSession();

    expect(cards().map(card => card.dataset.category)).not.toContain('video');
    expect(document.querySelector('[data-testid="chat-empty-subline"]')?.textContent).not.toMatch(/video/);
  });

  it('fills the composer with the prompt on click, caret at the end, without sending', async () => {
    stubBridge({ tools: ALL_TOOLS });
    await openBlankSession();

    const music = cards().find(card => card.dataset.category === 'music');
    const prompt = music?.querySelector('[data-testid="chat-empty-suggestion-prompt"]')?.textContent ?? '';
    await act(async () => music?.click());

    const input = composer();
    expect(input?.value).toBe(prompt);
    expect(document.activeElement).toBe(input);
    expect(input?.selectionStart).toBe(prompt.length);
    expect(input?.selectionEnd).toBe(prompt.length);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not put a used suggestion back when the composer remounts', async () => {
    stubBridge({ tools: ALL_TOOLS });
    await openBlankSession();

    await act(async () => cards()[0].click());
    const input = composer();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, '');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // The Artifacts screen replaces the conversation, composer included.
    await act(async () => document.querySelector<HTMLElement>('[data-testid="chat-artifacts-btn"]')?.click());
    await act(async () => document.querySelector<HTMLElement>('[data-testid="artifact-library-close-btn"]')?.click());
    await act(async () => undefined);

    expect(composer()).not.toBeNull();
    expect(composer()?.value).toBe('');
  });

  // jsdom does not synthesize a native button's Enter/Space activation, so this pins what makes
  // the browser do it - a focusable, enabled <button type="button"> - and then activates it the
  // way the browser would.
  it('is reachable and activated from the keyboard', async () => {
    stubBridge({ tools: ALL_TOOLS });
    await openBlankSession();

    const card = cards()[0];
    expect(card.tagName).toBe('BUTTON');
    expect(card.type).toBe('button');
    expect(card.disabled).toBe(false);
    expect(card.tabIndex).toBe(0);
    act(() => card.focus());
    expect(document.activeElement).toBe(card);

    const prompt = card.querySelector('[data-testid="chat-empty-suggestion-prompt"]')?.textContent ?? '';
    await act(async () => card.click());
    expect(composer()?.value).toBe(prompt);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("asks for the tools of the conversation's own model", async () => {
    stubBridge({ tools: ALL_TOOLS });
    await openBlankSession();

    expect(listCreationTools).toHaveBeenCalledWith(HOSTED);
  });

  it('shows no media cards on a local model, without asking main', async () => {
    stubBridge({ tools: ALL_TOOLS, model: 'local:ollama:qwen3:8b' });
    await openBlankSession();

    expect(cards().map(card => card.dataset.category)).toEqual(['write', 'ask']);
    expect(listCreationTools).not.toHaveBeenCalled();
  });

  it('does not render, or ask for tools, once the conversation has messages', async () => {
    stubBridge({
      tools: ALL_TOOLS,
      messages: [{ id: 'm1', role: 'user', content: 'Hello', createdAt: '2026-10-01T00:00:01.000Z' }],
    });
    await openBlankSession();

    expect(document.querySelector('[data-testid="chat-thread"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="chat-empty-greeting"]')).toBeNull();
    expect(cards()).toHaveLength(0);
    expect(listCreationTools).not.toHaveBeenCalled();
  });

  it('leaves the Code blank state as it was', async () => {
    stubBridge({ tools: ALL_TOOLS, mode: 'code' });
    await openBlankSession();

    expect(cards()).toHaveLength(0);
    expect(document.querySelector('[data-testid="chat-empty-greeting"]')).toBeNull();
    expect(document.querySelector('[data-testid="chat-code-workspace-setup"]')?.textContent).toContain(
      'Set up this workspace'
    );
    expect(listCreationTools).not.toHaveBeenCalled();
  });
});
