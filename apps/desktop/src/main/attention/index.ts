import { Notification, app, ipcMain } from 'electron';
import { parseAttentionNotice, type AttentionOpenEvent } from '@shared/attention';
import { IPC_CHANNELS } from '@shared/ipc';
import { appWindows } from '../windows';

/**
 * OS notices for sessions that need the user, and the dock badge counting them.
 *
 * The renderer decides WHEN a session newly needs the user (it holds the statuses, titles and
 * personas); main owns the OS surfaces and the focus check, so a notice never pops over the window
 * the user is already looking at.
 */
export function registerAttention(): void {
  // Held so a notice is not garbage-collected before it is clicked, and so a session's newer notice
  // replaces its older one rather than stacking.
  const live = new Map<string, Notification>();

  ipcMain.handle(IPC_CHANNELS.attentionNotify, (_event, payload: unknown) => {
    const notice = parseAttentionNotice(payload);
    if (!notice || !Notification.isSupported()) return;
    const windows = appWindows();
    if (windows.some(window => window.isFocused())) return;

    live.get(notice.sessionId)?.close();
    // Silent: the app's own chime is the opt-in sound.
    const shown = new Notification({ title: notice.title, body: notice.body, silent: true });
    const open: AttentionOpenEvent = { sessionId: notice.sessionId, rootId: notice.rootId };
    shown.on('click', () => {
      live.delete(notice.sessionId);
      const window = appWindows()[0];
      if (!window) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      window.webContents.send(IPC_CHANNELS.attentionOpen, open);
    });
    shown.on('close', () => {
      if (live.get(notice.sessionId) === shown) live.delete(notice.sessionId);
    });
    live.set(notice.sessionId, shown);
    shown.show();
  });

  ipcMain.handle(IPC_CHANNELS.attentionSetBadge, (_event, count: unknown) => {
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return;
    if (process.platform !== 'darwin') return;
    app.dock?.setBadge(count > 0 ? String(count) : '');
  });
}
