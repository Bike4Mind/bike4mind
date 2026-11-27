// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSessionSummary } from '@shared/chat';
import { EMPTY_SIDEBAR_SECTIONS } from '@shared/sidebarSections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { SessionList } from './SessionList';
import { localHostConnections } from '../__fixtures__/chatBackedHostBridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./SessionBadge', () => ({ SessionBadge: () => null }));

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

const summary = (id: string, title: string, extra: Partial<ChatSessionSummary> = {}): ChatSessionSummary =>
  ({
    id,
    title,
    mode: 'chat',
    messageCount: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  }) as ChatSessionSummary;

interface Handlers {
  onTogglePin: (s: ChatSessionSummary) => void;
  onToggleArchived: (s: ChatSessionSummary) => void;
  onDelete: (id: string) => void;
  onDownload: (s: ChatSessionSummary) => void;
  downloadError: string;
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(sessions: ChatSessionSummary[], handlers: Partial<Handlers> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <SessionList
          sessions={sessions}
          mode="chat"
          loading={false}
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
          onDelete={handlers.onDelete ?? (() => {})}
          onTogglePin={handlers.onTogglePin ?? (() => {})}
          onToggleArchived={handlers.onToggleArchived ?? (() => {})}
          onRename={() => {}}
          onDownload={handlers.onDownload ?? (() => {})}
          downloadError={handlers.downloadError}
          userSections={EMPTY_SIDEBAR_SECTIONS}
          sectionActions={{ create: () => {}, rename: () => {}, remove: () => {}, move: () => {} }}
        />
      </CssVarsProvider>
    );
  });
}

const query = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const settle = () => act(async () => undefined);
const click = async (node: HTMLElement) => {
  act(() => node.click());
  await settle();
};
const openMenu = async () => {
  const button = query('chat-session-menu-btn');
  if (!button) throw new Error('no menu button');
  await click(button);
};
const press = async (key: string, init: KeyboardEventInit = {}) => {
  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  if (!menu) throw new Error('no open menu');
  act(() => {
    menu.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
  await settle();
};

beforeEach(() => {
  Object.assign(window, { b4m: { host: localHostConnections() } });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('SessionList row menu shortcuts', () => {
  it('shows the letter hint beside each shortcut item', async () => {
    await mount([summary('a', 'Alpha')]);
    await openMenu();

    expect(query('chat-pin-session-btn')?.getAttribute('aria-keyshortcuts')).toBe('P');
    expect(query('chat-pin-session-btn')?.textContent).toBe('PinP');
    expect(query('chat-rename-session-btn')?.getAttribute('aria-keyshortcuts')).toBe('R');
    expect(query('session-row-message-action')?.getAttribute('aria-keyshortcuts')).toBe('M');
    expect(query('chat-download-session-btn')?.getAttribute('aria-keyshortcuts')).toBe('L');
    expect(query('chat-archive-session-btn')?.getAttribute('aria-keyshortcuts')).toBe('A');
    expect(query('chat-delete-session-btn')?.getAttribute('aria-keyshortcuts')).toBe('D');
    expect(query('chat-move-session-btn')?.textContent).toBe('Move to section');
  });

  it('runs Pin on P, but not with a modifier held', async () => {
    const onTogglePin = vi.fn();
    const session = summary('a', 'Alpha');
    await mount([session], { onTogglePin });
    await openMenu();

    await press('p', { metaKey: true });
    await press('p', { ctrlKey: true });
    expect(onTogglePin).not.toHaveBeenCalled();

    await press('p');
    expect(onTogglePin).toHaveBeenCalledWith(session);
  });

  it('runs Archive on A and Delete on D', async () => {
    const onToggleArchived = vi.fn();
    const onDelete = vi.fn();
    const session = summary('a', 'Alpha');
    await mount([session], { onToggleArchived, onDelete });

    await openMenu();
    await press('A');
    expect(onToggleArchived).toHaveBeenCalledWith(session);

    await openMenu();
    await press('d');
    expect(onDelete).toHaveBeenCalledWith('a');
  });

  it('leaves no focus ring on the row once a rename from the menu is cancelled, and R reopens it', async () => {
    await mount([summary('a', 'Alpha')]);
    await openMenu();
    await click(query('chat-rename-session-btn') as HTMLElement);
    const input = query('chat-session-rename-input') as HTMLElement;
    expect(document.activeElement).toBe(input);

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await settle();

    expect(query('chat-session-rename-input')).toBeNull();
    expect(query('chat-session-item')?.className).not.toContain('Mui-focusVisible');
    expect(query('chat-session-menu-btn')).not.toBeNull();

    await openMenu();
    await press('r');
    expect(query('chat-session-rename-input')).not.toBeNull();
  });

  it('runs Download on L and opens Message session on M', async () => {
    const onDownload = vi.fn();
    const session = summary('a', 'Alpha');
    await mount([session], { onDownload });

    await openMenu();
    await press('l');
    expect(onDownload).toHaveBeenCalledWith(session);

    await openMenu();
    await press('m');
    expect(query('message-session-dialog')).not.toBeNull();
  });

  it('offers Download on an archived session, and does not run a disabled item', async () => {
    await mount([summary('a', 'Alpha', { archived: true })]);
    await click(query('sidebar-archived-btn') as HTMLElement);
    await openMenu();
    expect(query('chat-download-session-btn')).not.toBeNull();

    await press('m');

    expect(query('message-session-dialog')).toBeNull();
  });
});

describe('SessionList Download', () => {
  it('passes the session to the action from the row menu', async () => {
    const onDownload = vi.fn();
    const session = summary('a', 'Alpha');
    await mount([session], { onDownload });

    await openMenu();
    await click(query('chat-download-session-btn') as HTMLElement);

    expect(onDownload).toHaveBeenCalledWith(session);
  });

  it('shows a download failure', async () => {
    await mount([summary('a', 'Alpha')], { downloadError: 'Could not download "Alpha".' });
    expect(query('chat-download-error')?.textContent).toBe('Could not download "Alpha".');
  });
});
