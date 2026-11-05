import { Notification, app, ipcMain } from 'electron';
import { parseAttentionNotice, type AttentionOpenEvent } from '@shared/attention';
import { IPC_CHANNELS } from '@shared/ipc';
import { appWindows } from '../windows';
import { NeedsYouMonitor, type NeedsYouMonitorDeps } from './needsYouMonitor';

/**
 * Windows learn of a status change within milliseconds of each other. A second claim for a session
 * inside this span is the same entry seen by another window; a later one is a new entry.
 */
const CLAIM_WINDOW_MS = 2000;

export type Attention = {
  /** Starts main's own needs-you watch, for when no window is open to run the renderer's. */
  watchNeedsYou(sources: Pick<NeedsYouMonitorDeps, 'listSessions' | 'sessionMessages'>): NeedsYouMonitor;
};

/**
 * OS notices for sessions that need the user, and the dock badge counting them.
 *
 * While a window is open its renderer decides WHEN a session newly needs the user (it holds the
 * statuses and plays the chime); with every window closed (macOS) main's NeedsYouMonitor does,
 * by the same rules (@shared/needsYou). Main owns the OS surfaces and the focus check, so a notice
 * never pops over the window the user is already looking at. Every announcer, each window and the
 * monitor, claims an entry first (`attentionClaim`), so a notice happens once, not per announcer.
 *
 * `openWindow` reopens the app window when a notice is clicked with none open.
 */
export function registerAttention({ openWindow }: { openWindow(): void }): Attention {
  // Held so a notice is not garbage-collected before it is clicked, and so a session's newer notice
  // replaces its older one rather than stacking.
  const live = new Map<string, Notification>();

  const claimedAt = new Map<string, number>();

  const claim = (sessionIds: readonly unknown[]): string[] => {
    const now = Date.now();
    for (const [sessionId, at] of claimedAt) if (now - at >= CLAIM_WINDOW_MS) claimedAt.delete(sessionId);
    const won: string[] = [];
    for (const sessionId of sessionIds) {
      if (typeof sessionId !== 'string' || sessionId === '' || claimedAt.has(sessionId)) continue;
      claimedAt.set(sessionId, now);
      won.push(sessionId);
    }
    return won;
  };

  ipcMain.handle(IPC_CHANNELS.attentionClaim, (_event, sessionIds: unknown): string[] =>
    Array.isArray(sessionIds) ? claim(sessionIds) : []
  );

  // Set by a click that had to reopen the window; its renderer takes it once it is listening.
  let pendingOpen: AttentionOpenEvent | null = null;
  ipcMain.handle(IPC_CHANNELS.attentionTakePendingOpen, (): AttentionOpenEvent | null => {
    const taken = pendingOpen;
    pendingOpen = null;
    return taken;
  });

  const showNotice = (payload: unknown) => {
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
      if (!window) {
        pendingOpen = open;
        openWindow();
        return;
      }
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
  };

  ipcMain.handle(IPC_CHANNELS.attentionNotify, (_event, payload: unknown) => showNotice(payload));

  const setBadge = (count: number) => {
    if (process.platform !== 'darwin') return;
    app.dock?.setBadge(count > 0 ? String(count) : '');
  };

  ipcMain.handle(IPC_CHANNELS.attentionSetBadge, (_event, count: unknown) => {
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return;
    setBadge(count);
  });

  let monitor: NeedsYouMonitor | null = null;

  // macOS keeps the app alive with no window; the badge the last renderer kept passes to main.
  app.on('browser-window-created', (_event, created) => {
    created.once('closed', () => {
      if (appWindows().some(window => window !== created && !window.isDestroyed())) return;
      if (monitor) monitor.windowsClosed();
      else setBadge(0);
    });
  });

  return {
    watchNeedsYou: sources => {
      monitor = new NeedsYouMonitor({
        ...sources,
        hasWindow: () => appWindows().some(window => !window.isDestroyed()),
        claim,
        notify: showNotice,
        setBadge,
        warn: message => console.warn(message),
      });
      return monitor;
    },
  };
}
