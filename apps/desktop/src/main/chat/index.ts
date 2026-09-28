import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { ChatModels } from '@bike4mind/common';
import type { ChatApprovalDecision, SendMessageRequest } from '@shared/chat';
import { IPC_CHANNELS } from '@shared/ipc';
import type { AuthService } from '../auth';
import { createMainLogger } from '../logger';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';

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
  const userData = app.getPath('userData');
  const store = new SessionStore(join(userData, 'sessions'), DEFAULT_MODEL);
  const access = new AccessStore(join(userData, 'tool-access.json'));
  const approvals = new ApprovalGate();

  const service = new ChatService({
    store,
    access,
    logger,
    approvals,
    // userData holds the auth vault. Without this a user who shares their home folder would be
    // one `cat` away from the access token, which is T4's invariant broken through a side door.
    protectedPaths: [userData],
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
  ipcMain.handle(IPC_CHANNELS.chatRespondToApproval, (_event, approvalId: string, decision: ChatApprovalDecision) =>
    approvals.resolve(approvalId, decision)
  );

  ipcMain.handle(IPC_CHANNELS.toolsGetAccess, async () => ({ roots: await access.list() }));
  // The picker is the ONLY way a root is added. Keeping the grant behind an OS dialog the user
  // drives is what stops a crafted prompt from widening the tools' reach on its own.
  ipcMain.handle(IPC_CHANNELS.toolsGrantAccess, async event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const picked = await (window
      ? dialog.showOpenDialog(window, { properties: ['openDirectory'] })
      : dialog.showOpenDialog({ properties: ['openDirectory'] }));
    if (picked.canceled || picked.filePaths.length === 0) return { roots: await access.list() };
    return { roots: await access.grant(picked.filePaths[0]) };
  });
  ipcMain.handle(IPC_CHANNELS.toolsRevokeAccess, async (_event, root: string) => ({
    roots: await access.revoke(root),
  }));

  return service;
}

export { ChatService } from './ChatService';
