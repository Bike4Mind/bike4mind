import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AccountPage, AuthState, EnvironmentSelection } from '@shared/auth';
import type {
  ChatApprovalAnswer,
  ChatApprovalMode,
  ChatAttachmentInput,
  ChatPendingApproval,
  ChatQueueEvent,
  ChatSessionStatusEvent,
  ChatSessionSummary,
  ChatStreamEvent,
  CreateCodeSessionRequest,
  SendMessageRequest,
  UpdateProjectRequest,
} from '@shared/chat';
import type { McpServerInput, McpServersState } from '@shared/mcp';
import { IPC_CHANNELS, type DesktopApi } from '@shared/ipc';
import type { UpdateState } from '@shared/update';

// Written out one method per channel rather than a generic invoke(channel, ...args)
// passthrough: a passthrough would let renderer code reach every handler main ever
// registers, which defeats the point of keeping the auth handlers out of its reach.
const api: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  update: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.updateGetState),
    check: () => ipcRenderer.invoke(IPC_CHANNELS.updateCheck),
    download: () => ipcRenderer.invoke(IPC_CHANNELS.updateDownload),
    install: (force: boolean) => ipcRenderer.invoke(IPC_CHANNELS.updateInstall, force),
    onStateChanged: listener => {
      const handler = (_event: unknown, state: UpdateState) => listener(state);
      ipcRenderer.on(IPC_CHANNELS.updateStateChanged, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.updateStateChanged, handler);
    },
  },
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
  account: {
    getCredits: () => ipcRenderer.invoke(IPC_CHANNELS.accountGetCredits),
  },
  chat: {
    listModels: (force?: boolean) => ipcRenderer.invoke(IPC_CHANNELS.chatListModels, force ?? false),
    setSessionModel: (sessionId: string, model: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSetSessionModel, sessionId, model),
    setSessionPinned: (sessionId: string, pinned: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSetSessionPinned, sessionId, pinned),
    setApprovalMode: (sessionId: string, mode: ChatApprovalMode) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSetApprovalMode, sessionId, mode),
    setSessionArchived: (sessionId: string, archived: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSetSessionArchived, sessionId, archived),
    listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.chatListSessions),
    createSession: () => ipcRenderer.invoke(IPC_CHANNELS.chatCreateSession),
    createCodeSession: (request: CreateCodeSessionRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatCreateCodeSession, request),
    updateProject: (request: UpdateProjectRequest) => ipcRenderer.invoke(IPC_CHANNELS.chatUpdateProject, request),
    pickProjectDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.chatPickProjectDirectory),
    inspectProject: (directory: string) => ipcRenderer.invoke(IPC_CHANNELS.chatInspectProject, directory),
    addContextDirectory: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatAddContextDirectory, sessionId),
    removeContextDirectory: (sessionId: string, directory: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatRemoveContextDirectory, sessionId, directory),
    getSession: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatGetSession, sessionId),
    renameSession: (sessionId: string, title: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatRenameSession, sessionId, title),
    deleteSession: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatDeleteSession, sessionId),
    sendMessage: (request: SendMessageRequest) => ipcRenderer.invoke(IPC_CHANNELS.chatSendMessage, request),
    stopReply: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatStopReply, sessionId),
    continueReply: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatContinueReply, sessionId),
    suggestNextPrompt: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatSuggestNextPrompt, sessionId),
    getQueuedMessages: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatGetQueued, sessionId),
    cancelQueuedMessage: (sessionId: string, queuedId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatCancelQueued, sessionId, queuedId),
    onQueueChanged: listener => {
      const handler = (_event: unknown, queueEvent: ChatQueueEvent) => listener(queueEvent);
      ipcRenderer.on(IPC_CHANNELS.chatQueueChanged, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.chatQueueChanged, handler);
    },
    pickAttachments: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatPickAttachments, sessionId),
    addAttachments: (sessionId: string, inputs: ChatAttachmentInput[]) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatAddAttachments, sessionId, inputs),
    readAttachment: (sessionId: string, attachmentId: string, mediaType: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatReadAttachment, sessionId, attachmentId, mediaType),
    discardAttachment: (sessionId: string, attachmentId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatDiscardAttachment, sessionId, attachmentId),
    respondToApproval: (approvalId: string, answer: ChatApprovalAnswer) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatRespondToApproval, approvalId, answer),
    listArtifacts: () => ipcRenderer.invoke(IPC_CHANNELS.chatListArtifacts),
    readArtifact: (artifactId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatReadArtifact, artifactId),
    listBackgroundProcesses: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatListBackground, sessionId),
    readBackgroundOutput: (sessionId: string, processId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatReadBackground, sessionId, processId),
    stopBackgroundProcess: (sessionId: string, processId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatStopBackground, sessionId, processId),
    onStreamEvent: listener => {
      const handler = (_event: unknown, streamEvent: ChatStreamEvent) => listener(streamEvent);
      ipcRenderer.on(IPC_CHANNELS.chatStreamEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.chatStreamEvent, handler);
    },
    getSessionStatuses: () => ipcRenderer.invoke(IPC_CHANNELS.chatGetSessionStatuses),
    onSessionStatus: listener => {
      const handler = (_event: unknown, event: ChatSessionStatusEvent) => listener(event);
      ipcRenderer.on(IPC_CHANNELS.chatSessionStatus, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.chatSessionStatus, handler);
    },
    onSessionSummary: listener => {
      const handler = (_event: unknown, summary: ChatSessionSummary) => listener(summary);
      ipcRenderer.on(IPC_CHANNELS.chatSessionSummary, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.chatSessionSummary, handler);
    },
    getPendingApprovals: () => ipcRenderer.invoke(IPC_CHANNELS.chatGetPendingApprovals),
    onPendingApprovals: listener => {
      const handler = (_event: unknown, pending: ChatPendingApproval[]) => listener(pending);
      ipcRenderer.on(IPC_CHANNELS.chatPendingApprovals, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.chatPendingApprovals, handler);
    },
    listSkills: sessionId => ipcRenderer.invoke(IPC_CHANNELS.chatListSkills, sessionId),
    setProjectSkillsTrusted: (sessionId, trusted) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSetProjectSkillsTrusted, sessionId, trusted),
  },
  files: {
    // Electron removed File.path in v32; webUtils is the replacement and it only works on this
    // side of the bridge, so a dropped file's path is resolved here and the bytes never have to
    // cross IPC. Returns '' for anything with no path of its own (a drag out of a web page).
    pathFor: (file: File) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
  },
  mcp: {
    getServers: () => ipcRenderer.invoke(IPC_CHANNELS.mcpGetServers),
    addServer: (input: McpServerInput) => ipcRenderer.invoke(IPC_CHANNELS.mcpAddServer, input),
    updateServer: (id: string, input: McpServerInput) => ipcRenderer.invoke(IPC_CHANNELS.mcpUpdateServer, id, input),
    removeServer: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.mcpRemoveServer, id),
    setServerEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.mcpSetServerEnabled, id, enabled),
    reconnectServer: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.mcpReconnectServer, id),
    onChanged: listener => {
      const handler = (_event: unknown, state: McpServersState) => listener(state);
      ipcRenderer.on(IPC_CHANNELS.mcpServersChanged, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.mcpServersChanged, handler);
    },
  },
  tools: {
    getAccess: () => ipcRenderer.invoke(IPC_CHANNELS.toolsGetAccess),
    grantAccess: () => ipcRenderer.invoke(IPC_CHANNELS.toolsGrantAccess),
    revokeAccess: (root: string) => ipcRenderer.invoke(IPC_CHANNELS.toolsRevokeAccess, root),
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.shellOpenExternal, url),
  },
};

// Key must stay in sync with the Window declaration in src/preload/index.d.ts.
contextBridge.exposeInMainWorld('b4m', api);
