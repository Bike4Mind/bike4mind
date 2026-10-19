import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import { SIDEBAR_SESSION_ID_MAX_LENGTH, type SidebarSectionsState } from '@shared/sidebarSections';
import type { SidebarSectionStore } from './SidebarSectionStore';

const isText = (value: unknown): value is string => typeof value === 'string';
const isSessionId = (value: unknown): value is string => isText(value) && value.length <= SIDEBAR_SESSION_ID_MAX_LENGTH;

/**
 * Strings are checked rather than trusted: anything else would be written to the file as is. A
 * session is only assigned when `isKnownSession` finds it, so the file cannot fill with made-up ids.
 */
export function registerSidebarIpc(
  ipc: Pick<IpcMain, 'handle'>,
  store: SidebarSectionStore,
  isKnownSession: (sessionId: string) => Promise<boolean>
): void {
  const knownSession = async (value: unknown): Promise<string | undefined> =>
    isSessionId(value) && (await isKnownSession(value)) ? value : undefined;

  ipc.handle(IPC_CHANNELS.sidebarGetSections, () => store.read());
  ipc.handle(IPC_CHANNELS.sidebarCreateSection, async (_event, name: unknown, sessionId: unknown) =>
    isText(name) ? store.create(name, await knownSession(sessionId)) : store.read()
  );
  ipc.handle(IPC_CHANNELS.sidebarRenameSection, (_event, sectionId: unknown, name: unknown) =>
    isText(sectionId) && isText(name) ? store.rename(sectionId, name) : store.read()
  );
  ipc.handle(IPC_CHANNELS.sidebarDeleteSection, (_event, sectionId: unknown) =>
    isText(sectionId) ? store.remove(sectionId) : store.read()
  );
  ipc.handle(IPC_CHANNELS.sidebarMoveSession, async (_event, sessionId: unknown, sectionId: unknown) => {
    if (!isSessionId(sessionId)) return store.read();
    if (sectionId === null) return store.move(sessionId, null);
    return isText(sectionId) && (await knownSession(sessionId)) ? store.move(sessionId, sectionId) : store.read();
  });
}

/**
 * Puts a session main has just created into the section the renderer asked for, before the reply
 * naming it leaves main, so its row is never drawn in the default groups first. No section asked
 * for is no state. A failed write is reported and answered with no state: the session exists
 * either way, and simply starts in the default groups.
 */
export async function placeNewSession(
  store: Pick<SidebarSectionStore, 'move'>,
  sessionId: string,
  sectionId: unknown,
  onError: (error: unknown) => void
): Promise<SidebarSectionsState | undefined> {
  if (!isText(sectionId)) return undefined;
  try {
    return await store.move(sessionId, sectionId);
  } catch (error) {
    onError(error);
    return undefined;
  }
}
