import { BrowserWindow, dialog, type IpcMain, type WebContents } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import { ClaudeImportService, type ClaudeImportServiceDeps } from './ClaudeImportService';

type PickerDeps = Omit<ClaudeImportServiceDeps, 'pickPath'>;

/**
 * Settings' "Import from Claude" channels. None takes a path: every folder and file the importer
 * reads is either its configured default or one the user picked in a native dialog here.
 */
export function registerClaudeImport(ipcMain: Pick<IpcMain, 'handle'>, deps: PickerDeps): ClaudeImportService {
  let sender: WebContents | null = null;
  const pickPath: ClaudeImportServiceDeps['pickPath'] = async (kind, defaultPath) => {
    const window = sender ? BrowserWindow.fromWebContents(sender) : null;
    const options: Electron.OpenDialogOptions =
      kind === 'folder'
        ? { properties: ['openDirectory'], defaultPath }
        : {
            properties: ['openFile'],
            defaultPath,
            filters: [{ name: 'Claude export', extensions: ['zip', 'json'] }],
          };
    const picked = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
    const path = picked.canceled ? null : (picked.filePaths[0] ?? null);
    if (path && kind === 'export' && !/(\.zip|(^|[\\/])conversations\.json)$/i.test(path)) return null;
    return path;
  };
  const service = new ClaudeImportService({ ...deps, pickPath });
  const withSender =
    <A extends unknown[], R>(run: (...args: A) => R) =>
    (event: { sender: WebContents }, ...args: A): R => {
      sender = event.sender;
      return run(...args);
    };

  ipcMain.handle(IPC_CHANNELS.claudeImportGetState, () => service.state());
  ipcMain.handle(IPC_CHANNELS.claudeImportSetCodeSettings, (_event, patch: unknown) => service.setCodeSettings(patch));
  ipcMain.handle(
    IPC_CHANNELS.claudeImportPickCodeFolder,
    withSender((reset: unknown) => service.pickCodeFolder(reset === true))
  );
  ipcMain.handle(IPC_CHANNELS.claudeImportSyncCode, async () => {
    await service.syncCode();
    return service.state();
  });
  ipcMain.handle(
    IPC_CHANNELS.claudeImportChatExport,
    withSender(() => service.importChatExport())
  );
  ipcMain.handle(
    IPC_CHANNELS.claudeImportSetWatchFolder,
    withSender((clear: unknown) => service.setChatWatchFolder(clear === true))
  );
  ipcMain.handle(IPC_CHANNELS.claudeImportRemove, (_event, kind: unknown) => service.removeImported(kind));
  return service;
}
