import { homedir, userInfo } from 'node:os';
import { app, ipcMain, type WebContents } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import type { TerminalCreateRequest, TerminalsChangedEvent } from '@shared/terminal';
import { resolveUserPath } from '../chat/tools/userPath';
import { appWindows } from '../windows';
import { defaultShell, TerminalManager, type PtySpawn } from './TerminalManager';

function loginShell(): string | null {
  try {
    return userInfo().shell;
  } catch {
    return null;
  }
}

/**
 * Build the terminal manager and expose it over IPC, to the renderer's terminal panel only.
 *
 * `workingDirectory` is handed in rather than the chat service itself, so nothing here can reach
 * a conversation and nothing in a conversation can reach here.
 */
export function registerTerminals(workingDirectory: (sessionId: string) => Promise<string | null>): TerminalManager {
  const manager = new TerminalManager({
    // Externalized by electron-vite and loaded on first open: node-pty is a native module, and
    // most launches never open a terminal at all.
    loadSpawn: async () => (await import('node-pty')).spawn as unknown as PtySpawn,
    workingDirectory,
    userPath: resolveUserPath,
    home: homedir(),
    shell: defaultShell(process.platform, process.env, loginShell()),
    baseEnv: process.env,
    locale: app.getLocale(),
    platform: process.platform,
    changed: (sessionId, terminals) => {
      const event: TerminalsChangedEvent = { sessionId, terminals };
      for (const window of appWindows()) {
        if (!window.webContents.isDestroyed()) window.webContents.send(IPC_CHANNELS.terminalsChanged, event);
      }
    },
  });

  // One listener per window rather than per attach, so a reload-heavy session does not pile them up.
  const watched = new Set<number>();
  const watch = (sender: WebContents) => {
    if (watched.has(sender.id)) return;
    watched.add(sender.id);
    const id = sender.id;
    sender.once('destroyed', () => {
      watched.delete(id);
      manager.detach(id);
    });
  };

  ipcMain.handle(IPC_CHANNELS.terminalList, (_event, sessionId: unknown) =>
    typeof sessionId === 'string' ? manager.list(sessionId) : []
  );
  ipcMain.handle(IPC_CHANNELS.terminalCreate, (_event, request: Partial<TerminalCreateRequest> | null) => {
    if (typeof request?.sessionId !== 'string') return { ok: false, error: 'No conversation is open.' };
    return manager.create(request.sessionId, request.cols, request.rows);
  });
  ipcMain.handle(IPC_CHANNELS.terminalAttach, (event, terminalId: unknown) => {
    if (typeof terminalId !== 'string') return null;
    watch(event.sender);
    return manager.attach(event.sender, terminalId);
  });
  ipcMain.on(IPC_CHANNELS.terminalDetach, (event, terminalId: unknown) => {
    if (typeof terminalId === 'string') manager.detach(event.sender.id, terminalId);
  });
  ipcMain.on(IPC_CHANNELS.terminalInput, (_event, terminalId: unknown, data: unknown) => {
    if (typeof terminalId === 'string') manager.write(terminalId, data);
  });
  ipcMain.on(IPC_CHANNELS.terminalResize, (_event, terminalId: unknown, cols: unknown, rows: unknown) => {
    if (typeof terminalId === 'string') manager.resize(terminalId, cols, rows);
  });
  ipcMain.handle(IPC_CHANNELS.terminalRestart, (_event, terminalId: unknown) =>
    typeof terminalId === 'string' ? manager.restart(terminalId) : null
  );
  ipcMain.handle(IPC_CHANNELS.terminalClose, (_event, terminalId: unknown) => {
    if (typeof terminalId === 'string') manager.close(terminalId);
  });

  return manager;
}
