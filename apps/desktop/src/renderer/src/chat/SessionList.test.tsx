// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSessionMode, ChatSessionSummary } from '@shared/chat';
import { EMPTY_SIDEBAR_SECTIONS } from '@shared/sidebarSections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { setImportedInline } from './importedInline';
import { foldedParents, setNestingEnabled, toggleFolded } from './nestedSessions';
import { SessionList } from './SessionList';
import { useSessions } from './useChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Rows drawn so far, one badge per row render; see the render-count test. */
const badgeRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('./SessionBadge', () => ({
  SessionBadge: () => {
    badgeRenders.count++;
    return null;
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

const summary = (id: string, title: string, extra: Partial<ChatSessionSummary> = {}) =>
  ({
    id,
    title,
    mode: 'chat',
    messageCount: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  }) as ChatSessionSummary;

let root: Root | null = null;
let host: HTMLElement | null = null;
let onSelect = vi.fn<(id: string) => void>();
let renameSession = vi.fn<(id: string, title: string) => Promise<ChatSessionSummary | null>>();

/** The real sessions owner under the list, so a rename travels the same path it does in the app. */
function Harness({ activeId, mode }: { activeId: string | null; mode: ChatSessionMode }) {
  const { sessions, loading, rename, renameError, clearRenameError, remove, togglePin, toggleArchived } = useSessions();
  return (
    <SessionList
      sessions={sessions}
      mode={mode}
      onModeChange={() => {}}
      loading={loading}
      activeId={activeId}
      statuses={new Map()}
      prSummaries={new Map()}
      collapsed={false}
      onToggleCollapsed={() => {}}
      onSelect={onSelect}
      onCreate={() => {}}
      onOpenArtifacts={() => {}}
      onCreateInProject={() => {}}
      onCreateInSection={() => {}}
      onDelete={id => void remove(id)}
      onTogglePin={session => void togglePin(session)}
      onToggleArchived={session => void toggleArchived(session)}
      onRename={(session, title) => void rename(session, title)}
      renameError={renameError}
      onDismissRenameError={clearRenameError}
      userSections={EMPTY_SIDEBAR_SECTIONS}
      sectionActions={{ create: () => {}, rename: () => {}, remove: () => {}, move: () => {} }}
    />
  );
}

async function mount(
  sessions: ChatSessionSummary[],
  mode: ChatSessionMode = 'chat',
  extra: Record<string, unknown> = {},
  activeId: string | null = null
) {
  (window as unknown as { b4m: unknown }).b4m = {
    chat: {
      listSessions: async () => sessions,
      onSessionSummary: () => () => undefined,
      onStreamEvent: () => () => undefined,
      renameSession,
    },
    ...extra,
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <Harness activeId={activeId} mode={mode} />
      </CssVarsProvider>
    );
  });
}

const all = (testId: string) => Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`));
const el = (testId: string) => {
  const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`no ${testId}`);
  return found;
};
const query = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const titles = () => all('chat-session-title-text').map(node => node.textContent);
const renameInput = () => el('chat-session-rename-input') as HTMLInputElement;

const rowOf = (title: string) => {
  const row = all('chat-session-item').find(
    item => item.querySelector('[data-testid="chat-session-title-text"]')?.textContent === title
  );
  if (!row) throw new Error(`no row ${title}`);
  return row;
};

const doubleClickTitle = (title: string) =>
  act(() => {
    const text = rowOf(title).querySelector('[data-testid="chat-session-title-text"]');
    text?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });

/** Opens the row's menu and picks Rename. The menu is a portal, so it lands on `document`. */
const renameFromMenu = (title: string) => {
  const item = rowOf(title).closest('li');
  act(() => item?.querySelector<HTMLElement>('[data-testid="chat-session-menu-btn"]')?.click());
  act(() => el('chat-rename-session-btn').click());
};

function typeOver(text: string) {
  const input = renameInput();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    renameInput().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });

const settle = () => act(async () => undefined);

beforeEach(() => {
  badgeRenders.count = 0;
  onSelect = vi.fn();
  renameSession = vi.fn(async (id: string, title: string) => summary(id, title));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('renaming a session from the sidebar', () => {
  it('turns the title into a focused input with the whole title selected from the menu', async () => {
    await mount([summary('a', 'Alpha'), summary('b', 'Beta')]);
    renameFromMenu('Beta');

    const input = renameInput();
    expect(input.value).toBe('Beta');
    expect(input.getAttribute('aria-label')).toBe('Rename session');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 4]);
    expect(input.maxLength).toBe(60);
  });

  it('leaves the row menu shut once a rename from it is finished', async () => {
    await mount([summary('a', 'Alpha')]);
    renameFromMenu('Alpha');
    press('Escape');
    await settle();

    expect(query('chat-rename-session-btn')).toBeNull();
    expect(query('chat-session-menu-btn')?.getAttribute('aria-expanded')).not.toBe('true');
  });

  it('enters editing on a double-click of the title', async () => {
    await mount([summary('a', 'Alpha')]);
    doubleClickTitle('Alpha');
    expect(renameInput().value).toBe('Alpha');
  });

  it('saves on Enter with the id and the trimmed title, and shows it at once', async () => {
    await mount([summary('a', 'Alpha'), summary('b', 'Beta')]);
    let resolve: (value: ChatSessionSummary | null) => void = () => {};
    renameSession.mockImplementation(() => new Promise(done => (resolve = done)));

    renameFromMenu('Beta');
    typeOver('   Gamma   ray  ');
    press('Enter');

    expect(renameSession).toHaveBeenCalledWith('b', 'Gamma ray');
    expect(query('chat-session-rename-input')).toBeNull();
    // Optimistic: the title is in the list before main has answered.
    expect(titles()).toContain('Gamma ray');

    await act(async () => resolve(summary('b', 'Gamma ray', { updatedAt: '2026-10-02T00:00:00.000Z' })));
    expect(titles()).toEqual(['Gamma ray', 'Alpha']);
  });

  it('saves on blur', async () => {
    await mount([summary('a', 'Alpha')]);
    doubleClickTitle('Alpha');
    typeOver('Omega');
    act(() => renameInput().blur());
    await settle();

    expect(renameSession).toHaveBeenCalledTimes(1);
    expect(renameSession).toHaveBeenCalledWith('a', 'Omega');
  });

  it('cancels on Escape, keeping the old title', async () => {
    await mount([summary('a', 'Alpha')]);
    doubleClickTitle('Alpha');
    typeOver('Omega');
    press('Escape');
    await settle();

    expect(renameSession).not.toHaveBeenCalled();
    expect(query('chat-session-rename-input')).toBeNull();
    expect(titles()).toEqual(['Alpha']);
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '    '],
    ['unchanged', '  Alpha '],
  ])('treats an %s title as a no-op', async (_label, text) => {
    await mount([summary('a', 'Alpha')]);
    doubleClickTitle('Alpha');
    typeOver(text);
    press('Enter');
    await settle();

    expect(renameSession).not.toHaveBeenCalled();
    expect(titles()).toEqual(['Alpha']);
  });

  it.each([
    ['returns null', async () => null],
    [
      'throws',
      async () => {
        throw new Error('disk full');
      },
    ],
  ])('reverts the title and says so when main %s', async (_label, failure) => {
    await mount([summary('a', 'Alpha')]);
    renameSession.mockImplementation(failure);

    doubleClickTitle('Alpha');
    typeOver('Omega');
    press('Enter');
    await settle();

    expect(titles()).toEqual(['Alpha']);
    expect(el('chat-rename-error').textContent).toContain('Alpha');
    act(() => el('chat-rename-error').click());
    expect(query('chat-rename-error')).toBeNull();
  });

  it('does not open the session while editing, nor fire the Cmd shortcuts', async () => {
    await mount([summary('a', 'Alpha'), summary('b', 'Beta')]);
    doubleClickTitle('Beta');
    onSelect.mockClear();

    act(() => renameInput().click());
    act(() => renameInput().closest<HTMLElement>('[data-testid="chat-session-item"]')?.click());
    press('1', { code: 'Digit1', metaKey: true });
    press(' ');

    expect(onSelect).not.toHaveBeenCalled();
    expect(query('chat-session-rename-input')).not.toBeNull();
  });

  it('opens the session on a single click when not editing', async () => {
    await mount([summary('a', 'Alpha')]);
    act(() => rowOf('Alpha').click());
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('filters search against the new title straight away', async () => {
    await mount([summary('a', 'Alpha'), summary('b', 'Beta')]);
    renameSession.mockImplementation(() => new Promise(() => {}));
    const search = el('chat-search-input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(search, 'zeta');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(titles()).toEqual([]);

    act(() => {
      setter?.call(search, '');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    doubleClickTitle('Beta');
    typeOver('Zeta');
    press('Enter');
    act(() => {
      setter?.call(search, 'zeta');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(titles()).toEqual(['Zeta']);
  });

  it('renames pinned, archived and project-grouped sessions too', async () => {
    const project = { directory: '/work/widgets', name: 'widgets' } as ChatSessionSummary['project'];
    await mount(
      [
        summary('p', 'Pinned one', { mode: 'code', pinned: true }),
        summary('g', 'Grouped one', { mode: 'code', project }),
        summary('x', 'Archived one', { mode: 'code', archived: true }),
      ],
      'code'
    );
    act(() => el('sidebar-archived-btn').click());
    expect(all('project-group')).toHaveLength(1);

    for (const [id, title] of [
      ['p', 'Pinned one'],
      ['g', 'Grouped one'],
      ['x', 'Archived one'],
    ]) {
      renameFromMenu(title);
      typeOver(`${title} renamed`);
      press('Enter');
      await settle();
      expect(renameSession).toHaveBeenLastCalledWith(id, `${title} renamed`);
    }
  });

  it('redraws only the edited row among hundreds', async () => {
    const many = Array.from({ length: 300 }, (_, index) => summary(`s${index}`, `Session ${index}`));
    await mount(many);

    badgeRenders.count = 0;
    doubleClickTitle('Session 42');
    expect(badgeRenders.count).toBe(1);

    badgeRenders.count = 0;
    typeOver('Renamed');
    press('Enter');
    await settle();
    // The edited row redraws for the optimistic title and again when it is applied; no other row does.
    expect(badgeRenders.count).toBeLessThanOrEqual(3);
  });
});

describe('sessions imported from Claude', () => {
  const origin = { kind: 'claude-code' as const, sourceId: 's', importedAt: 'x', sourceUpdatedAt: 'x' };

  it('join their project group by default', async () => {
    const project = { directory: '/work/widgets', name: 'widgets' } as ChatSessionSummary['project'];
    await mount(
      [
        summary('own', 'My own work', { mode: 'code', project }),
        summary('cc-1', 'Imported work', { mode: 'code', project, importOrigin: origin }),
      ],
      'code'
    );
    expect(query('sidebar-imported')).toBeNull();
    expect(all('project-group')).toHaveLength(1);
    expect(titles()).toEqual(['My own work', 'Imported work']);
    expect(all('session-imported-badge')).toHaveLength(1);
  });
});

describe('sessions imported from Claude, in their own section', () => {
  const origin = { kind: 'claude-code' as const, sourceId: 's', importedAt: 'x', sourceUpdatedAt: 'x' };
  beforeEach(() => setImportedInline(false));
  afterEach(() => setImportedInline(true));
  const typeSearch = (text: string) => {
    const search = el('chat-search-input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(search, text);
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('sit in a collapsed section with a badge, and a search reaches them', async () => {
    await mount([
      summary('own', 'My own chat'),
      summary('cc-1', 'Imported work', { importOrigin: origin }),
      summary('cc-2', 'Continued import', { importOrigin: { ...origin, forkedAt: 'x' } }),
    ]);
    expect(titles()).toEqual(['My own chat', 'Continued import']);
    expect(el('sidebar-imported-toggle-btn').textContent).toContain('Imported from Claude (1)');

    act(() => el('sidebar-imported-toggle-btn').click());
    expect(titles()).toEqual(['My own chat', 'Continued import', 'Imported work']);
    const badges = all('session-imported-badge');
    expect(badges.map(badge => badge.dataset.importForked)).toEqual(['true', 'false']);

    act(() => el('sidebar-imported-toggle-btn').click());
    typeSearch('imported work');
    expect(titles()).toEqual(['Imported work']);
  });

  it('lets the Cmd shortcuts reach imported rows a search has put on screen', async () => {
    await mount([summary('own', 'My own chat'), summary('cc-1', 'Imported work', { importOrigin: origin })]);
    typeSearch('imported');
    onSelect.mockClear();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', code: 'Digit1', metaKey: true, bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith('cc-1');
  });

  it('re-lists once when main says imported sessions changed', async () => {
    let listener: (() => void) | null = null;
    let sessions = [summary('own', 'Mine')];
    await mount([], 'chat', {
      claudeImport: {
        onSessionsChanged: (next: () => void) => {
          listener = next;
          return () => undefined;
        },
      },
    });
    (
      window as unknown as { b4m: { chat: { listSessions: () => Promise<ChatSessionSummary[]> } } }
    ).b4m.chat.listSessions = async () => sessions;
    sessions = [summary('own', 'Mine'), summary('cc-1', 'New import', { importOrigin: origin })];
    await act(async () => listener?.());
    await settle();
    expect(el('sidebar-imported-toggle-btn').textContent).toContain('(1)');
  });
});

describe('sub-sessions an agent spawned', () => {
  const spawned = (id: string, title: string, parentSessionId: string) =>
    summary(id, title, { origin: { parentSessionId, depth: 1, seedPrompt: 'go' } });
  const sessions = () => [
    summary('root', 'Root'),
    spawned('kid-a', 'Kid A', 'root'),
    spawned('kid-b', 'Kid B', 'root'),
    spawned('grandkid', 'Grandkid', 'kid-a'),
  ];
  const depthOf = (title: string) => rowOf(title).closest('li')?.getAttribute('data-nest-depth') ?? null;
  const foldButton = () => el('chat-session-fold-btn');

  afterEach(() => {
    for (const id of [...foldedParents()]) toggleFolded(id);
    setNestingEnabled(true);
  });

  it('draw indented under their parent, which counts them on its fold pill', async () => {
    await mount(sessions());
    expect(titles()).toEqual(['Root', 'Kid A', 'Grandkid', 'Kid B']);
    expect([depthOf('Root'), depthOf('Kid A'), depthOf('Grandkid'), depthOf('Kid B')]).toEqual([null, '1', '2', '1']);
    const pills = all('chat-session-fold-btn');
    expect(pills.map(pill => pill.textContent)).toEqual(['3', '1']);
  });

  it('fold away and come back from the pill, without opening the parent', async () => {
    await mount(sessions());
    act(() => foldButton().click());
    expect(titles()).toEqual(['Root']);
    expect(foldButton().getAttribute('data-folded')).toBe('true');
    expect(onSelect).not.toHaveBeenCalled();

    act(() => foldButton().click());
    expect(titles()).toEqual(['Root', 'Kid A', 'Grandkid', 'Kid B']);
  });

  it('fold and unfold from the keyboard on the parent row', async () => {
    await mount(sessions());
    const key = (key: string) =>
      act(() => {
        rowOf('Root').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });
    key('ArrowLeft');
    expect(titles()).toEqual(['Root']);
    key('ArrowRight');
    expect(titles()).toEqual(['Root', 'Kid A', 'Grandkid', 'Kid B']);
  });

  it('open up under a search so a matching child is never hidden', async () => {
    toggleFolded('root');
    await mount(sessions());
    expect(titles()).toEqual(['Root']);
    const input = el('chat-search-input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, 'Kid');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // The parent does not match, so its children stand on their own rows.
    expect(titles()).toEqual(['Kid A', 'Grandkid', 'Kid B']);
  });

  it('leave the pill inert under a search, where a fold could not show', async () => {
    await mount(sessions());
    const input = el('chat-search-input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, 'Kid');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => foldButton().click());
    expect(foldedParents().has('kid-a')).toBe(false);
    expect(titles()).toEqual(['Kid A', 'Grandkid', 'Kid B']);
  });

  it('unfold the branches holding the open session, and still fold on request', async () => {
    toggleFolded('root');
    await mount(sessions(), 'chat', {}, 'grandkid');
    expect(titles()).toEqual(['Root', 'Kid A', 'Grandkid', 'Kid B']);
    expect(foldedParents().has('root')).toBe(false);

    act(() => all('chat-session-fold-btn')[0].click());
    expect(titles()).toEqual(['Root']);
  });

  it('list flat when the setting is off', async () => {
    setNestingEnabled(false);
    await mount(sessions());
    expect(titles()).toEqual(['Root', 'Kid A', 'Kid B', 'Grandkid']);
    expect(query('chat-session-fold-btn')).toBeNull();
  });
});
