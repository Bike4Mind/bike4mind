// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSessionSummary } from '@shared/chat';
import { EMPTY_SIDEBAR_SECTIONS } from '@shared/sidebarSections';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { SessionList } from './SessionList';

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

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(
  sessions: ChatSessionSummary[],
  extra: { onDownload?: (s: ChatSessionSummary) => void; downloadError?: string } = {}
) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <SessionList
          sessions={sessions}
          mode="chat"
          onModeChange={() => {}}
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
          onDelete={() => {}}
          onTogglePin={() => {}}
          onToggleArchived={() => {}}
          onRename={() => {}}
          onDownload={extra.onDownload ?? (() => {})}
          downloadError={extra.downloadError}
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

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('SessionList Download', () => {
  it('offers Download in the row menu and passes the session to the action', async () => {
    const onDownload = vi.fn();
    const session = summary('a', 'Alpha');
    await mount([session], { onDownload });

    await openMenu();
    const item = query('chat-download-session-btn');
    expect(item?.textContent).toBe('Download');
    await click(item as HTMLElement);

    expect(onDownload).toHaveBeenCalledWith(session);
  });

  it('offers Download on an archived session too', async () => {
    await mount([summary('a', 'Alpha', { archived: true })]);
    await click(query('sidebar-archived-btn') as HTMLElement);

    await openMenu();
    expect(query('chat-download-session-btn')).not.toBeNull();
  });

  it('shows a download failure', async () => {
    await mount([summary('a', 'Alpha')], { downloadError: 'Could not download "Alpha".' });
    expect(query('chat-download-error')?.textContent).toBe('Could not download "Alpha".');
  });
});
