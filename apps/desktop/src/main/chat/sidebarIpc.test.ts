import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import { SIDEBAR_SESSION_ID_MAX_LENGTH } from '@shared/sidebarSections';
import { placeNewSession, registerSidebarIpc } from './sidebarIpc';
import type { SidebarSectionStore } from './SidebarSectionStore';

const current = { sections: [{ id: 's1', name: 'Work' }], assignments: {} };

function setup(known: (sessionId: string) => boolean = () => true) {
  const store = {
    read: vi.fn(() => Promise.resolve(current)),
    create: vi.fn(() => Promise.resolve(current)),
    rename: vi.fn(() => Promise.resolve(current)),
    remove: vi.fn(() => Promise.resolve(current)),
    move: vi.fn(() => Promise.resolve(current)),
  };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerSidebarIpc(
    {
      handle: (channel: string, listener: (...args: never[]) => unknown) =>
        void handlers.set(channel, listener as never),
    },
    store as unknown as SidebarSectionStore,
    sessionId => Promise.resolve(known(sessionId))
  );
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);
  return { store, call };
}

describe('sidebar IPC handlers', () => {
  it('answers a non-string argument with the current state and writes nothing', async () => {
    const { store, call } = setup();

    const answers = await Promise.all([
      call(IPC_CHANNELS.sidebarCreateSection, 42),
      call(IPC_CHANNELS.sidebarRenameSection, 'a', {}),
      call(IPC_CHANNELS.sidebarRenameSection, null, 'x'),
      call(IPC_CHANNELS.sidebarDeleteSection, 7),
      call(IPC_CHANNELS.sidebarMoveSession, 1, 'a'),
      call(IPC_CHANNELS.sidebarMoveSession, 'a', 5),
    ]);

    expect(answers).toEqual(answers.map(() => current));
    expect(store.create).not.toHaveBeenCalled();
    expect(store.rename).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
    expect(store.move).not.toHaveBeenCalled();
    expect(store.read).toHaveBeenCalledTimes(answers.length);
  });

  it('passes valid arguments through, including a null section on move', async () => {
    const { store, call } = setup();

    await call(IPC_CHANNELS.sidebarCreateSection, 'Work', 5);
    await call(IPC_CHANNELS.sidebarMoveSession, 'a', null);

    expect(store.create).toHaveBeenCalledWith('Work', undefined);
    expect(store.move).toHaveBeenCalledWith('a', null);
  });

  it('refuses a session id over the length cap', async () => {
    const { store, call } = setup();
    const long = 'x'.repeat(SIDEBAR_SESSION_ID_MAX_LENGTH + 1);

    expect(await call(IPC_CHANNELS.sidebarMoveSession, long, 's1')).toBe(current);
    await call(IPC_CHANNELS.sidebarCreateSection, 'Work', long);

    expect(store.move).not.toHaveBeenCalled();
    expect(store.create).toHaveBeenCalledWith('Work', undefined);
  });
  it('assigns only sessions that exist, but still lets any id leave its section', async () => {
    const { store, call } = setup(sessionId => sessionId === 'real');

    expect(await call(IPC_CHANNELS.sidebarMoveSession, 'made-up', 's1')).toBe(current);
    await call(IPC_CHANNELS.sidebarCreateSection, 'Work', 'made-up');
    await call(IPC_CHANNELS.sidebarMoveSession, 'made-up', null);
    await call(IPC_CHANNELS.sidebarMoveSession, 'real', 's1');

    expect(store.create).toHaveBeenCalledWith('Work', undefined);
    expect(store.move.mock.calls).toEqual([
      ['made-up', null],
      ['real', 's1'],
    ]);
  });
});

describe('placeNewSession', () => {
  it('moves the new session into the section asked for and answers the state', async () => {
    const placed = { sections: current.sections, assignments: { fresh: 's1' } };
    const store = { move: vi.fn(() => Promise.resolve(placed)) };
    const onError = vi.fn();

    await expect(placeNewSession(store, 'fresh', 's1', onError)).resolves.toBe(placed);

    expect(store.move).toHaveBeenCalledWith('fresh', 's1');
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 42, {}])('writes nothing when the section is %j', async sectionId => {
    const store = { move: vi.fn(() => Promise.resolve(current)) };

    await expect(placeNewSession(store, 'fresh', sectionId, vi.fn())).resolves.toBeUndefined();

    expect(store.move).not.toHaveBeenCalled();
  });

  it('reports a failed write and answers no state, so the create still succeeds', async () => {
    const failure = new Error('disk full');
    const store = { move: vi.fn(() => Promise.reject(failure)) };
    const onError = vi.fn();

    await expect(placeNewSession(store, 'fresh', 's1', onError)).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(failure);
  });
});
