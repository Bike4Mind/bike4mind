import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import type { SidebarSectionStore } from './SidebarSectionStore';

const isText = (value: unknown): value is string => typeof value === 'string';

/** Strings are checked rather than trusted: anything else would be written to the file as is. */
export function registerSidebarIpc(ipc: Pick<IpcMain, 'handle'>, store: SidebarSectionStore): void {
  ipc.handle(IPC_CHANNELS.sidebarGetSections, () => store.read());
  ipc.handle(IPC_CHANNELS.sidebarCreateSection, (_event, name: unknown, sessionId: unknown) =>
    isText(name) ? store.create(name, isText(sessionId) ? sessionId : undefined) : store.read()
  );
  ipc.handle(IPC_CHANNELS.sidebarRenameSection, (_event, sectionId: unknown, name: unknown) =>
    isText(sectionId) && isText(name) ? store.rename(sectionId, name) : store.read()
  );
  ipc.handle(IPC_CHANNELS.sidebarDeleteSection, (_event, sectionId: unknown) =>
    isText(sectionId) ? store.remove(sectionId) : store.read()
  );
  ipc.handle(IPC_CHANNELS.sidebarMoveSession, (_event, sessionId: unknown, sectionId: unknown) =>
    isText(sessionId) && (sectionId === null || isText(sectionId)) ? store.move(sessionId, sectionId) : store.read()
  );
}
