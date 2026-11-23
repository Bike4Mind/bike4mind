import type { IpcMain } from 'electron';
import { isKeptDraft, type ComposerDrafts } from '@shared/composerDrafts';
import { IPC_CHANNELS } from '@shared/ipc';
import type { ComposerDraftStore } from './ComposerDraftStore';

export const SESSION_ID_MAX_LENGTH = 200;

/**
 * Arguments are checked rather than trusted, and a draft is only kept for a conversation
 * `isKnownSession` finds, so the file cannot fill with made-up ids. That also leaves out a new
 * conversation's renderer-only `draft-*` id until it becomes a real session. Clearing needs no
 * lookup: forgetting an id that was never stored writes nothing.
 *
 * `loaded` is the store's first `load`; both handlers wait for it so an early save cannot be
 * overwritten by the file being read in afterwards.
 *
 * The renderer sends a save per keystroke, so saves run one at a time in arrival order: a slow
 * session lookup must not let an older text land after a newer one.
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
  const save = async (sessionId: string, text: string): Promise<void> => {
    await loaded;
    if (!isKeptDraft(text)) return store.forget(sessionId);
    // A stored draft's session is known: deleting a session forgets its draft.
    if (!store.has(sessionId) && !(await isKnownSession(sessionId))) return;
    return store.set(sessionId, text);
  };
  let saves: Promise<void> = Promise.resolve();
  ipc.handle(IPC_CHANNELS.composerDraftsSave, (_event, sessionId: unknown, text: unknown): Promise<void> => {
    if (typeof sessionId !== 'string' || sessionId.length > SESSION_ID_MAX_LENGTH || typeof text !== 'string') {
      return Promise.resolve();
    }
    const next = saves.then(() => save(sessionId, text));
    saves = next.catch(() => undefined);
    return next;
  });
}
