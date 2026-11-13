import { ipcMain, nativeTheme } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import { appWindows } from './windows';

export function registerWindowTheme(): void {
  ipcMain.handle(IPC_CHANNELS.setTheme, (event, mode: unknown, backgroundColor: unknown) => {
    const windows = appWindows();
    if (!windows.some(window => window.webContents === event.sender)) return;
    if (mode !== 'light' && mode !== 'dark' && mode !== 'system') return;
    if (typeof backgroundColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(backgroundColor)) return;

    // Native title bars and dialogs otherwise follow the OS, not the app's selected theme.
    nativeTheme.themeSource = mode;
    for (const window of windows) window.setBackgroundColor(backgroundColor);
  });
}
