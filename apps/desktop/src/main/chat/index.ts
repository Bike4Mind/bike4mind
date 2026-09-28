import { join } from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { ChatModels } from '@bike4mind/common';
import type { SendMessageRequest } from '@shared/chat';
import { IPC_CHANNELS } from '@shared/ipc';
import type { AuthService } from '../auth';
import { createMainLogger } from '../logger';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';

const VERBOSE = process.env.B4M_DESKTOP_VERBOSE === '1';

/** Matches the CLI's default. Choosing a model per session is T7's job. */
const DEFAULT_MODEL: string = ChatModels.CLAUDE_4_5_SONNET;

/**
 * Build the chat service and expose it over IPC.
 *
 * Every channel here is main-side work on purpose: sending a message needs the access token,
 * which never leaves this process, so the renderer asks for a turn and receives text.
 */
export function registerChat(auth: AuthService): ChatService {
  const logger = createMainLogger(VERBOSE);
  const store = new SessionStore(join(app.getPath('userData'), 'sessions'), DEFAULT_MODEL);

  const service = new ChatService({
    store,
    logger,
    getApiClient: () => auth.getApiClient(),
    getEnvironmentUrl: () => auth.getState().environment.url,
    emit: event => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(IPC_CHANNELS.chatStreamEvent, event);
      }
    },
  });

  ipcMain.handle(IPC_CHANNELS.chatListSessions, () => service.listSessions());
  ipcMain.handle(IPC_CHANNELS.chatCreateSession, () => service.createSession());
  ipcMain.handle(IPC_CHANNELS.chatGetSession, (_event, sessionId: string) => service.getSession(sessionId));
  ipcMain.handle(IPC_CHANNELS.chatRenameSession, (_event, sessionId: string, title: string) =>
    service.renameSession(sessionId, title)
  );
  ipcMain.handle(IPC_CHANNELS.chatDeleteSession, (_event, sessionId: string) => service.deleteSession(sessionId));
  ipcMain.handle(IPC_CHANNELS.chatSendMessage, (_event, request: SendMessageRequest) =>
    service.send(request.sessionId, request.text)
  );
  ipcMain.handle(IPC_CHANNELS.chatStopReply, (_event, sessionId: string) => service.stop(sessionId));

  return service;
}

export { ChatService } from './ChatService';
