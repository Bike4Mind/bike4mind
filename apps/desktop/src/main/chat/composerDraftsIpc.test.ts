import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMain } from 'electron';
import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import { ComposerDraftStore } from './ComposerDraftStore';
import { registerComposerDraftsIpc, SESSION_ID_MAX_LENGTH } from './composerDraftsIpc';

type Handler = Parameters<IpcMain['handle']>[1];

async function setup(
  known: string[] = ['s1'],
  isKnownSession = async (sessionId: string) => known.includes(sessionId)
) {
  const handlers = new Map<string, Handler>();
  const store = new ComposerDraftStore(join(await mkdtemp(join(tmpdir(), 'composer-drafts-ipc-')), 'drafts.json'));
  registerComposerDraftsIpc(
    { handle: (channel: string, handler: Handler) => void handlers.set(channel, handler) },
    store,
    store.load(),
    isKnownSession
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
    await call(IPC_CHANNELS.composerDraftsSave, 'x'.repeat(SESSION_ID_MAX_LENGTH + 1), 'text');
    expect(store.all()).toEqual({});
  });

  it('accepts a known id of exactly the maximum length', async () => {
    const id = 'x'.repeat(SESSION_ID_MAX_LENGTH);
    const { store, call } = await setup([id]);
    await call(IPC_CHANNELS.composerDraftsSave, id, 'text');
    expect(store.all()).toEqual({ [id]: 'text' });
  });

  it('applies saves in the order they arrive, even when a session lookup is slow', async () => {
    let lookups = 0;
    const { store, call } = await setup([], async () => {
      lookups += 1;
      // The first keystroke's lookup finishes last.
      await new Promise(resolve => setTimeout(resolve, lookups === 1 ? 20 : 0));
      return true;
    });
    await Promise.all([
      call(IPC_CHANNELS.composerDraftsSave, 's1', 'h'),
      call(IPC_CHANNELS.composerDraftsSave, 's1', 'he'),
      call(IPC_CHANNELS.composerDraftsSave, 's1', 'hey'),
    ]);
    expect(store.all()).toEqual({ s1: 'hey' });
    // Once a draft is stored, later keystrokes skip the lookup.
    expect(lookups).toBe(1);
  });
});
