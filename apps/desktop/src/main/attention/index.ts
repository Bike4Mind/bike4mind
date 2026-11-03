import { Notification, app, ipcMain } from 'electron';
import { parseAttentionNotice, type AttentionOpenEvent } from '@shared/attention';
import { IPC_CHANNELS } from '@shared/ipc';
import { appWindows } from '../windows';

/**
 * Windows learn of a status change within milliseconds of each other. A second claim for a session
 * inside this span is the same entry seen by another window; a later one is a new entry.
 */
const CLAIM_WINDOW_MS = 2000;

/**
 * OS notices for sessions that need the user, and the dock badge counting them.
 *
 * The renderer decides WHEN a session newly needs the user (it holds the statuses, titles and
 * personas); main owns the OS surfaces and the focus check, so a notice never pops over the window
 * the user is already looking at. Because every window runs that logic, main also decides which
 * window announces an entry (`attentionClaim`), so the chime and the notice happen once, not per window.
 */
export function registerAttention(): void {
  // Held so a notice is not garbage-collected before it is clicked, and so a session's newer notice
  // replaces its older one rather than stacking.
  const live = new Map<string, Notification>();

  const claimedAt = new Map<string, number>();

  ipcMain.handle(IPC_CHANNELS.attentionClaim, (_event, sessionIds: unknown): string[] => {
    if (!Array.isArray(sessionIds)) return [];
    const now = Date.now();
    for (const [sessionId, at] of claimedAt) if (now - at >= CLAIM_WINDOW_MS) claimedAt.delete(sessionId);
    const won: string[] = [];
    for (const sessionId of sessionIds) {
      if (typeof sessionId !== 'string' || sessionId === '' || claimedAt.has(sessionId)) continue;
      claimedAt.set(sessionId, now);
      won.push(sessionId);
    }
    return won;
  });

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
