// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type {
  AddAttachmentsResult,
  ChatAttachment,
  ChatImageActionResult,
  ChatImageRef,
  ChatMedia,
  ChatSession,
  ChatSessionSummary,
} from '@shared/chat';
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

const ACTIVE: ChatSessionSummary = {
  id: 'open-1',
  title: 'Open thread',
  mode: 'chat',
  messageCount: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
} as ChatSessionSummary;

const SCREENSHOT: ChatMedia = {
  kind: 'image',
  url: 'b4m-media://media/open-1/00000000-0000-4000-8000-000000000000.png',
  mimeType: 'image/png',
  byteLength: 10,
  caption: 'https://example.com',
};

const SESSION: ChatSession = {
  ...ACTIVE,
  messages: [
    {
      id: 'm1',
      role: 'assistant',
      content: '',
      createdAt: '2026-10-01T00:00:01.000Z',
      toolCalls: [{ id: 'call-1', name: 'browser_screenshot', input: {}, status: 'done', media: [SCREENSHOT] }],
    },
  ],
} as ChatSession;

const OTHER: ChatSession = { ...SESSION, id: 'open-2', title: 'Other thread', messages: [] };

const DRAFTED: ChatAttachment = {
  id: 'a1',
  kind: 'image',
  name: 'screenshot-2026-10-21-143005.png',
  mediaType: 'image/png',
  byteSize: 10,
  sourceBytes: 10,
};

const imageAction = vi.fn(async (..._args: unknown[]): Promise<ChatImageActionResult> => ({ ok: true, done: true }));
const attachImage = vi.fn(async (_sessionId: string, _image: ChatImageRef): Promise<AddAttachmentsResult> => ({
  attachments: [DRAFTED],
  rejected: [],
}));

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
  imageAction.mockClear();
  attachImage.mockClear();
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
        listSessions: async () => [ACTIVE, { ...ACTIVE, id: OTHER.id, title: OTHER.title }],
        getSession: async (sessionId: string) => (sessionId === OTHER.id ? OTHER : SESSION),
        getQueuedMessages: async () => [],
        getSessionStatuses: async () => [],
        listModels: async () => ({ models: [] }),
        readAttachment: async () => 'data:image/png;base64,AAAA',
        pickAttachments: async () => ({ attachments: [], rejected: [] }),
        imageAction,
        attachImage,
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

const el = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

async function openAssistantSession() {
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
  await act(async () => el('chat-session-item')?.click());
  await act(async () => undefined);
  await act(async () => undefined);
}

async function rightClick(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
  });
}

describe('the image menu in a conversation', () => {
  it('attaches a thread image to the composer draft, whose own tiles offer no menu', async () => {
    await openAssistantSession();

    const image = el('chat-media-view-btn');
    if (!image) throw new Error('the thread image did not render');
    await rightClick(image);

    const attach = el('image-menu-attach-btn');
    if (!attach) throw new Error('the thread image has no attach item');
    await act(async () => attach.click());
    await act(async () => undefined);

    expect(attachImage).toHaveBeenCalledWith('open-1', {
      source: 'media',
      url: SCREENSHOT.url,
      nameHint: 'screenshot',
    });

    // The composer is outside the provider: its draft tile opens no menu.
    const tile = el('attachment-view-btn');
    if (!tile) throw new Error('the draft tile did not render');
    await rightClick(tile);
    expect(el('image-context-menu')).toBeNull();
  });

  // Closed by the `opening` gate, which unmounts the provider for the render before the new
  // transcript arrives. The provider's `key` is a backstop this test cannot reach: no switch
  // skips that gate today.
  it('closes the image menu when another conversation is selected', async () => {
    await openAssistantSession();
    const image = el('chat-media-view-btn');
    if (!image) throw new Error('the thread image did not render');
    await rightClick(image);
    expect(el('image-menu-attach-btn')).not.toBeNull();

    const other = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="chat-session-item"]')).find(item =>
      item.textContent?.includes(OTHER.title)
    );
    if (!other) throw new Error('the other conversation did not render');
    await act(async () => other.click());

    expect(el('chat-session-title')?.textContent).toBe(OTHER.title);
    expect(el('image-context-menu')).toBeNull();
    expect(el('image-menu-attach-btn')).toBeNull();
    expect(attachImage).not.toHaveBeenCalled();
  });
});
