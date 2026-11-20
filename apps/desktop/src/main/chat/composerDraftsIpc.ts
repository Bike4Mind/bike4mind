import type { IpcMain } from 'electron';
import { isKeptDraft, type ComposerDrafts } from '@shared/composerDrafts';
import { IPC_CHANNELS } from '@shared/ipc';
import type { ComposerDraftStore } from './ComposerDraftStore';

const SESSION_ID_MAX_LENGTH = 200;

/**
 * Arguments are checked rather than trusted, and a draft is only kept for a conversation
 * `isKnownSession` finds, so the file cannot fill with made-up ids. That also leaves out a new
 * conversation's renderer-only `draft-*` id until it becomes a real session. Clearing needs no
 * lookup: forgetting an id that was never stored writes nothing.
 *
 * `loaded` is the store's first `load`; both handlers wait for it so an early save cannot be
 * overwritten by the file being read in afterwards.
 */
export function registerComposerDraftsIpc(
  ipc: Pick<IpcMain, 'handle'>,
  store: ComposerDraftStore,
  loaded: Promise<unknown>,
  isKnownSession: (sessionId: string) => Promise<boolean>
): void {
  ipc.handle(IPC_CHANNELS.composerDraftsList, async (): Promise<ComposerDrafts> => {
    await loaded;
    return store.all();
  });
  ipc.handle(IPC_CHANNELS.composerDraftsSave, async (_event, sessionId: unknown, text: unknown): Promise<void> => {
    if (typeof sessionId !== 'string' || sessionId.length > SESSION_ID_MAX_LENGTH || typeof text !== 'string') return;
    await loaded;
    if (!isKeptDraft(text)) return store.forget(sessionId);
    if (!(await isKnownSession(sessionId))) return;
    return store.set(sessionId, text);
  });
}
