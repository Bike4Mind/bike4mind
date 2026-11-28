// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSessionSummary } from '@shared/chat';
import { SESSION_PAGE_SIZE } from '@shared/sessionPage';
import { EMPTY_SIDEBAR_SECTIONS } from '@shared/sidebarSections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { chatBackedHostBridge } from '../__fixtures__/chatBackedHostBridge';
import { SessionList } from './SessionList';
import { useSessions } from './useChat';
import { SESSION_SEARCH_DEBOUNCE_MS } from './useSessionSearch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

/** Reports every observed sentinel as visible or not, on demand. */
class FakeObserver {
  static live = new Set<FakeObserver>();
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe() {
    FakeObserver.live.add(this);
  }
  disconnect() {
    FakeObserver.live.delete(this);
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
  static show() {
    for (const observer of FakeObserver.live) {
      observer.callback([{ isIntersecting: true } as IntersectionObserverEntry], observer as never);
    }
  }
}

const summary = (index: number) =>
  ({
    id: `s${index}`,
    title: index === 240 ? 'Quarterly deploy retro' : `Conversation ${index}`,
    mode: 'chat',
    messageCount: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1) - index * 60_000).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, 1) - index * 60_000).toISOString(),
  }) as ChatSessionSummary;

let root: Root | null = null;
let listSessions = vi.fn<() => Promise<ChatSessionSummary[]>>();

function Harness() {
  const { sessions, loading, hasMore, loadingMore, loadMore, total, searchSessions } = useSessions();
  return (
    <SessionList
      sessions={sessions}
      mode="chat"
      loading={loading}
      activeId={null}
      statuses={new Map()}
      prSummaries={new Map()}
      collapsed={false}
      onToggleCollapsed={() => {}}
      onSelect={() => {}}
      onCreate={() => {}}
      onOpenArtifacts={() => {}}
      onCreateInProject={() => {}}
      onCreateInSection={() => {}}
      onDelete={() => {}}
      onTogglePin={() => {}}
      onToggleArchived={() => {}}
      onSetOrchestratorLabel={() => {}}
      onRename={() => {}}
      onDownload={() => {}}
      userSections={EMPTY_SIDEBAR_SECTIONS}
      sectionActions={{ create: () => {}, rename: () => {}, remove: () => {}, move: () => {} }}
      paging={{ hasMore, loadingMore, onLoadMore: loadMore, total }}
      searchSessions={searchSessions}
    />
  );
}

async function mount(count: number) {
  const sessions = Array.from({ length: count }, (_, index) => summary(index));
  listSessions = vi.fn(async () => sessions);
  (window as unknown as { b4m: unknown }).b4m = {
    host: chatBackedHostBridge(),
    chat: {
      listSessions,
      onSessionSummary: () => () => undefined,
      onStreamEvent: () => () => undefined,
    },
  };
  const element = document.createElement('div');
  document.body.appendChild(element);
  root = createRoot(element);
  await act(async () => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <Harness />
      </CssVarsProvider>
    );
  });
}

const rows = () => document.querySelectorAll('[data-testid="chat-session-item"]').length;
const query = (testId: string) => document.querySelector(`[data-testid="${testId}"]`);

beforeEach(() => {
  FakeObserver.live.clear();
  vi.stubGlobal('IntersectionObserver', FakeObserver);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('the sidebar list, a page at a time', () => {
  it('draws only the first page, with a sentinel below it', async () => {
    await mount(250);
    expect(rows()).toBe(SESSION_PAGE_SIZE);
    expect(query('sidebar-load-more-sentinel')).not.toBeNull();
    expect(query('sidebar-list-end')).toBeNull();
  });

  it('draws the next page when the sentinel scrolls into view, and says when that is all', async () => {
    await mount(250);
    await act(async () => FakeObserver.show());
    expect(rows()).toBe(200);
    await act(async () => FakeObserver.show());
    expect(rows()).toBe(250);
    expect(query('sidebar-load-more-sentinel')).toBeNull();
    expect(query('sidebar-list-end')?.textContent).toBe('No older conversations');
  });

  it('shows no footer for a list that fits in one page', async () => {
    await mount(5);
    expect(rows()).toBe(5);
    expect(query('sidebar-load-more-sentinel')).toBeNull();
    expect(query('sidebar-list-end')).toBeNull();
  });

  it('finds a session no page has loaded yet when searching', async () => {
    await mount(250);
    const search = query('chat-search-input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(search, 'deploy');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(rows()).toBe(0);
    await act(async () => new Promise(resolve => setTimeout(resolve, SESSION_SEARCH_DEBOUNCE_MS + 50)));
    const titles = [...document.querySelectorAll('[data-testid="chat-session-item"]')].map(row => row.textContent);
    expect(titles).toHaveLength(1);
    expect(titles[0]).toContain('Quarterly deploy retro');
    expect(query('sidebar-load-more-sentinel')).toBeNull();
  });
});
