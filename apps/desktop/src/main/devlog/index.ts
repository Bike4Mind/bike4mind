import { clipboard, ipcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import { devLog } from './DevLogSink';
import { rendererErrorLog } from './rendererErrors';

/**
 * The developer log's IPC. Registered once, at startup, because the window that uses it is
 * created and destroyed by a chord rather than living for the app's lifetime.
 */
export function registerDevLog(): void {
  ipcMain.handle(IPC_CHANNELS.devLogGetSnapshot, () => devLog.snapshot());
  ipcMain.handle(IPC_CHANNELS.devLogClear, () => devLog.clear());
  ipcMain.handle(IPC_CHANNELS.devLogCopy, (_event, text: unknown) => {
    if (typeof text === 'string') clipboard.writeText(text);
  });
  ipcMain.on(IPC_CHANNELS.devLogReportError, (event, input: unknown) => {
    rendererErrorLog.report(input, event.sender.getURL());
  });
}

export { devLog, DevLogSink, type DevLogDraft } from './DevLogSink';
export { ERRORS_TAG } from './tags';
export { DEV_LOG_CHORD_LABEL, isDevLogChord } from './chord';
export { attachDevLogShortcut, closeDevLogWindow, toggleDevLogWindow } from './window';
