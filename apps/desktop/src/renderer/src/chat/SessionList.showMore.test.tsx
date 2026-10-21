// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSessionMode, ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import { EMPTY_SIDEBAR_SECTIONS, type SidebarSectionsState } from '@shared/sidebarSections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// The limits live in a module store for the whole run, so every test gets a project of its own.
let projectSeq = 0;
let directory = '';

const projectSessions = (count: number, extra: (index: number) => Partial<ChatSessionSummary> = () => ({})) =>
  Array.from(
    { length: count },
    (_, index) =>
      ({
        id: `s${index}`,
        title: `Task ${index}`,
        mode: 'code',
        messageCount: 1,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        project: { directory, name: 'proj' },
        ...extra(index),
      }) as ChatSessionSummary
  );

interface Props {
  sessions: ChatSessionSummary[];
  activeId?: string | null;
  statuses?: ReadonlyMap<string, ChatSessionStatus>;
  collapsed?: boolean;
  mode?: ChatSessionMode;
  userSections?: SidebarSectionsState;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function render({
  sessions,
  activeId = null,
  statuses = new Map(),
  collapsed = false,
  mode = 'code',
  userSections = EMPTY_SIDEBAR_SECTIONS,
}: Props) {
  act(() => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <SessionList
          sessions={sessions}
          mode={mode}
          onModeChange={() => {}}
          loading={false}
          activeId={activeId}
          statuses={statuses}
          prSummaries={new Map()}
          collapsed={collapsed}
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
          userSections={userSections}
          sectionActions={{ create: () => {}, rename: () => {}, remove: () => {}, move: () => {} }}
        />
      </CssVarsProvider>
    );
  });
}

const all = (testId: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`));
const query = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const group = () => {
  const found = query('project-group');
  if (!found) throw new Error('no project group');
  return found;
};
const groupTitles = () => all('chat-session-title-text', group()).map(node => node.textContent);
const showMore = () => query('sidebar-project-show-more-btn');
const showLess = () => query('sidebar-project-show-less-btn');
const click = (node: HTMLElement | null) => {
  if (!node) throw new Error('nothing to click');
  act(() => node.click());
};

function typeSearch(text: string) {
  const input = query('chat-search-input') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  directory = `/work/project-${++projectSeq}`;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('SessionList project cap', () => {
  it('draws a project of exactly 20 whole, with no Show more', () => {
    render({ sessions: projectSessions(20) });
    expect(groupTitles()).toHaveLength(20);
    expect(showMore()).toBeNull();
    expect(showLess()).toBeNull();
  });

  it('caps 21 at the first 20 and counts the one hidden', () => {
    render({ sessions: projectSessions(21) });
    expect(groupTitles()).toEqual(projectSessions(20).map(session => session.title));
    expect(showMore()?.textContent).toBe('Show more(1 hidden)');
  });

  it('renders only 20 rows for a 500-session project', () => {
    render({ sessions: projectSessions(500) });
    expect(all('chat-session-item')).toHaveLength(20);
    expect(showMore()?.textContent).toBe('Show more(480 hidden)');
  });

  it('reveals 10 per click, the last click reveals the remainder, then only Show less is left', () => {
    render({ sessions: projectSessions(35) });
    click(showMore());
    expect(groupTitles()).toHaveLength(30);
    expect(showMore()?.textContent).toBe('Show more(5 hidden)');
    expect(showLess()).not.toBeNull();

    click(showMore());
    expect(groupTitles()).toHaveLength(35);
    expect(showMore()).toBeNull();
    expect(showLess()).not.toBeNull();
  });

  it('Show less collapses back to 20', () => {
    render({ sessions: projectSessions(60) });
    click(showMore());
    click(showMore());
    expect(groupTitles()).toHaveLength(40);
    click(showLess());
    expect(groupTitles()).toHaveLength(20);
    expect(showLess()).toBeNull();
    expect(showMore()?.textContent).toBe('Show more(40 hidden)');
  });

  it('keeps an active session past the cap in its own place, once', () => {
    render({ sessions: projectSessions(500), activeId: 's300' });
    const titles = groupTitles();
    expect(titles).toHaveLength(21);
    expect(titles[20]).toBe('Task 300');
    expect(titles.filter(title => title === 'Task 300')).toHaveLength(1);
    expect(showMore()?.textContent).toBe('Show more(479 hidden)');
  });

  it('keeps pinned, running and waiting sessions past the cap visible', () => {
    const sessions = projectSessions(100, index => (index === 30 ? { pinned: true } : {}));
    const statuses = new Map<string, ChatSessionStatus>([
      ['s40', 'processing'],
      ['s50', 'needs-action'],
      ['s60', 'done'],
    ]);
    render({ sessions, statuses });

    // Pinned rows are lifted out of their project into the Pinned section, drawn once there.
    const pinned = query('sidebar-pinned');
    expect(pinned && all('chat-session-title-text', pinned).map(node => node.textContent)).toEqual(['Task 30']);
    expect(all('chat-session-title-text').filter(node => node.textContent === 'Task 30')).toHaveLength(1);

    const titles = groupTitles();
    expect(titles.slice(20)).toEqual(['Task 40', 'Task 50']);
    expect(titles).not.toContain('Task 60');
    expect(showMore()?.textContent).toBe('Show more(77 hidden)');
  });

  it('shows every match uncapped while searching', () => {
    render({ sessions: projectSessions(500) });
    typeSearch('Task');
    expect(groupTitles()).toHaveLength(500);
    expect(showMore()).toBeNull();
    typeSearch('');
    expect(groupTitles()).toHaveLength(20);
  });

  it('keeps the count across a sidebar collapse, a mode switch and a remount', () => {
    const sessions = projectSessions(80);
    render({ sessions });
    click(showMore());
    expect(groupTitles()).toHaveLength(30);

    render({ sessions, collapsed: true });
    expect(query('project-group')).toBeNull();
    render({ sessions });
    expect(groupTitles()).toHaveLength(30);

    render({ sessions, mode: 'chat' });
    render({ sessions });
    expect(groupTitles()).toHaveLength(30);

    act(() => root?.unmount());
    root = createRoot(host as HTMLElement);
    render({ sessions });
    expect(groupTitles()).toHaveLength(30);
  });

  it('keeps the newest on top when a session arrives', () => {
    const sessions = projectSessions(25);
    render({ sessions });
    const newest = { ...sessions[0], id: 'new', title: 'Newest' };
    render({ sessions: [newest, ...sessions] });
    const titles = groupTitles();
    expect(titles).toHaveLength(20);
    expect(titles[0]).toBe('Newest');
    expect(showMore()?.textContent).toBe('Show more(6 hidden)');
  });

  it('is a focusable button that hands focus to Show less when it reveals the last rows', () => {
    render({ sessions: projectSessions(25) });
    const more = showMore() as HTMLButtonElement;
    expect(more.tagName).toBe('BUTTON');
    act(() => more.focus());
    click(more);
    expect(showMore()).toBeNull();
    expect(document.activeElement).toBe(showLess());
    click(showLess());
    expect(document.activeElement).toBe(showMore());
  });
});

describe('SessionList user section cap', () => {
  it('caps a user section the same way, under its own test ids', () => {
    const sessions = projectSessions(30);
    const userSections: SidebarSectionsState = {
      sections: [{ id: `sec-${projectSeq}`, name: 'Work' }],
      assignments: Object.fromEntries(sessions.map(session => [session.id, `sec-${projectSeq}`])),
    };
    render({ sessions, userSections });
    const section = query('sidebar-section') as HTMLElement;
    expect(all('chat-session-item', section)).toHaveLength(20);
    click(query('sidebar-section-show-more-btn'));
    expect(all('chat-session-item', section)).toHaveLength(30);
    expect(query('sidebar-section-show-less-btn')).not.toBeNull();
  });
});
