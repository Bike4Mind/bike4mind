import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AccountPage, AuthState, EnvironmentSelection } from '@shared/auth';
import type {
  ChatApprovalAnswer,
  ChatApprovalMode,
  ChatArtifactPublishProgress,
  ChatArtifactPublishRequest,
  ChatAttachmentInput,
  ChatImageAction,
  ChatImageRef,
  ChatQueueEvent,
  ChatSessionStatusEvent,
  ChatSessionSummary,
  ChatStreamEvent,
  CreateCodeSessionRequest,
  ReasoningEffortSetting,
  SendMessageRequest,
  StartSpawnSuggestionRequest,
  UpdateProjectRequest,
} from '@shared/chat';
import type { CookieImportRequest, CookieImportState } from '@shared/browserCookies';
import type { ClaudeImportState } from '@shared/claudeImport';
import type { DevLogRecord } from '@shared/devLog';
import type { McpServerInput, McpServersState } from '@shared/mcp';
import type {
  ModelServerAddInput,
  ModelServerProbeInput,
  ModelServerUpdateInput,
  ModelServerView,
} from '@shared/modelServers';
import type { HfTokenStatus, HubSearchRequest, ModelPull, ModelPullRequest } from '@shared/models';
import {
  IPC_CHANNELS,
  type BrowserFreezeFrameRequest,
  type BrowserGoRequest,
  type BrowserNavigateRequest,
  type BrowserPageStateEvent,
  type BrowserPaneRequest,
  type BrowserTabRequest,
  type CreateSessionRequest,
  type DesktopApi,
} from '@shared/ipc';
import type { PrBarState, PrOption, PrSummaryEvent } from '@shared/pullRequest';
import type { TerminalCreateRequest, TerminalDataEvent, TerminalsChangedEvent } from '@shared/terminal';
import type { UpdateState } from '@shared/update';
import type { UsageWindowId } from '@shared/usage';
import type { FleetState } from '@shared/fleet';

// Written out one method per channel rather than a generic invoke(channel, ...args)
// passthrough: a passthrough would let renderer code reach every handler main ever
// registers, which defeats the point of keeping the auth handlers out of its reach.
const api: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  update: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.updateGetState),
    check: () => ipcRenderer.invoke(IPC_CHANNELS.updateCheck),
    download: () => ipcRenderer.invoke(IPC_CHANNELS.updateDownload),
    dismiss: (version: string) => ipcRenderer.invoke(IPC_CHANNELS.updateDismiss, version),
    install: (force: boolean) => ipcRenderer.invoke(IPC_CHANNELS.updateInstall, force),
    onStateChanged: listener => {
      const handler = (_event: unknown, state: UpdateState) => listener(state);
      ipcRenderer.on(IPC_CHANNELS.updateStateChanged, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.updateStateChanged, handler);
    },
  },
  models: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.modelsGetStatus),
    listInstalled: () => ipcRenderer.invoke(IPC_CHANNELS.modelsListInstalled),
    search: (request: HubSearchRequest) => ipcRenderer.invoke(IPC_CHANNELS.modelsSearch, request),
    getDetail: (repo: string) => ipcRenderer.invoke(IPC_CHANNELS.modelsGetDetail, repo),
    listCurated: () => ipcRenderer.invoke(IPC_CHANNELS.modelsListCurated),
    getCuratedPull: (entryId: string, buildId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.modelsGetCuratedPull, entryId, buildId),
    checkCurated: (entryId: string, buildId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.modelsCheckCurated, entryId, buildId),
    checkCuratedList: () => ipcRenderer.invoke(IPC_CHANNELS.modelsCheckCuratedList),
    getCuratedSettings: () => ipcRenderer.invoke(IPC_CHANNELS.modelsCuratedSettings),
    setCuratedEnabled: (enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.modelsCuratedSetEnabled, enabled),
    onCuratedChanged: listener => {
      const handler = () => listener();
      ipcRenderer.on(IPC_CHANNELS.modelsCuratedChanged, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.modelsCuratedChanged, handler);
    },
    listPulls: () => ipcRenderer.invoke(IPC_CHANNELS.modelsListPulls),
    pull: (request: ModelPullRequest) => ipcRenderer.invoke(IPC_CHANNELS.modelsPull, request),
    cancelPull: (key: string) => ipcRenderer.invoke(IPC_CHANNELS.modelsCancelPull, key),
    dismissPull: (key: string) => ipcRenderer.invoke(IPC_CHANNELS.modelsDismissPull, key),
    remove: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.modelsRemove, name),
    getHfToken: () => ipcRenderer.invoke(IPC_CHANNELS.modelsGetHfAccess),
    setHfToken: (token: string) => ipcRenderer.invoke(IPC_CHANNELS.modelsSaveHfAccess, token),
    clearHfToken: () => ipcRenderer.invoke(IPC_CHANNELS.modelsClearHfAccess),
    onHfTokenChanged: listener => {
      const handler = (_event: unknown, status: HfTokenStatus) => listener(status);
      ipcRenderer.on(IPC_CHANNELS.modelsHfAccessChanged, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.modelsHfAccessChanged, handler);
    },
    onPullsChanged: listener => {
      const handler = (_event: unknown, pulls: ModelPull[]) => listener(pulls);
      ipcRenderer.on(IPC_CHANNELS.modelsPullsChanged, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.modelsPullsChanged, handler);
    },
    onInstalledChanged: listener => {
      const handler = () => listener();
      ipcRenderer.on(IPC_CHANNELS.modelsInstalledChanged, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.modelsInstalledChanged, handler);
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
    getProfile: () => ipcRenderer.invoke(IPC_CHANNELS.accountGetProfile),
  },
  usage: {
    getHistory: (window: UsageWindowId, force?: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.usageGetHistory, window, force ?? false),
  },
  fleet: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.fleetGetState),
    refresh: () => ipcRenderer.invoke(IPC_CHANNELS.fleetRefresh),
    setConsent: (consent: boolean) => ipcRenderer.invoke(IPC_CHANNELS.fleetSetConsent, consent),
    sendNow: () => ipcRenderer.invoke(IPC_CHANNELS.fleetSendNow),
    onStateChanged: listener => {
      const handler = (_event: unknown, state: FleetState) => listener(state);
      ipcRenderer.on(IPC_CHANNELS.fleetStateChanged, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.fleetStateChanged, handler);
    },
  },
  chat: {
    listModels: (force?: boolean) => ipcRenderer.invoke(IPC_CHANNELS.chatListModels, force ?? false),
    listSuggestionModels: () => ipcRenderer.invoke(IPC_CHANNELS.chatListSuggestionModels),
    getLocalContext: () => ipcRenderer.invoke(IPC_CHANNELS.chatGetLocalContext),
    setLocalContext: setting => ipcRenderer.invoke(IPC_CHANNELS.chatSetLocalContext, setting),
    getLocalContextFit: () => ipcRenderer.invoke(IPC_CHANNELS.chatGetLocalContextFit),
    setSessionModel: (sessionId: string, model: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSetSessionModel, sessionId, model),
    settleLocalModel: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatSettleLocalModel, sessionId),
    setSessionHistory: (sessionId: string, enabled: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSetSessionHistory, sessionId, enabled),
    searchHistory: (query: string) => ipcRenderer.invoke(IPC_CHANNELS.chatSearchHistory, query),
    clearHistory: () => ipcRenderer.invoke(IPC_CHANNELS.chatClearHistory),
    historyState: () => ipcRenderer.invoke(IPC_CHANNELS.chatHistoryState),
    onHistoryChanged: listener => {
      const handler = () => listener();
      ipcRenderer.on(IPC_CHANNELS.chatHistoryChanged, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.chatHistoryChanged, handler);
    },
    setSessionReasoningEffort: (sessionId: string, effort: ReasoningEffortSetting) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSetSessionReasoningEffort, sessionId, effort),
    setSessionPinned: (sessionId: string, pinned: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSetSessionPinned, sessionId, pinned),
    setApprovalMode: (sessionId: string, mode: ChatApprovalMode) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSetApprovalMode, sessionId, mode),
    setSessionArchived: (sessionId: string, archived: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSetSessionArchived, sessionId, archived),
    listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.chatListSessions),
    createSession: (request?: CreateSessionRequest) => ipcRenderer.invoke(IPC_CHANNELS.chatCreateSession, request),
    createCodeSession: (request: CreateCodeSessionRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatCreateCodeSession, request),
    updateProject: (request: UpdateProjectRequest) => ipcRenderer.invoke(IPC_CHANNELS.chatUpdateProject, request),
    pickProjectDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.chatPickProjectDirectory),
    listRecentFolders: () => ipcRenderer.invoke(IPC_CHANNELS.chatListRecentFolders),
    removeRecentFolder: (directory: string) => ipcRenderer.invoke(IPC_CHANNELS.chatRemoveRecentFolder, directory),
    inspectProject: (directory: string) => ipcRenderer.invoke(IPC_CHANNELS.chatInspectProject, directory),
    workspaceChanges: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatWorkspaceChanges, sessionId),
    addContextDirectory: (sessionId: string, path?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatAddContextDirectory, sessionId, path),
    removeContextDirectory: (sessionId: string, directory: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatRemoveContextDirectory, sessionId, directory),
    getSession: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatGetSession, sessionId),
    renameSession: (sessionId: string, title: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatRenameSession, sessionId, title),
    deleteSession: (sessionId: string, removeWorktree?: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatDeleteSession, sessionId, removeWorktree),
    inspectWorktreeRemoval: (sessionId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatInspectWorktreeRemoval, sessionId),
    listWorktrees: (directory: string) => ipcRenderer.invoke(IPC_CHANNELS.chatListWorktrees, directory),
    removeWorktrees: (directory: string, paths?: string[]) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatRemoveWorktrees, directory, paths),
    revealWorktree: (directory: string, path: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatRevealWorktree, directory, path),
    sendMessage: (request: SendMessageRequest) => ipcRenderer.invoke(IPC_CHANNELS.chatSendMessage, request),
    stopReply: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatStopReply, sessionId),
    continueReply: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatContinueReply, sessionId),
    clearContext: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatClearContext, sessionId),
    compactContext: (sessionId: string, focus?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatCompactContext, sessionId, focus),
    suggestNextPrompt: (sessionId: string, model?: string | null) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSuggestNextPrompt, sessionId, model ?? null),
    getQueuedMessages: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatGetQueued, sessionId),
    cancelQueuedMessage: (sessionId: string, queuedId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatCancelQueued, sessionId, queuedId),
    sendQueuedMessageNow: (sessionId: string, queuedId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSendQueuedNow, sessionId, queuedId),
    startSpawnSuggestion: (request: StartSpawnSuggestionRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatStartSpawnSuggestion, request),
    dismissSpawnSuggestion: (sessionId: string, suggestionId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatDismissSpawnSuggestion, sessionId, suggestionId),
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
    imageAction: (image: ChatImageRef, action: ChatImageAction) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatImageAction, image, action),
    attachImage: (sessionId: string, image: ChatImageRef) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatAttachImage, sessionId, image),
    respondToApproval: (approvalId: string, answer: ChatApprovalAnswer) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatRespondToApproval, approvalId, answer),
    listArtifacts: () => ipcRenderer.invoke(IPC_CHANNELS.chatListArtifacts),
    readArtifact: (artifactId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatReadArtifact, artifactId),
    publishArtifact: (request: ChatArtifactPublishRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatPublishArtifact, request),
    readArtifactPublishState: (artifactId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatReadArtifactPublishState, artifactId),
    onArtifactPublishProgress: listener => {
      const handler = (_event: unknown, progress: ChatArtifactPublishProgress) => listener(progress);
      ipcRenderer.on(IPC_CHANNELS.chatArtifactPublishProgress, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.chatArtifactPublishProgress, handler);
    },
    listBackgroundProcesses: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatListBackground, sessionId),
    readBackgroundOutput: (sessionId: string, processId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatReadBackground, sessionId, processId),
    stopBackgroundProcess: (sessionId: string, processId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatStopBackground, sessionId, processId),
    moveCommandToBackground: (sessionId: string, callId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatMoveToBackground, sessionId, callId),
    listVideoJobs: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatListVideoJobs, sessionId),
    cancelVideoJob: (sessionId: string, jobId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatCancelVideoJob, sessionId, jobId),
    recheckVideoJob: (sessionId: string, jobId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatRecheckVideoJob, sessionId, jobId),
    openVideo: (sessionId: string, jobId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatOpenVideo, sessionId, jobId),
    saveVideo: (sessionId: string, jobId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatSaveVideo, sessionId, jobId),
    copyVideoLink: (sessionId: string, jobId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatCopyVideoLink, sessionId, jobId),
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
    listSkills: sessionId => ipcRenderer.invoke(IPC_CHANNELS.chatListSkills, sessionId),
    setProjectSkillsTrusted: (sessionId, trusted) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSetProjectSkillsTrusted, sessionId, trusted),
  },
  skillMarket: {
    browse: (filters, page) => ipcRenderer.invoke(IPC_CHANNELS.skillMarketBrowse, filters, page),
    recommended: () => ipcRenderer.invoke(IPC_CHANNELS.skillMarketRecommended),
    listing: ref => ipcRenderer.invoke(IPC_CHANNELS.skillMarketListing, ref),
    importListing: request => ipcRenderer.invoke(IPC_CHANNELS.skillMarketImport, request),
    imports: () => ipcRenderer.invoke(IPC_CHANNELS.skillMarketImports),
    openOnWeb: target => ipcRenderer.invoke(IPC_CHANNELS.skillMarketOpenOnWeb, target),
    readLocalSkill: ref => ipcRenderer.invoke(IPC_CHANNELS.skillMarketReadLocal, ref),
    pickUploadSource: () => ipcRenderer.invoke(IPC_CHANNELS.skillMarketPickUpload),
    saveSkill: request => ipcRenderer.invoke(IPC_CHANNELS.skillMarketSave, request),
    organizations: () => ipcRenderer.invoke(IPC_CHANNELS.skillMarketOrgs),
    publish: request => ipcRenderer.invoke(IPC_CHANNELS.skillMarketPublish, request),
    submitVersion: request => ipcRenderer.invoke(IPC_CHANNELS.skillMarketSubmitVersion, request),
    mine: () => ipcRenderer.invoke(IPC_CHANNELS.skillMarketMine),
    withdraw: listingId => ipcRenderer.invoke(IPC_CHANNELS.skillMarketWithdraw, listingId),
    copyShareLink: listingId => ipcRenderer.invoke(IPC_CHANNELS.skillMarketCopyShareLink, listingId),
    openSource: url => ipcRenderer.invoke(IPC_CHANNELS.skillMarketOpenSource, url),
  },
  browser: {
    setPane: (request: BrowserPaneRequest) => ipcRenderer.invoke(IPC_CHANNELS.browserSetPane, request),
    freezeFrame: (request: BrowserFreezeFrameRequest) => ipcRenderer.invoke(IPC_CHANNELS.browserFreezeFrame, request),
    navigate: (request: BrowserNavigateRequest) => ipcRenderer.invoke(IPC_CHANNELS.browserNavigate, request),
    go: (request: BrowserGoRequest) => ipcRenderer.invoke(IPC_CHANNELS.browserGo, request),
    tab: (request: BrowserTabRequest) => ipcRenderer.invoke(IPC_CHANNELS.browserTab, request),
    onPageState: listener => {
      const handler = (_event: unknown, event: BrowserPageStateEvent) => listener(event);
      ipcRenderer.on(IPC_CHANNELS.browserPageState, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.browserPageState, handler);
    },
    cookies: {
      getState: () => ipcRenderer.invoke(IPC_CHANNELS.browserCookiesGetState),
      listProfiles: () => ipcRenderer.invoke(IPC_CHANNELS.browserCookiesListProfiles),
      listHosts: (profileDir: string) => ipcRenderer.invoke(IPC_CHANNELS.browserCookiesListHosts, profileDir),
      import: (request: CookieImportRequest) => ipcRenderer.invoke(IPC_CHANNELS.browserCookiesImport, request),
      forget: (host: string) => ipcRenderer.invoke(IPC_CHANNELS.browserCookiesForget, host),
      clear: () => ipcRenderer.invoke(IPC_CHANNELS.browserCookiesClear),
      onChanged: listener => {
        const handler = (_event: unknown, state: CookieImportState) => listener(state);
        ipcRenderer.on(IPC_CHANNELS.browserCookiesChanged, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.browserCookiesChanged, handler);
      },
    },
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
  sidebar: {
    getSections: () => ipcRenderer.invoke(IPC_CHANNELS.sidebarGetSections),
    createSection: (name: string, sessionId?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.sidebarCreateSection, name, sessionId),
    renameSection: (sectionId: string, name: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.sidebarRenameSection, sectionId, name),
    deleteSection: (sectionId: string) => ipcRenderer.invoke(IPC_CHANNELS.sidebarDeleteSection, sectionId),
    moveSession: (sessionId: string, sectionId: string | null) =>
      ipcRenderer.invoke(IPC_CHANNELS.sidebarMoveSession, sessionId, sectionId),
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
  modelServers: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.modelServersList),
    probe: (input: ModelServerProbeInput) => ipcRenderer.invoke(IPC_CHANNELS.modelServersProbe, input),
    add: (input: ModelServerAddInput) => ipcRenderer.invoke(IPC_CHANNELS.modelServersAdd, input),
    update: (id: string, input: ModelServerUpdateInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.modelServersUpdate, id, input),
    remove: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.modelServersRemove, id),
    check: (id?: string) => ipcRenderer.invoke(IPC_CHANNELS.modelServersCheck, id),
    onChanged: listener => {
      const handler = (_event: unknown, servers: ModelServerView[]) => listener(servers);
      ipcRenderer.on(IPC_CHANNELS.modelServersChanged, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.modelServersChanged, handler);
    },
  },
  tools: {
    getAccess: () => ipcRenderer.invoke(IPC_CHANNELS.toolsGetAccess),
    grantAccess: () => ipcRenderer.invoke(IPC_CHANNELS.toolsGrantAccess),
    revokeAccess: (root: string) => ipcRenderer.invoke(IPC_CHANNELS.toolsRevokeAccess, root),
  },
  permissions: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.permissionsGetState),
    setRules: (scope, lists) => ipcRenderer.invoke(IPC_CHANNELS.permissionsSetRules, scope, lists),
    setSharing: (share: boolean) => ipcRenderer.invoke(IPC_CHANNELS.permissionsSetSharing, share),
  },
  capabilities: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.capabilitiesGetState),
    revoke: (grantId: string) => ipcRenderer.invoke(IPC_CHANNELS.capabilitiesRevoke, grantId),
  },
  claudeImport: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.claudeImportGetState),
    setCodeSettings: patch => ipcRenderer.invoke(IPC_CHANNELS.claudeImportSetCodeSettings, patch),
    pickCodeFolder: (reset: boolean) => ipcRenderer.invoke(IPC_CHANNELS.claudeImportPickCodeFolder, reset),
    syncCode: () => ipcRenderer.invoke(IPC_CHANNELS.claudeImportSyncCode),
    importChatExport: () => ipcRenderer.invoke(IPC_CHANNELS.claudeImportChatExport),
    setWatchFolder: (clear: boolean) => ipcRenderer.invoke(IPC_CHANNELS.claudeImportSetWatchFolder, clear),
    remove: kind => ipcRenderer.invoke(IPC_CHANNELS.claudeImportRemove, kind),
    onStateChanged: listener => {
      const handler = (_event: unknown, state: ClaudeImportState) => listener(state);
      ipcRenderer.on(IPC_CHANNELS.claudeImportStateChanged, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.claudeImportStateChanged, handler);
    },
    onSessionsChanged: listener => {
      const handler = () => listener();
      ipcRenderer.on(IPC_CHANNELS.claudeImportedSessionsChanged, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.claudeImportedSessionsChanged, handler);
    },
  },
  pullRequests: {
    watch: (sessionId: string | null) => ipcRenderer.invoke(IPC_CHANNELS.prWatch, sessionId),
    bind: (sessionId: string, url: string) => ipcRenderer.invoke(IPC_CHANNELS.prBind, sessionId, url),
    dismiss: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.prDismiss, sessionId),
    refresh: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.prRefresh, sessionId),
    setOption: (sessionId: string, option: PrOption, enabled: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.prSetOption, sessionId, option, enabled),
    onStateChanged: listener => {
      const handler = (_event: unknown, state: PrBarState) => listener(state);
      ipcRenderer.on(IPC_CHANNELS.prStateChanged, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.prStateChanged, handler);
    },
    getSummaries: () => ipcRenderer.invoke(IPC_CHANNELS.prGetSummaries),
    onSummaryChanged: listener => {
      const handler = (_event: unknown, summary: PrSummaryEvent) => listener(summary);
      ipcRenderer.on(IPC_CHANNELS.prSummaryChanged, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.prSummaryChanged, handler);
    },
  },
  terminal: {
    list: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.terminalList, sessionId),
    create: (request: TerminalCreateRequest) => ipcRenderer.invoke(IPC_CHANNELS.terminalCreate, request),
    attach: (terminalId: string) => ipcRenderer.invoke(IPC_CHANNELS.terminalAttach, terminalId),
    detach: (terminalId: string) => ipcRenderer.send(IPC_CHANNELS.terminalDetach, terminalId),
    write: (terminalId: string, data: string) => ipcRenderer.send(IPC_CHANNELS.terminalInput, terminalId, data),
    resize: (terminalId: string, cols: number, rows: number) =>
      ipcRenderer.send(IPC_CHANNELS.terminalResize, terminalId, cols, rows),
    restart: (terminalId: string) => ipcRenderer.invoke(IPC_CHANNELS.terminalRestart, terminalId),
    close: (terminalId: string) => ipcRenderer.invoke(IPC_CHANNELS.terminalClose, terminalId),
    onData: listener => {
      const handler = (_event: unknown, event: TerminalDataEvent) => listener(event);
      ipcRenderer.on(IPC_CHANNELS.terminalData, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.terminalData, handler);
    },
    onChanged: listener => {
      const handler = (_event: unknown, event: TerminalsChangedEvent) => listener(event);
      ipcRenderer.on(IPC_CHANNELS.terminalsChanged, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.terminalsChanged, handler);
    },
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.shellOpenExternal, url),
  },
  devLog: {
    getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.devLogGetSnapshot),
    clear: () => ipcRenderer.invoke(IPC_CHANNELS.devLogClear),
    copy: (text: string) => ipcRenderer.invoke(IPC_CHANNELS.devLogCopy, text),
    onRecords: listener => {
      const handler = (_event: unknown, records: DevLogRecord[]) => listener(records);
      ipcRenderer.on(IPC_CHANNELS.devLogRecords, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.devLogRecords, handler);
    },
  },
};

// Key must stay in sync with the Window declaration in src/preload/index.d.ts.
contextBridge.exposeInMainWorld('b4m', api);
