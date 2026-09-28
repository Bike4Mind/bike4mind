import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { ChatModels } from '@bike4mind/common';
import type { ChatApprovalDecision, ChatStreamEvent, SendMessageRequest } from '@shared/chat';
import { IPC_CHANNELS } from '@shared/ipc';
import type { AuthService } from '../auth';
import { createMainLogger } from '../logger';
import { ChatService } from './ChatService';
import { ModelCatalog } from './ModelCatalog';
import { SessionStore } from './SessionStore';
import { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';
import { BackgroundProcessRegistry } from './tools/BackgroundProcessRegistry';

const VERBOSE = process.env.B4M_DESKTOP_VERBOSE === '1';

/**
 * The model a new conversation prefers, matching the CLI's default so the two clients agree
 * about what "the default" means for one account.
 *
 * A PREFERENCE, not a list: the real set comes from the server (see ModelCatalog), and a
 * deployment that does not offer this one gets the first model it does offer instead. It is
 * still the fallback for a session file written before the catalog could be read.
 */
const PREFERRED_MODEL: string = ChatModels.CLAUDE_4_5_SONNET;

/** How much of a background process's output the panel asks for when it rejoins after a reload. */
const PANEL_TAIL_CHARS = 20_000;

/**
 * Build the chat service and expose it over IPC.
 *
 * Every channel here is main-side work on purpose: sending a message needs the access token,
 * which never leaves this process, so the renderer asks for a turn and receives text.
 */
export interface RegisteredChat {
  service: ChatService;
  /** Background processes, exposed so main/index.ts can tear them down on every quit path. */
  background: BackgroundProcessRegistry;
}

export function registerChat(auth: AuthService): RegisteredChat {
  const logger = createMainLogger(VERBOSE);
  const userData = app.getPath('userData');
  const store = new SessionStore(join(userData, 'sessions'), PREFERRED_MODEL);
  const access = new AccessStore(join(userData, 'tool-access.json'));
  const approvals = new ApprovalGate();
  const models = new ModelCatalog({
    logger,
    getApiClient: () => auth.getApiClient(),
    getEnvironmentUrl: () => auth.getState().environment.url,
  });

  const broadcast = (event: ChatStreamEvent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC_CHANNELS.chatStreamEvent, event);
    }
  };

  // Output and status go out on the same channel as reply tokens: a background process is
  // still something that conversation is doing, and a renderer that reloads re-subscribes to
  // one stream rather than two.
  const background = new BackgroundProcessRegistry({
    output: (sessionId, processId, stream, text) =>
      broadcast({ type: 'background-output', sessionId, processId, stream, text }),
    status: (sessionId, process) => broadcast({ type: 'background-status', sessionId, process }),
  });

  const service = new ChatService({
    store,
    access,
    models,
    logger,
    preferredModel: PREFERRED_MODEL,
    approvals,
    background,
    // userData holds the auth vault. Without this a user who shares their home folder would be
    // one `cat` away from the access token, which is T4's invariant broken through a side door.
    protectedPaths: [userData],
    getApiClient: () => auth.getApiClient(),
    getEnvironmentUrl: () => auth.getState().environment.url,
    emit: broadcast,
  });

  ipcMain.handle(IPC_CHANNELS.chatListModels, (_event, force: boolean) => service.listModels(force));
  ipcMain.handle(IPC_CHANNELS.chatSetSessionModel, (_event, sessionId: string, model: string) =>
    service.setSessionModel(sessionId, model)
  );
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

  ipcMain.handle(IPC_CHANNELS.chatListBackground, (_event, sessionId: string) => background.list(sessionId));
  ipcMain.handle(IPC_CHANNELS.chatReadBackground, (_event, sessionId: string, processId: string) =>
    background.tail(processId, sessionId, PANEL_TAIL_CHARS)
  );
  ipcMain.handle(IPC_CHANNELS.chatStopBackground, (_event, sessionId: string, processId: string) =>
    background.kill(processId, sessionId).then(() => undefined)
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

  return { service, background };
}

export { ChatService } from './ChatService';
export { BackgroundProcessRegistry } from './tools/BackgroundProcessRegistry';
