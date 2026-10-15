import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import { registerSidebarIpc } from './sidebarIpc';
import type { SidebarSectionStore } from './SidebarSectionStore';

const current = { sections: [{ id: 's1', name: 'Work' }], assignments: {} };

function setup() {
  const store = {
    read: vi.fn(() => Promise.resolve(current)),
    create: vi.fn(() => Promise.resolve(current)),
    rename: vi.fn(() => Promise.resolve(current)),
    remove: vi.fn(() => Promise.resolve(current)),
    move: vi.fn(() => Promise.resolve(current)),
  };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerSidebarIpc(
    { handle: (channel: string, listener: (...args: never[]) => unknown) => void handlers.set(channel, listener as never) },
    store as unknown as SidebarSectionStore
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
});
