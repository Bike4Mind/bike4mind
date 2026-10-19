// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSessionSummary } from '@shared/chat';
import { normalizeSectionName, type SidebarSectionsState } from '@shared/sidebarSections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { SessionList } from './SessionList';
import { useSidebarSections } from './useSidebarSections';

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

/** Stands in for main's SidebarSectionStore: same answers, kept in memory. */
function fakeSidebarBridge(initial: SidebarSectionsState) {
  let state = initial;
  let nextId = 0;
  const answer = (next: SidebarSectionsState) => {
    state = next;
    return Promise.resolve(state);
  };
  return {
    getSections: vi.fn(() => Promise.resolve(state)),
    createSection: vi.fn((name: string, sessionId?: string) => {
      const id = `new-${++nextId}`;
      return answer({
        sections: [...state.sections, { id, name: normalizeSectionName(name) }],
        assignments: sessionId ? { ...state.assignments, [sessionId]: id } : state.assignments,
      });
    }),
    renameSection: vi.fn((sectionId: string, name: string) =>
      answer({
        ...state,
        sections: state.sections.map(section => (section.id === sectionId ? { ...section, name } : section)),
      })
    ),
    deleteSection: vi.fn((sectionId: string) =>
      answer({
        sections: state.sections.filter(section => section.id !== sectionId),
        assignments: Object.fromEntries(Object.entries(state.assignments).filter(([, id]) => id !== sectionId)),
      })
    ),
    moveSession: vi.fn((sessionId: string, sectionId: string | null) => {
      const { [sessionId]: _previous, ...rest } = state.assignments;
      return answer({ ...state, assignments: sectionId ? { ...rest, [sessionId]: sectionId } : rest });
    }),
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let bridge = fakeSidebarBridge({ sections: [], assignments: {} });
let onCreate = vi.fn<() => void>();
let onDelete = vi.fn<(id: string) => void>();
let onDismissSectionError = vi.fn<() => void>();
let onToggleCollapsed = vi.fn<() => void>();

function Harness({ sessions, sectionError }: { sessions: ChatSessionSummary[]; sectionError?: string | null }) {
  const { sections, actions } = useSidebarSections();
  return (
    <SessionList
      sessions={sessions}
      mode="chat"
      onModeChange={() => {}}
      loading={false}
      activeId={null}
      statuses={new Map()}
      prSummaries={new Map()}
      collapsed={false}
      onToggleCollapsed={onToggleCollapsed}
      onSelect={() => {}}
      onCreate={onCreate}
      onOpenArtifacts={() => {}}
      onCreateInProject={() => {}}
      onDelete={onDelete}
      onTogglePin={() => {}}
      onToggleArchived={() => {}}
      onRename={() => {}}
      userSections={sections}
      sectionActions={actions}
      sectionError={sectionError}
      onDismissSectionError={onDismissSectionError}
    />
  );
}

async function mount(
  sessions: ChatSessionSummary[],
  initial: SidebarSectionsState = { sections: [], assignments: {} },
  sectionError: string | null = null
) {
  bridge = fakeSidebarBridge(initial);
  (window as unknown as { b4m: unknown }).b4m = { sidebar: bridge };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <Harness sessions={sessions} sectionError={sectionError} />
      </CssVarsProvider>
    );
  });
}

const all = (testId: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`));
const el = (testId: string, scope: ParentNode = document) => {
  const found = scope.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`no ${testId}`);
  return found;
};
const query = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const settle = () => act(async () => undefined);
const click = async (node: HTMLElement) => {
  act(() => node.click());
  await settle();
};

const sectionNamed = (name: string) => {
  const section = all('sidebar-section').find(node => el('sidebar-section-name', node).textContent === name);
  if (!section) throw new Error(`no section ${name}`);
  return section;
};
const titlesIn = (scope: ParentNode) => all('chat-session-title-text', scope).map(node => node.textContent);
const looseTitles = () =>
  all('chat-session-title-text')
    .filter(node => !node.closest('[data-testid="sidebar-section"]'))
    .map(node => node.textContent);

const rightClick = (node: HTMLElement) =>
  act(() => {
    node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 300 }));
  });

const openRowMenu = async (title: string) => {
  const row = all('chat-session-item').find(item => item.textContent === title);
  await click(el('chat-session-menu-btn', row?.closest('li') ?? document));
};

const openMoveTo = async (title: string) => {
  await openRowMenu(title);
  await click(el('chat-move-session-btn'));
};

function typeName(text: string) {
  const input = el('section-name-input') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const workAndHome: SidebarSectionsState = {
  sections: [
    { id: 'work', name: 'Work' },
    { id: 'home', name: 'Home' },
  ],
  assignments: { a: 'work' },
};

beforeEach(() => {
  onCreate = vi.fn();
  onDelete = vi.fn();
  onDismissSectionError = vi.fn();
  onToggleCollapsed = vi.fn();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('the sidebar context menu', () => {
  it('opens on a right-click in empty space with New session and New section', async () => {
    await mount([summary('a', 'Alpha')]);

    rightClick(el('sidebar-session-scroll'));
    await settle();

    expect(query('sidebar-context-new-session-btn')).not.toBeNull();
    expect(query('sidebar-context-new-section-btn')).not.toBeNull();
    await click(el('sidebar-context-new-session-btn'));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('leaves a right-click on a session row alone', async () => {
    await mount([summary('a', 'Alpha')]);

    rightClick(el('chat-session-item'));
    await settle();

    expect(query('sidebar-context-new-section-btn')).toBeNull();
  });

  it('creates an empty, named section from New section', async () => {
    await mount([summary('a', 'Alpha')]);

    rightClick(el('sidebar-session-scroll'));
    await settle();
    await click(el('sidebar-context-new-section-btn'));
    expect((el('section-name-submit-btn') as HTMLButtonElement).disabled).toBe(true);
    typeName('  Side   projects ');
    await click(el('section-name-submit-btn'));

    expect(bridge.createSection).toHaveBeenCalledWith('Side projects', undefined);
    expect(query('section-name-dialog')).toBeNull();
    const section = sectionNamed('Side projects');
    // An empty section is its header alone; nothing under it that could pass for a row.
    expect(query('sidebar-section-drop-zone')).toBeNull();
    expect(titlesIn(section)).toEqual([]);
    expect(looseTitles()).toEqual(['Alpha']);
  });

  it('closes the section-name dialog on Escape without creating anything', async () => {
    await mount([summary('a', 'Alpha')]);

    rightClick(el('sidebar-session-scroll'));
    await settle();
    await click(el('sidebar-context-new-section-btn'));
    typeName('Work');
    await act(async () => {
      el('section-name-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(query('section-name-dialog')).toBeNull();
    expect(bridge.createSection).not.toHaveBeenCalled();
  });
  it('keeps window shortcuts from firing behind the dialog when a button has focus', async () => {
    await mount([summary('a', 'Alpha')]);

    rightClick(el('sidebar-session-scroll'));
    await settle();
    await click(el('sidebar-context-new-section-btn'));
    await act(async () => {
      el('section-name-cancel-btn').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true, cancelable: true })
      );
    });

    expect(onToggleCollapsed).not.toHaveBeenCalled();
    expect(query('section-name-dialog')).not.toBeNull();
  });

  it('caps a long name by code point after collapsing whitespace, not while typing', async () => {
    await mount([summary('a', 'Alpha')]);
    const emoji = '\u{1F600}'.repeat(40);

    rightClick(el('sidebar-session-scroll'));
    await settle();
    await click(el('sidebar-context-new-section-btn'));
    typeName(`${emoji}${' '.repeat(30)}${'x'.repeat(30)}`);
    await click(el('section-name-submit-btn'));

    expect(bridge.createSection).toHaveBeenCalledWith(`${emoji} ${'x'.repeat(19)}`, undefined);
  });
});

describe('moving a session from its menu', () => {
  it('lists every section with a check on the current one, and Remove from it', async () => {
    await mount([summary('a', 'Alpha'), summary('b', 'Beta')], workAndHome);

    await openMoveTo('Alpha');

    const targets = all('chat-move-to-section-btn');
    expect(targets.map(node => node.textContent)).toEqual(['Work', 'Home']);
    // The check is the only glyph a section entry draws.
    expect(targets.map(node => node.querySelector('svg') !== null)).toEqual([true, false]);
    expect(el('chat-move-remove-btn').textContent).toBe('Remove from Work');
  });

  it('offers no Remove for a session in no section', async () => {
    await mount([summary('b', 'Beta')], workAndHome);

    await openMoveTo('Beta');

    expect(query('chat-move-remove-btn')).toBeNull();
    expect(query('chat-move-new-section-btn')).not.toBeNull();
  });

  it('moves the row under the section it was moved to', async () => {
    await mount([summary('a', 'Alpha'), summary('b', 'Beta')], workAndHome);

    await openMoveTo('Beta');
    await click(all('chat-move-to-section-btn').find(node => node.textContent === 'Home') ?? el('missing'));

    expect(bridge.moveSession).toHaveBeenCalledWith('b', 'home');
    expect(titlesIn(sectionNamed('Home'))).toEqual(['Beta']);
    expect(looseTitles()).toEqual([]);
  });

  it('returns the row to the default list on Remove from', async () => {
    await mount([summary('a', 'Alpha'), summary('b', 'Beta')], workAndHome);

    await openMoveTo('Alpha');
    await click(el('chat-move-remove-btn'));

    expect(bridge.moveSession).toHaveBeenCalledWith('a', null);
    expect(titlesIn(sectionNamed('Work'))).toEqual([]);
    expect(looseTitles()).toEqual(['Alpha', 'Beta']);
  });

  it('creates a section with the session already in it from New section', async () => {
    await mount([summary('a', 'Alpha'), summary('b', 'Beta')]);

    await openMoveTo('Beta');
    await click(el('chat-move-new-section-btn'));
    typeName('Later');
    await click(el('section-name-submit-btn'));

    expect(bridge.createSection).toHaveBeenCalledWith('Later', 'b');
    expect(titlesIn(sectionNamed('Later'))).toEqual(['Beta']);
    expect(looseTitles()).toEqual(['Alpha']);
  });

  it('goes back to the main items, and opens on them again next time', async () => {
    await mount([summary('a', 'Alpha')], workAndHome);

    await openMoveTo('Alpha');
    await click(el('chat-move-back-btn'));
    expect(query('chat-pin-session-btn')).not.toBeNull();

    // Shut while on the Move to items, by the same button that opened it.
    await click(el('chat-move-session-btn'));
    expect(query('chat-move-back-btn')).not.toBeNull();
    await openRowMenu('Alpha');
    expect(query('chat-move-back-btn')).toBeNull();

    await openRowMenu('Alpha');
    expect(query('chat-pin-session-btn')).not.toBeNull();
  });
});

describe("a section's own menu", () => {
  it('renames the section', async () => {
    await mount([summary('a', 'Alpha')], workAndHome);

    await click(el('sidebar-section-menu-btn', sectionNamed('Work')));
    await click(el('sidebar-section-rename-btn'));
    expect((el('section-name-input') as HTMLInputElement).value).toBe('Work');
    // An unchanged name is not a rename.
    expect((el('section-name-submit-btn') as HTMLButtonElement).disabled).toBe(true);
    typeName('Day job');
    await click(el('section-name-submit-btn'));

    expect(bridge.renameSection).toHaveBeenCalledWith('work', 'Day job');
    expect(titlesIn(sectionNamed('Day job'))).toEqual(['Alpha']);
  });

  it('deletes the section and puts its sessions back, deleting none of them', async () => {
    await mount([summary('a', 'Alpha'), summary('b', 'Beta')], workAndHome);

    await click(el('sidebar-section-menu-btn', sectionNamed('Work')));
    await click(el('sidebar-section-delete-btn'));

    expect(bridge.deleteSection).toHaveBeenCalledWith('work');
    expect(all('sidebar-section-name').map(node => node.textContent)).toEqual(['Home']);
    expect(looseTitles()).toEqual(['Alpha', 'Beta']);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('cancels a rename without changing anything', async () => {
    await mount([summary('a', 'Alpha')], workAndHome);

    await click(el('sidebar-section-menu-btn', sectionNamed('Work')));
    await click(el('sidebar-section-rename-btn'));
    typeName('Nope');
    await click(el('section-name-cancel-btn'));

    expect(bridge.renameSection).not.toHaveBeenCalled();
    expect(query('section-name-dialog')).toBeNull();
    expect(sectionNamed('Work')).toBeTruthy();
  });
});

/** jsdom has no DataTransfer; this keeps the parts the sidebar reads. */
function fakeDataTransfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: 'all',
    dropEffect: 'none',
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
  };
}

type FakeTransfer = ReturnType<typeof fakeDataTransfer>;

/** Fires a drag event the way the browser would, returning whether a handler accepted it. */
function fireDrag(node: HTMLElement, type: string, dataTransfer: FakeTransfer) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  act(() => {
    node.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

/** Lets the frame the sidebar waits for before opening its drop slots go by. */
const nextFrame = () => act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));

const rowNamed = (title: string) => {
  const row = all('chat-session-item').find(item => item.textContent === title);
  if (!row) throw new Error(`no row ${title}`);
  return row;
};

/** Picks a row up, drags it over a target and drops it there, as one gesture. */
async function dragRowOnto(title: string, target: HTMLElement) {
  const transfer = fakeDataTransfer();
  const row = rowNamed(title);
  fireDrag(row, 'dragstart', transfer);
  await nextFrame();
  const accepted = fireDrag(target, 'dragover', transfer);
  fireDrag(target, 'drop', transfer);
  fireDrag(row, 'dragend', transfer);
  await settle();
  return accepted;
}

describe('dragging a session', () => {
  it('moves a row dropped on a section into it', async () => {
    await mount([summary('a', 'Alpha'), summary('b', 'Beta')], workAndHome);

    const accepted = await dragRowOnto('Beta', el('sidebar-section-header', sectionNamed('Home')));

    expect(accepted).toBe(true);
    expect(bridge.moveSession).toHaveBeenCalledWith('b', 'home');
    expect(titlesIn(sectionNamed('Home'))).toEqual(['Beta']);
  });

  it('moves a row between sections', async () => {
    await mount([summary('a', 'Alpha')], workAndHome);

    await dragRowOnto('Alpha', el('sidebar-section-header', sectionNamed('Home')));

    expect(bridge.moveSession).toHaveBeenCalledWith('a', 'home');
    expect(titlesIn(sectionNamed('Work'))).toEqual([]);
    expect(titlesIn(sectionNamed('Home'))).toEqual(['Alpha']);
  });

  it('marks the section under the pointer, and clears it when the drag ends', async () => {
    await mount([summary('b', 'Beta')], workAndHome);
    const transfer = fakeDataTransfer();

    fireDrag(rowNamed('Beta'), 'dragstart', transfer);
    await nextFrame();
    fireDrag(sectionNamed('Home'), 'dragover', transfer);
    expect(sectionNamed('Home').dataset.dropTarget).toBe('true');
    expect(sectionNamed('Work').dataset.dropTarget).toBeUndefined();

    fireDrag(rowNamed('Beta'), 'dragend', transfer);
    expect(sectionNamed('Home').dataset.dropTarget).toBeUndefined();
  });

  it('opens a drop slot in empty sections only while a row is dragged', async () => {
    await mount([summary('a', 'Alpha'), summary('b', 'Beta')], workAndHome);
    const transfer = fakeDataTransfer();
    expect(query('sidebar-section-drop-zone')).toBeNull();

    fireDrag(rowNamed('Beta'), 'dragstart', transfer);
    await nextFrame();
    // Home is empty; Work already has a row to drop onto.
    expect(
      all('sidebar-section-drop-zone').map(
        zone => zone.closest<HTMLElement>('[data-testid="sidebar-section"]')?.dataset.sectionId
      )
    ).toEqual(['home']);

    const accepted = fireDrag(el('sidebar-section-drop-zone'), 'dragover', transfer);
    fireDrag(el('sidebar-section-drop-zone'), 'drop', transfer);
    fireDrag(rowNamed('Beta'), 'dragend', transfer);
    await settle();

    expect(accepted).toBe(true);
    expect(bridge.moveSession).toHaveBeenCalledWith('b', 'home');
    expect(query('sidebar-section-drop-zone')).toBeNull();
  });

  it('opens no drop slots for a drag that ended before its first frame', async () => {
    await mount([summary('b', 'Beta')], workAndHome);
    const transfer = fakeDataTransfer();

    fireDrag(rowNamed('Beta'), 'dragstart', transfer);
    fireDrag(rowNamed('Beta'), 'dragend', transfer);
    await nextFrame();

    expect(query('sidebar-section-drop-zone')).toBeNull();
  });

  it('takes a row out of its section when dropped on the list outside every section', async () => {
    await mount([summary('a', 'Alpha'), summary('b', 'Beta')], workAndHome);

    const accepted = await dragRowOnto('Alpha', rowNamed('Beta'));

    expect(accepted).toBe(true);
    expect(bridge.moveSession).toHaveBeenCalledWith('a', null);
    expect(looseTitles()).toEqual(['Alpha', 'Beta']);
  });

  it('offers the list as no target to a row that is in no section', async () => {
    await mount([summary('a', 'Alpha'), summary('b', 'Beta')], workAndHome);

    const accepted = await dragRowOnto('Beta', rowNamed('Beta'));

    expect(accepted).toBe(false);
    expect(el('sidebar-session-scroll').dataset.dropTarget).toBeUndefined();
    expect(bridge.moveSession).not.toHaveBeenCalled();
  });

  it('clears a section highlight when a row in no section moves on to the list', async () => {
    await mount([summary('a', 'Alpha'), summary('b', 'Beta')], workAndHome);
    const transfer = fakeDataTransfer();
    const row = rowNamed('Beta');
    fireDrag(row, 'dragstart', transfer);
    await nextFrame();

    fireDrag(sectionNamed('Work'), 'dragover', transfer);
    await settle();
    expect(sectionNamed('Work').dataset.dropTarget).toBe('true');

    expect(fireDrag(rowNamed('Beta'), 'dragover', transfer)).toBe(false);
    await settle();
    expect(sectionNamed('Work').dataset.dropTarget).toBeUndefined();
    fireDrag(row, 'dragend', transfer);
  });

  it('does nothing when a row is dropped back on its own section', async () => {
    await mount([summary('a', 'Alpha')], workAndHome);

    await dragRowOnto('Alpha', sectionNamed('Work'));

    expect(bridge.moveSession).not.toHaveBeenCalled();
  });

  it('ignores a drag that is not a session row', async () => {
    await mount([summary('a', 'Alpha')], workAndHome);
    const transfer = fakeDataTransfer();
    transfer.setData('text/plain', 'a');

    expect(fireDrag(sectionNamed('Home'), 'dragover', transfer)).toBe(false);
    fireDrag(sectionNamed('Home'), 'drop', transfer);
    await settle();

    expect(bridge.moveSession).not.toHaveBeenCalled();
  });

  it('cannot pick up a row while it is being renamed', async () => {
    await mount([summary('a', 'Alpha')], workAndHome);

    expect(rowNamed('Alpha').getAttribute('draggable')).toBe('true');
    await openRowMenu('Alpha');
    await click(el('chat-rename-session-btn'));

    expect(el('chat-session-item').getAttribute('draggable')).toBe('false');
  });

  it('clears the drag state on a drop even when dragend never arrives', async () => {
    await mount([summary('a', 'Alpha'), summary('b', 'Beta')], workAndHome);
    const transfer = fakeDataTransfer();

    fireDrag(rowNamed('Beta'), 'dragstart', transfer);
    await nextFrame();
    expect(query('sidebar-section-drop-zone')).not.toBeNull();
    fireDrag(el('sidebar-section-drop-zone'), 'dragover', transfer);
    fireDrag(el('sidebar-section-drop-zone'), 'drop', transfer);
    await settle();

    expect(bridge.moveSession).toHaveBeenCalledWith('b', 'home');
    expect(query('sidebar-section-drop-zone')).toBeNull();
    expect(sectionNamed('Home').dataset.dropTarget).toBeUndefined();
  });

  it('does not let a frame pending at drop time re-open the drop slots', async () => {
    await mount([summary('a', 'Alpha'), summary('b', 'Beta')], workAndHome);
    const transfer = fakeDataTransfer();

    fireDrag(rowNamed('Beta'), 'dragstart', transfer);
    fireDrag(sectionNamed('Home'), 'dragover', transfer);
    fireDrag(sectionNamed('Home'), 'drop', transfer);
    await nextFrame();

    expect(query('sidebar-section-drop-zone')).toBeNull();
  });

  it('does not pick up a pinned row for a section', async () => {
    await mount([summary('a', 'Alpha'), summary('p', 'Pinned one', { pinned: true })], workAndHome);
    const transfer = fakeDataTransfer();

    const row = rowNamed('Pinned one');
    fireDrag(row, 'dragstart', transfer);
    await nextFrame();
    expect(query('sidebar-section-drop-zone')).toBeNull();
    const accepted = fireDrag(el('sidebar-section-header', sectionNamed('Home')), 'dragover', transfer);
    fireDrag(el('sidebar-section-header', sectionNamed('Home')), 'drop', transfer);
    fireDrag(row, 'dragend', transfer);
    await settle();

    expect(accepted).toBe(false);
    expect(sectionNamed('Home').dataset.dropTarget).toBeUndefined();
    expect(bridge.moveSession).not.toHaveBeenCalled();
  });
});

describe('Move to for rows outside the sections', () => {
  it('is not offered for a pinned row', async () => {
    await mount([summary('a', 'Alpha'), summary('p', 'Pinned one', { pinned: true })], workAndHome);

    await openRowMenu('Pinned one');

    expect(query('chat-pin-session-btn')).not.toBeNull();
    expect(query('chat-move-session-btn')).toBeNull();
  });

  it('is not offered for an archived row', async () => {
    await mount([summary('a', 'Alpha'), summary('z', 'Old one', { archived: true })], workAndHome);

    await click(el('sidebar-archived-btn'));
    await openRowMenu('Old one');

    expect(query('chat-pin-session-btn')).not.toBeNull();
    expect(query('chat-move-session-btn')).toBeNull();
  });
});

describe('searching with sections', () => {
  const search = async (text: string) => {
    const input = el('chat-search-input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
  };

  it('hides sections with no matching session, and shows them again when cleared', async () => {
    await mount([summary('a', 'Alpha'), summary('b', 'Beta')], workAndHome);
    expect(all('sidebar-section-name').map(node => node.textContent)).toEqual(['Work', 'Home']);

    await search('alp');
    expect(all('sidebar-section-name').map(node => node.textContent)).toEqual(['Work']);

    await search('zzz');
    expect(all('sidebar-section')).toEqual([]);
    expect(query('chat-sessions-empty')).not.toBeNull();

    await search('');
    expect(all('sidebar-section-name').map(node => node.textContent)).toEqual(['Work', 'Home']);
  });
});

describe('sections in the other mode', () => {
  it('does not count a code-only section as content in chat mode', async () => {
    await mount([summary('c1', 'Code work', { mode: 'code' })], {
      sections: [{ id: 'code-only', name: 'Code only' }],
      assignments: { c1: 'code-only' },
    });

    expect(query('chat-sessions-empty')).not.toBeNull();
    expect(all('sidebar-section')).toHaveLength(0);
  });
});

describe('a failed section change', () => {
  it('shows the error and dismisses it on click', async () => {
    await mount([summary('a', 'Alpha')], undefined, 'Could not save that section change.');

    expect(el('chat-section-error').textContent).toBe('Could not save that section change.');
    await click(el('chat-section-error'));

    expect(onDismissSectionError).toHaveBeenCalledTimes(1);
  });

  it('shows nothing without an error', async () => {
    await mount([summary('a', 'Alpha')]);

    expect(query('chat-section-error')).toBeNull();
  });
});
