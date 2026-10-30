// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatSessionMode, ChatSessionSummary, ChatStreamEvent, CreateCodeSessionResult } from '@shared/chat';
import type { CreatedSession } from '@shared/ipc';
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

async function mount(
  chat: { createSession?: unknown; createCodeSession?: unknown; listSessions?: unknown; onStreamEvent?: unknown },
  mode: ChatSessionMode = 'chat'
) {
  (window as unknown as { b4m: unknown }).b4m = {
    chat: {
      listSessions: vi.fn(() => Promise.resolve([summary('old')])),
      onSessionSummary: vi.fn(() => () => {}),
      onStreamEvent: vi.fn(() => () => {}),
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
    const groups = groupSessions(sessions.sessions, mode, sidebar.sections);
    const inWork = groups.custom.some(group => group.sessions.some(session => session.id === 'fresh'));
    const loose = groups.loose.some(session => session.id === 'fresh');
    seen.push(inWork ? 'work' : loose ? 'loose' : 'absent');
    return null;
  }

  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Harness />));

  /** The failure channel every placement in these tests gets, so a silent one is caught. */
  const failed = vi.fn();
  const start = async (
    create: (sessions: SessionsController, placed: (state: SidebarSectionsState) => void, failed: () => void) => unknown
  ) => {
    if (!controller || !adopt) throw new Error('not mounted');
    const target = controller;
    const place = adopt;
    let id: unknown;
    await act(async () => {
      id = await create(target, place, failed);
    });
    return id;
  };
  return { seen, start, failed, controller: () => controller };
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('starting a session in a sidebar section', () => {
  it('drops a failed spawned session after its final status listing still contained it', async () => {
    let listener: ((event: ChatStreamEvent) => void) | undefined;
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce([summary('old'), summary('failed')])
      .mockResolvedValue([summary('old')]);
    const { controller } = await mount({
      listSessions,
      onStreamEvent: (callback: (event: ChatStreamEvent) => void) => {
        listener = callback;
        return () => {};
      },
    });
    expect(controller()?.sessions.map(session => session.id)).toContain('failed');

    await act(async () => {
      listener?.({ type: 'spawn-failed', sessionId: 'old', title: 'failed', message: 'Could not cut worktree' });
    });

    expect(controller()?.sessions.map(session => session.id)).toEqual(['old']);
  });
  it('draws a new Chat session inside its section from its first render', async () => {
    const createSession = vi.fn((): Promise<CreatedSession> =>
      Promise.resolve({ session: summary('fresh'), sidebarSections: placed })
    );
    const { seen, start, failed } = await mount({ createSession });

    const id = await start((sessions, place, failure) =>
      sessions.create({ sectionId: 'work', placed: place, failed: failure })
    );

    expect(id).toBe('fresh');
    expect(createSession).toHaveBeenCalledWith({ sectionId: 'work' });
    expect(seen.at(-1)).toBe('work');
    expect(seen).not.toContain('loose');
    expect(failed).not.toHaveBeenCalled();
  });

  it('draws a new Code session inside its section from its first render', async () => {
    const createCodeSession = vi.fn((): Promise<CreateCodeSessionResult> =>
      Promise.resolve({ ok: true, session: summary('fresh', { mode: 'code' }), sidebarSections: placed })
    );
    const { seen, start } = await mount({ createCodeSession }, 'code');

    await start((sessions, place, failure) =>
      sessions.createCode({}, { sectionId: 'work', placed: place, failed: failure })
    );

    expect(createCodeSession).toHaveBeenCalledWith({ sectionId: 'work' });
    expect(seen.at(-1)).toBe('work');
    expect(seen).not.toContain('loose');
  });

  it('asks for no section and adds the row to the default list from plain New', async () => {
    const createSession = vi.fn((): Promise<CreatedSession> => Promise.resolve({ session: summary('fresh') }));
    const { seen, start } = await mount({ createSession });

    await start(sessions => sessions.create());

    expect(createSession).toHaveBeenCalledWith(undefined);
    expect(seen.at(-1)).toBe('loose');
  });

  it('falls back to the default list when main could not save the placement', async () => {
    const createSession = vi.fn((): Promise<CreatedSession> =>
      Promise.resolve({ session: summary('fresh'), placementFailed: true })
    );
    const placedSpy = vi.fn();
    const { seen, start, failed } = await mount({ createSession });

    await start((sessions, _place, failure) =>
      sessions.create({ sectionId: 'work', placed: placedSpy, failed: failure })
    );

    expect(placedSpy).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalled();
    expect(seen.at(-1)).toBe('loose');
  });

  it('reports a refused Code session and places nothing', async () => {
    const createCodeSession = vi.fn((): Promise<CreateCodeSessionResult> =>
      Promise.resolve({ ok: false, error: 'no worktree' })
    );
    const placedSpy = vi.fn();
    const { seen, start, failed, controller } = await mount({ createCodeSession });

    const id = await start((sessions, _place, failure) =>
      sessions.createCode({}, { sectionId: 'work', placed: placedSpy, failed: failure })
    );

    expect(id).toBeNull();
    expect(controller()?.codeError).toBe('no worktree');
    expect(placedSpy).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(seen.at(-1)).toBe('absent');
  });
});
