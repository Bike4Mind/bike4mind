import type { ChatSessionSummary } from '@shared/chat';
import { IPC_CHANNELS } from '@shared/ipc';
import { describe, expect, it, vi } from 'vitest';
import { plainSessionMode, registerSessionCreateIpc, type SessionCreation } from './sessionCreateIpc';

type Handler = (event: unknown, request: unknown) => Promise<unknown>;

function register() {
  const handlers = new Map<string, Handler>();
  const creation: SessionCreation = {
    createSession: vi.fn(async mode => ({ id: 's1', mode }) as ChatSessionSummary),
    place: vi.fn(async () => ({ failed: false })),
  };
  registerSessionCreateIpc(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never,
    creation
  );
  const create = (request: unknown) => handlers.get(IPC_CHANNELS.chatCreateSession)?.(undefined, request);
  return { creation, create };
}

describe('session create IPC', () => {
  it('starts a Studio session only when the request names it', async () => {
    const { creation, create } = register();
    await create({ mode: 'studio' });
    await create({ sectionId: 'x' });
    await create(undefined);
    expect(vi.mocked(creation.createSession).mock.calls).toEqual([['studio'], ['chat'], ['chat']]);
  });

  it('reads anything else the renderer sends as Chat', () => {
    for (const value of ['code', 'STUDIO', 1, null, {}]) expect(plainSessionMode(value)).toBe('chat');
    expect(plainSessionMode('studio')).toBe('studio');
  });
});
