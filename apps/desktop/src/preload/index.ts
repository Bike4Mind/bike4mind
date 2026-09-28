import { contextBridge, ipcRenderer } from 'electron';
import type { AccountPage, AuthState, EnvironmentSelection } from '@shared/auth';
import type { ChatApprovalDecision, ChatStreamEvent, SendMessageRequest } from '@shared/chat';
import { IPC_CHANNELS, type DesktopApi } from '@shared/ipc';

// Written out one method per channel rather than a generic invoke(channel, ...args)
// passthrough: a passthrough would let renderer code reach every handler main ever
// registers, which defeats the point of keeping the auth handlers out of its reach.
const api: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  auth: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.authGetState),
    signIn: () => ipcRenderer.invoke(IPC_CHANNELS.authSignIn),
    cancelSignIn: () => ipcRenderer.invoke(IPC_CHANNELS.authCancelSignIn),
    signOut: () => ipcRenderer.invoke(IPC_CHANNELS.authSignOut),
    setEnvironment: (selection: EnvironmentSelection) => ipcRenderer.invoke(IPC_CHANNELS.authSetEnvironment, selection),
    retryIdentity: () => ipcRenderer.invoke(IPC_CHANNELS.authRetryIdentity),
    openAccountPage: (page: AccountPage) => ipcRenderer.invoke(IPC_CHANNELS.authOpenAccountPage, page),
    onStateChanged: listener => {
      // The raw IpcRendererEvent carries a `sender` handle; forwarding only the payload keeps
      // renderer code from reaching back into main through it.
      const handler = (_event: unknown, state: AuthState) => listener(state);
      ipcRenderer.on(IPC_CHANNELS.authStateChanged, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.authStateChanged, handler);
    },
  },
  chat: {
    listModels: (force?: boolean) => ipcRenderer.invoke(IPC_CHANNELS.chatListModels, force ?? false),
    setSessionModel: (sessionId: string, model: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSetSessionModel, sessionId, model),
    listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.chatListSessions),
    createSession: () => ipcRenderer.invoke(IPC_CHANNELS.chatCreateSession),
    getSession: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatGetSession, sessionId),
    renameSession: (sessionId: string, title: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatRenameSession, sessionId, title),
    deleteSession: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatDeleteSession, sessionId),
    sendMessage: (request: SendMessageRequest) => ipcRenderer.invoke(IPC_CHANNELS.chatSendMessage, request),
    stopReply: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatStopReply, sessionId),
    respondToApproval: (approvalId: string, decision: ChatApprovalDecision) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatRespondToApproval, approvalId, decision),
    onStreamEvent: listener => {
      const handler = (_event: unknown, streamEvent: ChatStreamEvent) => listener(streamEvent);
      ipcRenderer.on(IPC_CHANNELS.chatStreamEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.chatStreamEvent, handler);
    },
  },
  tools: {
    getAccess: () => ipcRenderer.invoke(IPC_CHANNELS.toolsGetAccess),
    grantAccess: () => ipcRenderer.invoke(IPC_CHANNELS.toolsGrantAccess),
    revokeAccess: (root: string) => ipcRenderer.invoke(IPC_CHANNELS.toolsRevokeAccess, root),
  },
};

// Key must stay in sync with the Window declaration in src/preload/index.d.ts.
contextBridge.exposeInMainWorld('b4m', api);
