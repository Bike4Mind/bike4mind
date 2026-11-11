import type { IpcMain, WebContents } from 'electron';
import type { ChatSessionExportResult } from '@shared/chat';
import { IPC_CHANNELS } from '@shared/ipc';
import { writeLocalDataExport, type LocalDataExportDeps } from './localDataExport';

export function registerLocalDataExportIpc(
  ipc: Pick<IpcMain, 'handle'>,
  deps: LocalDataExportDeps & { pickFolder(sender: WebContents): Promise<string | null> }
): void {
  ipc.handle(
    IPC_CHANNELS.chatExportLocalData,
    async (event: { sender: WebContents }): Promise<ChatSessionExportResult> => {
      const folder = await deps.pickFolder(event.sender);
      if (!folder) return { saved: false };
      return { saved: true, ...(await writeLocalDataExport(folder, deps)) };
    }
  );
}
