import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMain } from 'electron';
import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import { ComposerDraftStore } from './ComposerDraftStore';
import { registerComposerDraftsIpc } from './composerDraftsIpc';

type Handler = Parameters<IpcMain['handle']>[1];

async function setup(known: string[] = ['s1']) {
  const handlers = new Map<string, Handler>();
  const store = new ComposerDraftStore(join(await mkdtemp(join(tmpdir(), 'composer-drafts-ipc-')), 'drafts.json'));
  registerComposerDraftsIpc(
    { handle: (channel: string, handler: Handler) => void handlers.set(channel, handler) },
    store,
    store.load(),
    async sessionId => known.includes(sessionId)
  );
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({} as Parameters<Handler>[0], ...args);
  return { store, call };
}

describe('registerComposerDraftsIpc', () => {
  it('saves, lists and clears a known conversation draft', async () => {
    const { call } = await setup();
    await call(IPC_CHANNELS.composerDraftsSave, 's1', 'hello');
    expect(await call(IPC_CHANNELS.composerDraftsList)).toEqual({ s1: 'hello' });
    await call(IPC_CHANNELS.composerDraftsSave, 's1', '');
    expect(await call(IPC_CHANNELS.composerDraftsList)).toEqual({});
  });

  it('ignores unknown conversations, such as a new conversation not created yet, and malformed arguments', async () => {
    const { store, call } = await setup();
    await call(IPC_CHANNELS.composerDraftsSave, 'draft-123', 'not a session yet');
    await call(IPC_CHANNELS.composerDraftsSave, 's1', 42);
    await call(IPC_CHANNELS.composerDraftsSave, { id: 's1' }, 'text');
    await call(IPC_CHANNELS.composerDraftsSave, 'x'.repeat(500), 'text');
    expect(store.all()).toEqual({});
  });
});
