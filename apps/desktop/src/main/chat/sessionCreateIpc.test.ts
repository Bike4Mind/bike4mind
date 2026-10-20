import { describe, expect, it, vi } from 'vitest';
import type { ChatSessionSummary, CreateCodeSessionResult } from '@shared/chat';
import { IPC_CHANNELS } from '@shared/ipc';
import { registerSessionCreateIpc, type SessionCreation } from './sessionCreateIpc';

const created = { id: 'fresh', title: 'fresh' } as ChatSessionSummary;
const placed = { sections: [{ id: 's1', name: 'Work' }], assignments: { fresh: 's1' } };

function setup(overrides: Partial<SessionCreation> = {}) {
  const creation: SessionCreation = {
    createSession: vi.fn(() => Promise.resolve(created)),
    createCodeSession: vi.fn((): Promise<CreateCodeSessionResult> => Promise.resolve({ ok: true, session: created })),
    place: vi.fn(() => Promise.resolve({ sections: placed, failed: false })),
    rememberFolder: vi.fn(),
    ...overrides,
  };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerSessionCreateIpc(
    {
      handle: (channel: string, listener: (...args: never[]) => unknown) =>
        void handlers.set(channel, listener as never),
    },
    creation
  );
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);
  return { creation, call };
}

describe('session create IPC handlers', () => {
  it('files a new Chat session in the requested section and answers the sidebar state', async () => {
    const { creation, call } = setup();

    await expect(call(IPC_CHANNELS.chatCreateSession, { sectionId: 's1' })).resolves.toEqual({
      session: created,
      sidebarSections: placed,
    });

    expect(creation.place).toHaveBeenCalledWith('fresh', 's1');
  });

  it('files a new Code session in the requested section and answers the sidebar state', async () => {
    const { creation, call } = setup();

    await expect(call(IPC_CHANNELS.chatCreateCodeSession, { sectionId: 's1' })).resolves.toEqual({
      ok: true,
      session: created,
      sidebarSections: placed,
    });

    expect(creation.place).toHaveBeenCalledWith('fresh', 's1');
  });

  it('creates a Chat session without a section when none is asked for', async () => {
    const { creation, call } = setup();

    await call(IPC_CHANNELS.chatCreateSession);

    expect(creation.place).toHaveBeenCalledWith('fresh', undefined);
  });

  it('passes a refused Code session through and files nothing', async () => {
    const refusal: CreateCodeSessionResult = { ok: false, error: 'no worktree' };
    const { creation, call } = setup({ createCodeSession: vi.fn(() => Promise.resolve(refusal)) });

    await expect(call(IPC_CHANNELS.chatCreateCodeSession, { sectionId: 's1' })).resolves.toEqual(refusal);

    expect(creation.place).not.toHaveBeenCalled();
  });

  it('still answers the session when its section could not be saved', async () => {
    const { call } = setup({ place: vi.fn(() => Promise.resolve({ failed: true })) });

    await expect(call(IPC_CHANNELS.chatCreateSession, { sectionId: 's1' })).resolves.toEqual({
      session: created,
      placementFailed: true,
    });
  });
});
