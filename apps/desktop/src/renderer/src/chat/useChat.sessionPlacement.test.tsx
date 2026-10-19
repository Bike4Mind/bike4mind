// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatSessionSummary, CreateCodeSessionResult, CreatedSession } from '@shared/chat';
import type { SidebarSectionsState } from '@shared/sidebarSections';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupSessions } from './grouping';
import { useSessions, type SessionsController } from './useChat';
import { useSidebarSections } from './useSidebarSections';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const summary = (id: string, extra: Partial<ChatSessionSummary> = {}) =>
  ({
    id,
    title: id,
    mode: 'chat',
    messageCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  }) as ChatSessionSummary;

const work: SidebarSectionsState = { sections: [{ id: 'work', name: 'Work' }], assignments: {} };
const placed: SidebarSectionsState = { ...work, assignments: { fresh: 'work' } };

let root: Root | null = null;
let host: HTMLElement | null = null;

/** Where the new row sat on every render, so a single frame in the default list is caught. */
type Placement = 'absent' | 'loose' | 'work';

async function mount(chat: { createSession?: unknown; createCodeSession?: unknown }) {
  (window as unknown as { b4m: unknown }).b4m = {
    chat: {
      listSessions: vi.fn(() => Promise.resolve([summary('old')])),
      onSessionSummary: vi.fn(() => () => {}),
      ...chat,
    },
    sidebar: { getSections: vi.fn(() => Promise.resolve(work)) },
  };
  const seen: Placement[] = [];
  let controller: SessionsController | null = null;
  let adopt: ((state: SidebarSectionsState) => void) | null = null;

  function Harness() {
    const sessions = useSessions();
    const sidebar = useSidebarSections();
    controller = sessions;
    adopt = sidebar.adopt;
    const groups = groupSessions(sessions.sessions, 'chat', sidebar.sections);
    const inWork = groups.custom.some(group => group.sessions.some(session => session.id === 'fresh'));
    const loose = groups.loose.some(session => session.id === 'fresh');
    seen.push(inWork ? 'work' : loose ? 'loose' : 'absent');
    return null;
  }

  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Harness />));

  const start = async (
    create: (sessions: SessionsController, placed: (state: SidebarSectionsState) => void) => unknown
  ) => {
    if (!controller || !adopt) throw new Error('not mounted');
    const target = controller;
    const place = adopt;
    let id: unknown;
    await act(async () => {
      id = await create(target, place);
    });
    return id;
  };
  return { seen, start };
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('starting a session in a sidebar section', () => {
  it('draws a new Chat session inside its section from its first render', async () => {
    const createSession = vi.fn((): Promise<CreatedSession> =>
      Promise.resolve({ session: summary('fresh'), sidebarSections: placed })
    );
    const { seen, start } = await mount({ createSession });

    const id = await start((sessions, place) => sessions.create({ sectionId: 'work', placed: place }));

    expect(id).toBe('fresh');
    expect(createSession).toHaveBeenCalledWith({ sectionId: 'work' });
    expect(seen.at(-1)).toBe('work');
    expect(seen).not.toContain('loose');
  });

  it('draws a new Code session inside its section from its first render', async () => {
    const createCodeSession = vi.fn((): Promise<CreateCodeSessionResult> =>
      Promise.resolve({ ok: true, session: summary('fresh', { mode: 'code' }), sidebarSections: placed })
    );
    const { start } = await mount({ createCodeSession });

    await start((sessions, place) => sessions.createCode({}, { sectionId: 'work', placed: place }));

    expect(createCodeSession).toHaveBeenCalledWith({ sectionId: 'work' });
  });

  it('asks for no section and adds the row to the default list from plain New', async () => {
    const createSession = vi.fn((): Promise<CreatedSession> => Promise.resolve({ session: summary('fresh') }));
    const { seen, start } = await mount({ createSession });

    await start(sessions => sessions.create());

    expect(createSession).toHaveBeenCalledWith(undefined);
    expect(seen.at(-1)).toBe('loose');
  });

  it('falls back to the default list when main could not save the placement', async () => {
    const createSession = vi.fn((): Promise<CreatedSession> => Promise.resolve({ session: summary('fresh') }));
    const placedSpy = vi.fn();
    const { seen, start } = await mount({ createSession });

    await start(sessions => sessions.create({ sectionId: 'work', placed: placedSpy }));

    expect(placedSpy).not.toHaveBeenCalled();
    expect(seen.at(-1)).toBe('loose');
  });
});
