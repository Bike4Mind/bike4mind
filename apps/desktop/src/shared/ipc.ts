import type { AppWorktree, WorktreeRemoval, WorktreeSweepItem } from './worktreeRemoval';
import type { PromptCacheTtl } from '@bike4mind/common';
import type { AccountCredits, AccountProfile } from './account';
import type { AccountPage, AuthState, EnvironmentSelection, SetEnvironmentResult } from './auth';
import type {
  ChromeHostsResult,
  ChromeProfilesResult,
  CookieImportRequest,
  CookieImportResult,
  CookieImportState,
} from './browserCookies';
import type { ClaudeImportResult, ClaudeImportState, ClaudeRemoveResult } from './claudeImport';
import type { CapabilityLedgerState } from './capabilities';
import type { McpMutationResult, McpServerInput, McpServersState } from './mcp';
import type {
  ModelServerAddInput,
  ModelServerMutationResult,
  ModelServerProbeInput,
  ModelServerProbeResult,
  ModelServerUpdateInput,
  ModelServerView,
} from './modelServers';
import type {
  AddAttachmentsResult,
  BackgroundProcessInfo,
  ChatApprovalAnswer,
  ChatApprovalMode,
  ChatArtifactContent,
  ChatArtifactLibrary,
  ChatArtifactPublish,
  ChatArtifactPublishProgress,
  ChatArtifactPublishRequest,
  ChatAttachmentInput,
  ChatImageAction,
  ChatImageActionResult,
  ChatImageRef,
  ChatModelCatalog,
  ChatMoveToBackgroundResult,
  ChatQueueEvent,
  ChatQueuedMessage,
  ChatSession,
  ChatSessionStatusEvent,
  ChatSessionSummary,
  ChatStreamEvent,
  ChatVideoJob,
  ChatVideoLinkResult,
  CreateCodeSessionRequest,
  ProjectInspection,
  RecentFolder,
  ContextBoundaryResult,
  ReasoningEffortSetting,
  SendMessageRequest,
  SendMessageResult,
  SpawnSuggestionResult,
  StartSpawnSuggestionRequest,
  ToolAccessState,
  UpdateProjectRequest,
  UpdateProjectResult,
} from './chat';
import type { DevLogRecord, DevLogSnapshot } from './devLog';
import type { ShareDirectoryResult } from './directoryRequest';
import type { PrActionResult, PrBarState, PrOption, PrSummaryEvent } from './pullRequest';
import type { LocalContextFit, LocalContextSetting } from './localContextSetting';
import type { SidebarSectionsState } from './sidebarSections';
import type { WorkspaceChanges } from './workspaceChanges';
import type { SkillsState } from './skills';
import type { PermissionMutationResult, PermissionRuleLists, PermissionScope, PermissionsState } from './permissions';
import type {
  SkillMarketDetailResult,
  SkillMarketFilters,
  SkillMarketImportRequest,
  SkillMarketImportResult,
  SkillMarketImportsResult,
  SkillMarketListingRef,
  SkillMarketPage,
  SkillMarketWebTarget,
  SkillActionResult,
  SkillLocalRef,
  SkillMarketOrgsResult,
  SkillMyListingsResult,
  SkillPublishRequest,
  SkillSaveRequest,
  SkillSaveResult,
  SkillSubmitResult,
  SkillSubmitVersionRequest,
  SkillUploadPreview,
} from './skillMarket';
import type {
  TerminalAttachment,
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalInfo,
  TerminalsChangedEvent,
} from './terminal';
import type { UpdateInstallResult, UpdateState } from './update';
import type {
  CuratedCheckResult,
  CuratedList,
  CuratedListSettings,
  CuratedPullResult,
  HfTokenResult,
  HfTokenStatus,
  HubDetailResult,
  HubSearchRequest,
  HubSearchResult,
  InstalledModelsResult,
  ModelPull,
  ModelPullRequest,
  ModelPullResult,
  ModelRemoveResult,
  ModelRuntimeStatus,
} from './models';
import type { AccountUsageResult, UsageWindowId } from './usage';
import type { FleetState } from './fleet';
import type { LocalHistoryResult, LocalHistoryState } from './history';

/**
 * IPC contract shared by the main process and the preload bridge.
 *
 * Invariant for every channel added here: secrets stay in main. The OAuth device flow runs
 * entirely in the main process so that tokens never enter the renderer, so a channel may
 * return auth STATE (signed in, which account, which environment) but never an access token,
 * refresh token, device code or raw cookie. There is deliberately no "get token" channel:
 * anything that needs a token is a main-process job.
 */
export const IPC_CHANNELS = {
  getAppInfo: 'app:get-info',
  authGetState: 'auth:get-state',
  authSignIn: 'auth:sign-in',
  authCancelSignIn: 'auth:cancel-sign-in',
  authSignOut: 'auth:sign-out',
  authSetEnvironment: 'auth:set-environment',
  authRetryIdentity: 'auth:retry-identity',
  authOpenAccountPage: 'auth:open-account-page',
  /** main -> renderer push; the renderer never polls for auth state. */
  authStateChanged: 'auth:state-changed',
  accountGetCredits: 'account:get-credits',
  accountGetProfile: 'account:get-profile',
  usageGetHistory: 'usage:get-history',
  fleetGetState: 'fleet:get-state',
  fleetRefresh: 'fleet:refresh',
  fleetSetConsent: 'fleet:set-consent',
  fleetSendNow: 'fleet:send-now',
  /** main -> renderer push of the integration's state; never carries the key. */
  fleetStateChanged: 'fleet:state-changed',
  chatListModels: 'chat:list-models',
  chatListSuggestionModels: 'chat:list-suggestion-models',
  chatGetLocalContext: 'chat:get-local-context',
  chatSetLocalContext: 'chat:set-local-context',
  chatGetLocalContextFit: 'chat:get-local-context-fit',
  chatSetSessionModel: 'chat:set-session-model',
  chatSettleLocalModel: 'chat:settle-local-model',
  chatSetSessionHistory: 'chat:set-session-history',
  chatSearchHistory: 'chat:search-history',
  chatClearHistory: 'chat:clear-history',
  chatHistoryState: 'chat:history-state',
  chatHistoryChanged: 'chat:history-changed',
  chatSetSessionReasoningEffort: 'chat:set-session-reasoning-effort',
  chatSetSessionPromptCacheTtl: 'chat:set-session-prompt-cache-ttl',
  chatSetSessionPinned: 'chat:set-session-pinned',
  /**
   * The one way an approval mode changes. Renderer -> main only, driven by the composer pill:
   * there is deliberately no tool, no MCP surface and no model-facing path to this channel.
   */
  chatSetApprovalMode: 'chat:set-approval-mode',
  chatSetSessionArchived: 'chat:set-session-archived',
  chatListSessions: 'chat:list-sessions',
  chatCreateSession: 'chat:create-session',
  chatCreateCodeSession: 'chat:create-code-session',
  chatUpdateProject: 'chat:update-project',
  chatPickProjectDirectory: 'chat:pick-project-directory',
  chatListRecentFolders: 'chat:list-recent-folders',
  chatRemoveRecentFolder: 'chat:remove-recent-folder',
  chatInspectProject: 'chat:inspect-project',
  chatWorkspaceChanges: 'chat:workspace-changes',
  chatAddContextDirectory: 'chat:add-context-directory',
  chatRemoveContextDirectory: 'chat:remove-context-directory',
  chatGetSession: 'chat:get-session',
  chatRenameSession: 'chat:rename-session',
  chatDeleteSession: 'chat:delete-session',
  chatInspectWorktreeRemoval: 'chat:inspect-worktree-removal',
  chatListWorktrees: 'chat:list-worktrees',
  chatRemoveWorktrees: 'chat:remove-worktrees',
  chatRevealWorktree: 'chat:reveal-worktree',
  chatSendMessage: 'chat:send-message',
  chatStopReply: 'chat:stop-reply',
  chatContinueReply: 'chat:continue-reply',
  /**
   * The two context commands. Renderer -> main only, and deliberately NOT reachable from a
   * tool: see the renderer's commands.ts for why a slash command is not a model capability.
   */
  chatClearContext: 'chat:clear-context',
  chatCompactContext: 'chat:compact-context',
  chatSuggestNextPrompt: 'chat:suggest-next-prompt',
  chatGetQueued: 'chat:get-queued',
  chatCancelQueued: 'chat:cancel-queued',
  chatSendQueuedNow: 'chat:send-queued-now',
  /** main -> renderer push; one session's queue of typed-ahead messages changed. */
  chatQueueChanged: 'chat:queue-changed',
  chatStartSpawnSuggestion: 'chat:start-spawn-suggestion',
  chatDismissSpawnSuggestion: 'chat:dismiss-spawn-suggestion',
  chatRespondToApproval: 'chat:respond-to-approval',
  chatPickAttachments: 'chat:pick-attachments',
  chatAddAttachments: 'chat:add-attachments',
  chatReadAttachment: 'chat:read-attachment',
  chatDiscardAttachment: 'chat:discard-attachment',
  chatImageAction: 'chat:image-action',
  chatAttachImage: 'chat:attach-image',
  chatListArtifacts: 'chat:list-artifacts',
  chatReadArtifact: 'chat:read-artifact',
  chatPublishArtifact: 'chat:publish-artifact',
  chatReadArtifactPublishState: 'chat:read-artifact-publish-state',
  /** main -> renderer push, one per publish step. */
  chatArtifactPublishProgress: 'chat:artifact-publish-progress',
  chatListBackground: 'chat:list-background',
  chatReadBackground: 'chat:read-background',
  chatStopBackground: 'chat:stop-background',
  chatMoveToBackground: 'chat:move-to-background',
  chatListVideoJobs: 'chat:list-video-jobs',
  chatCancelVideoJob: 'chat:cancel-video-job',
  chatRecheckVideoJob: 'chat:recheck-video-job',
  chatOpenVideo: 'chat:open-video',
  chatSaveVideo: 'chat:save-video',
  chatCopyVideoLink: 'chat:copy-video-link',
  /** main -> renderer push; reply tokens as they arrive. */
  chatStreamEvent: 'chat:stream-event',
  /**
   * main -> renderer push; one session's stored summary changed with no reply involved.
   *
   * Today only its generated title, which lands moments after the first prompt and long after
   * the IPC call that sent it has resolved - so there is nothing left to return it on.
   */
  chatSessionSummary: 'chat:session-summary',
  chatGetSessionStatuses: 'chat:get-session-statuses',
  /** main -> renderer push; one session started or stopped being busy. */
  chatSessionStatus: 'chat:session-status',
  chatListSkills: 'chat:list-skills',
  /**
   * The one way a project's skills become loadable. Renderer -> main only, driven by the
   * picker's trust prompt: a project skill is instruction text that arrived with a clone, so
   * nothing the MODEL can reach may widen this - the same rule as toolsGrantAccess.
   */
  chatSetProjectSkillsTrusted: 'chat:set-project-skills-trusted',
  skillMarketBrowse: 'skills:market-browse',
  skillMarketRecommended: 'skills:market-recommended',
  skillMarketListing: 'skills:market-listing',
  /** Only from the Import / Update buttons: it writes a skill to the user's account. */
  skillMarketImport: 'skills:market-import',
  skillMarketImports: 'skills:market-imports',
  skillMarketOpenOnWeb: 'skills:market-open-on-web',
  skillMarketReadLocal: 'skills:market-read-local',
  skillMarketPickUpload: 'skills:market-pick-upload',
  /** The writes below run only from a click in the upload dialog or My listings. */
  skillMarketSave: 'skills:market-save',
  skillMarketOrgs: 'skills:market-orgs',
  skillMarketPublish: 'skills:market-publish',
  skillMarketSubmitVersion: 'skills:market-submit-version',
  skillMarketMine: 'skills:market-mine',
  skillMarketWithdraw: 'skills:market-withdraw',
  skillMarketCopyShareLink: 'skills:market-copy-share-link',
  skillMarketOpenSource: 'skills:market-open-source',
  mcpGetServers: 'mcp:get-servers',
  mcpAddServer: 'mcp:add-server',
  mcpUpdateServer: 'mcp:update-server',
  mcpRemoveServer: 'mcp:remove-server',
  mcpSetServerEnabled: 'mcp:set-server-enabled',
  mcpReconnectServer: 'mcp:reconnect-server',
  /** main -> renderer push; a server changed state, which the renderer never polls for. */
  mcpServersChanged: 'mcp:servers-changed',
  modelServersList: 'servers:list',
  modelServersProbe: 'servers:probe',
  modelServersAdd: 'servers:add',
  modelServersUpdate: 'servers:update',
  modelServersRemove: 'servers:remove',
  modelServersCheck: 'servers:check',
  /** main -> renderer push; a server was added, changed, or its health was rechecked. */
  modelServersChanged: 'servers:changed',
  toolsGetAccess: 'tools:get-access',
  toolsGrantAccess: 'tools:grant-access',
  toolsRevokeAccess: 'tools:revoke-access',
  /**
   * Standing permission rules. Renderer -> main only, from Settings: like toolsGrantAccess,
   * nothing the MODEL can reach may write a rule.
   */
  permissionsGetState: 'permissions:get-state',
  permissionsSetRules: 'permissions:set-rules',
  permissionsSetSharing: 'permissions:set-sharing',
  capabilitiesGetState: 'capabilities:get-state',
  capabilitiesRevoke: 'capabilities:revoke',
  /**
   * Import from Claude, Settings only. No channel takes a path: folders and export files are
   * picked through native dialogs in main, and the importer only ever reads them.
   */
  claudeImportGetState: 'claude:get-import-state',
  claudeImportSetCodeSettings: 'claude:set-code-import',
  claudeImportPickCodeFolder: 'claude:pick-code-folder',
  claudeImportSyncCode: 'claude:sync-code',
  claudeImportChatExport: 'claude:import-chat-export',
  claudeImportSetWatchFolder: 'claude:set-watch-folder',
  claudeImportRemove: 'claude:remove-imported',
  /** main -> renderer push of the import state. */
  claudeImportStateChanged: 'claude:import-state-changed',
  /** main -> renderer push, batched: imported sessions were added or changed, so re-list. */
  claudeImportedSessionsChanged: 'claude:imported-sessions-changed',
  updateGetState: 'update:get-state',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  /** Hide the floating update notice for one version; main persists it. */
  updateDismiss: 'update:dismiss',
  /** The one channel that can end this process. Main gates it on work in flight. */
  updateInstall: 'update:install',
  /** main -> renderer push; a check, a download or an install offer changed state. */
  updateStateChanged: 'update:state-changed',
  modelsGetStatus: 'models:get-status',
  modelsListInstalled: 'models:list-installed',
  modelsSearch: 'models:search',
  modelsGetDetail: 'models:get-detail',
  modelsListCurated: 'models:list-curated',
  modelsGetCuratedPull: 'models:get-curated-pull',
  modelsCheckCurated: 'models:check-curated',
  /** Check now on the list itself: skips the 6 h throttle; the result arrives as modelsCuratedChanged. */
  modelsCheckCuratedList: 'models:check-curated-list',
  modelsCuratedSettings: 'models:curated-settings',
  modelsCuratedSetEnabled: 'models:curated-set-enabled',
  /** main -> renderer push; the curated list or its check status changed. */
  modelsCuratedChanged: 'models:curated-changed',
  modelsListPulls: 'models:list-pulls',
  /** Starts a download; resolves when it finishes, fails or is cancelled. */
  modelsPull: 'models:pull',
  modelsCancelPull: 'models:cancel-pull',
  modelsDismissPull: 'models:dismiss-pull',
  modelsRemove: 'models:remove',
  /** Hugging Face sign-in: whether a token is saved, save one, forget it. None of them returns the token. */
  modelsGetHfAccess: 'models:get-hf-access',
  modelsSaveHfAccess: 'models:save-hf-access',
  modelsClearHfAccess: 'models:clear-hf-access',
  modelsHfAccessChanged: 'models:hf-access-changed',
  /** main -> renderer push of every pull in flight or failed. */
  modelsPullsChanged: 'models:pulls-changed',
  /** main -> renderer push: a pull finished or a model was removed. */
  modelsInstalledChanged: 'models:installed-changed',
  /**
   * Where the agent's browser should be drawn, if anywhere. Renderer -> main only: the view is
   * an overlay the renderer cannot see, so the renderer is the only thing that knows where the
   * hole it has left for it actually is.
   */
  browserSetPane: 'browser:set-pane',
  /**
   * A still of the page the pane is holding off screen, for the renderer to draw in its place.
   * Renderer -> main.
   */
  browserFreezeFrame: 'browser:freeze-frame',
  /**
   * Open what the user typed in the pane's url bar. Renderer -> main.
   *
   * The USER's navigation, not the agent's, so it goes nowhere near the tool approval gate -
   * but main still resolves the address itself, because the http/https rule is not the
   * renderer's to enforce. See @shared/browserUrl.
   */
  browserNavigate: 'browser:navigate',
  /** Back, forward or reload from the pane's url bar. Renderer -> main. */
  browserGo: 'browser:go',
  /** Open, switch to or close a tab from the pane's tab strip. Renderer -> main. */
  browserTab: 'browser:tab',
  /**
   * main -> renderer push; one conversation's page moved, started loading, or failed to.
   *
   * Everything the url bar draws arrives on this one channel, because it all changes together:
   * a navigation is also what settles whether there is anything to go back to.
   */
  browserPageState: 'browser:page-state',
  /**
   * Importing the user's own Chrome cookies, per site. Renderer -> main, every one of them.
   *
   * There is no tool behind any of these and no model-reachable path to one: an import happens
   * because the user clicked it in the pane's menu and named the sites. See @shared/browserCookies.
   */
  browserCookiesGetState: 'browser:cookies-get-state',
  browserCookiesListProfiles: 'browser:cookies-list-profiles',
  /** The chooser's site list. Reads host names only - no Keychain prompt, nothing decrypted. */
  browserCookiesListHosts: 'browser:cookies-list-hosts',
  /** The one call that prompts the Keychain and writes to the jar. */
  browserCookiesImport: 'browser:cookies-import',
  browserCookiesForget: 'browser:cookies-forget',
  /** Empties the partition, not only the imported rows. See CookieImporter.clear. */
  browserCookiesClear: 'browser:cookies-clear',
  /** main -> renderer push; what the pane's standing indicator draws. */
  browserCookiesChanged: 'browser:cookies-changed',
  /**
   * The developer log. Every one of these belongs to the dev window alone, and none of them is
   * reachable from a tool or from a reply: the window is opened by a chord the user presses.
   *
   * Source-agnostic by design - see @shared/devLog. Adding a source to the log adds nothing
   * here.
   */
  devLogGetSnapshot: 'devlog:get-snapshot',
  devLogClear: 'devlog:clear',
  /** The dev window's copy button. Main owns the clipboard; the window sends what it is showing. */
  devLogCopy: 'devlog:copy',
  /** main -> renderer push; a batch of newly captured records, coalesced in the sink. */
  devLogRecords: 'devlog:records',
  /** Renderer -> main only. Main decides what may be opened; see isExternallyOpenable. */
  shellOpenExternal: 'shell:open-external',
  /**
   * A conversation's pull request. Renderer -> main, every one of them a user's click or the
   * conversation coming on screen; nothing the model can reach calls these. The automations
   * (auto-merge in particular) are switched on here and nowhere else.
   */
  prWatch: 'pr:watch',
  prBind: 'pr:bind',
  prDismiss: 'pr:dismiss',
  prRefresh: 'pr:refresh',
  prSetOption: 'pr:set-option',
  /** main -> renderer push; one conversation's bar changed. */
  prStateChanged: 'pr:state-changed',
  /** The sidebar's PR icons. The read is of stored state only and never reaches GitHub. */
  prGetSummaries: 'pr:get-summaries',
  /** main -> renderer push; one conversation's sidebar PR icon changed. */
  prSummaryChanged: 'pr:summary-changed',
  /** The user's sidebar sections. Every change answers with the whole state. */
  sidebarGetSections: 'sidebar:get-sections',
  sidebarCreateSection: 'sidebar:create-section',
  sidebarRenameSection: 'sidebar:rename-section',
  sidebarDeleteSection: 'sidebar:delete-section',
  sidebarMoveSession: 'sidebar:move-session',
  /**
   * The user's terminals; see @shared/terminal. Input and resize are one-way sends rather than
   * invokes: a keystroke has nothing to wait for, and a round trip each would be felt.
   */
  terminalList: 'terminal:list',
  terminalCreate: 'terminal:create',
  terminalAttach: 'terminal:attach',
  terminalDetach: 'terminal:detach',
  terminalInput: 'terminal:input',
  terminalResize: 'terminal:resize',
  terminalRestart: 'terminal:restart',
  terminalClose: 'terminal:close',
  /** main -> renderer push, batched; only to a window attached to that terminal. */
  terminalData: 'terminal:data',
  /** main -> renderer push; one conversation's tab list changed. */
  terminalsChanged: 'terminal:changed',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export interface AppInfo {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  /** Lets the renderer, which has no `os`, print paths under it as `~`. */
  homeDirectory: string;
}

/**
 * The rectangle the renderer has left clear for the agent's browser, in CSS pixels relative to
 * the app window's content area - which is exactly what getBoundingClientRect reports.
 */
export interface BrowserPaneBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * What the renderer is asking for: a conversation's page at these bounds, or nothing.
 *
 * Null bounds mean "show no page" while still naming the conversation, so the answer still
 * carries that conversation's url and the pane can say whether it has anything to show. A null
 * `sessionId` is the same request with nothing to ask about.
 */
export interface BrowserPaneRequest {
  sessionId: string | null;
  bounds: BrowserPaneBounds | null;
}

/**
 * Everything the pane's url bar draws. The empty url is a conversation whose browser has no
 * page, or has been nowhere.
 */
export interface BrowserPaneState {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  /**
   * Why the last load did not arrive, or '' when it did. A failed load usually leaves the
   * PREVIOUS page on screen, so this is the only thing that says so - which is the whole point
   * of carrying it rather than letting the pane show a page that is quietly out of date.
   */
  error: string;
  /**
   * Every tab the conversation has open, in strip order. The fields above are the ACTIVE tab's;
   * main owns which one that is, so the agent switching tabs and the user clicking one are the
   * same push.
   */
  tabs: BrowserTabSummary[];
  /** Null when the conversation has no tab open. */
  activeTabId: number | null;
}

/** One entry in the pane's tab strip. */
export interface BrowserTabSummary {
  /** Stable for the tab's life and never reused within a conversation. */
  id: number;
  title: string;
  url: string;
  loading: boolean;
}

export type BrowserPageStateEvent = BrowserPaneState & { sessionId: string };

/** Which conversation's held page to capture. */
export interface BrowserFreezeFrameRequest {
  sessionId: string;
}

/** Which conversation's browser to send to `url`. The url is resolved again in main. */
export interface BrowserNavigateRequest {
  sessionId: string;
  url: string;
}

/** The history controls, which take no url. */
export type BrowserGoAction = 'back' | 'forward' | 'reload';

export interface BrowserGoRequest {
  sessionId: string;
  action: BrowserGoAction;
}

export type BrowserTabAction = 'new' | 'select' | 'close';

/** `tabId` names the tab for select and close; new ignores it. */
export interface BrowserTabRequest {
  sessionId: string;
  action: BrowserTabAction;
  tabId?: number;
}

/** The request half of starting a session; see CreatedSession for the reply. */
export interface CreateSessionRequest {
  /**
   * The user sidebar section the new session belongs to. Main assigns it right after minting the
   * id and before replying, so the row never shows in the default groups first.
   */
  sectionId?: string;
}

/**
 * A new session, plus the sidebar sections as main left them when the request named a section.
 * The renderer applies both together, so the row's first render is already inside the section.
 *
 * `placementFailed` means a section was asked for but the change could not be saved; the
 * session still exists and starts in the default groups.
 */
export interface CreatedSession {
  session: ChatSessionSummary;
  sidebarSections?: SidebarSectionsState;
  placementFailed?: boolean;
}

/** A Code session's create request, plus the same optional section the Chat one takes. */
export type CreateCodeSessionIpcRequest = CreateCodeSessionRequest & CreateSessionRequest;

/** A Code session's create reply - `ok: false` never carries placement. */
export type CreateCodeSessionIpcResult = ({ ok: true } & CreatedSession) | { ok: false; error: string };

/** The whole surface exposed on `window.b4m`. Mirrored in src/preload/index.d.ts. */
export interface DesktopApi {
  getAppInfo(): Promise<AppInfo>;
  update: {
    getState(): Promise<UpdateState>;
    /** Resolves when the check finishes; the OUTCOME arrives on onStateChanged. */
    check(): Promise<void>;
    download(): Promise<void>;
    /** Hide the "update available" notice for this version only. Arrives back on onStateChanged. */
    dismiss(version: string): Promise<void>;
    /**
     * Restart into the new version. Without `force` this reports what is still running and
     * does nothing, so the renderer can put that to the user before anything is lost.
     */
    install(force: boolean): Promise<UpdateInstallResult>;
    onStateChanged(listener: (state: UpdateState) => void): () => void;
  };
  models: {
    getStatus(): Promise<ModelRuntimeStatus>;
    listInstalled(): Promise<InstalledModelsResult>;
    search(request: HubSearchRequest): Promise<HubSearchResult>;
    getDetail(repo: string): Promise<HubDetailResult>;
    listCurated(): Promise<CuratedList>;
    getCuratedPull(entryId: string, buildId: string): Promise<CuratedPullResult>;
    /** Checks an installed curated build against its review again, after Ollama could not describe it. */
    checkCurated(entryId: string, buildId: string): Promise<CuratedCheckResult>;
    /** Checks for a newer curated list now. */
    checkCuratedList(): Promise<void>;
    getCuratedSettings(): Promise<CuratedListSettings>;
    setCuratedEnabled(enabled: boolean): Promise<CuratedListSettings>;
    onCuratedChanged(listener: () => void): () => void;
    listPulls(): Promise<ModelPull[]>;
    pull(request: ModelPullRequest): Promise<ModelPullResult>;
    cancelPull(key: string): Promise<void>;
    dismissPull(key: string): Promise<void>;
    remove(name: string): Promise<ModelRemoveResult>;
    /** Whether a Hugging Face token is saved; the token itself never comes back to the renderer. */
    getHfToken(): Promise<HfTokenStatus>;
    /** Saves the token once Hugging Face accepts it. */
    setHfToken(token: string): Promise<HfTokenResult>;
    clearHfToken(): Promise<HfTokenResult>;
    onHfTokenChanged(listener: (status: HfTokenStatus) => void): () => void;
    onPullsChanged(listener: (pulls: ModelPull[]) => void): () => void;
    onInstalledChanged(listener: () => void): () => void;
  };
  auth: {
    getState(): Promise<AuthState>;
    signIn(): Promise<void>;
    cancelSignIn(): Promise<void>;
    signOut(): Promise<void>;
    setEnvironment(selection: EnvironmentSelection): Promise<SetEnvironmentResult>;
    /** Re-run the identity round-trip after the user resolves a policy or MFA block. */
    retryIdentity(): Promise<void>;
    openAccountPage(page: AccountPage): Promise<void>;
    /** Subscribe to main's auth state pushes; returns the unsubscribe. */
    onStateChanged(listener: (state: AuthState) => void): () => void;
  };
  account: {
    /**
     * The signed-in account's credit balance, read fresh from the server each time.
     *
     * Pull rather than push, and deliberately no subscription: the balance changes when a turn
     * SPENDS, which is a moment the renderer already witnesses, so the one caller asks then.
     * A push channel would need main to watch a number only the server knows.
     */
    getCredits(): Promise<AccountCredits>;
    /**
     * The same read as `getCredits`, plus the plan the account is on. For the profile screen,
     * which states balance and plan together and would otherwise describe one account from two
     * round-trips taken at two different instants.
     */
    getProfile(): Promise<AccountProfile>;
  };
  usage: {
    /**
     * The account's own spend over one trailing window.
     *
     * Asked when the profile screen opens, never on app start: these are aggregations over a
     * month of events, and nothing outside that screen draws them. Answers are held for a
     * short while in main - see UsageService - so `force` is what a Refresh needs to get past
     * the cache after a turn has just spent.
     */
    getHistory(window: UsageWindowId, force?: boolean): Promise<AccountUsageResult>;
  };
  fleet: {
    getState(): Promise<FleetState>;
    /** Read Fleet's installer file again. Its key stays in main; the state never carries it. */
    refresh(): Promise<FleetState>;
    /** Off empties the unsent queue, and nothing is recorded until it is on again. */
    setConsent(consent: boolean): Promise<FleetState>;
    sendNow(): Promise<FleetState>;
    onStateChanged(listener: (state: FleetState) => void): () => void;
  };
  chat: {
    /**
     * Models this deployment offers the agent, from the server's own catalog. `force` skips
     * the main-process cache, which is what a "try again" affordance needs.
     */
    listModels(force?: boolean): Promise<ChatModelCatalog>;
    /** The models Settings may pin the next-prompt hint to: small hosted ones, then local ones. */
    listSuggestionModels(): Promise<ChatModelCatalog>;
    /** How local models size their context window; see @shared/localContextSetting. */
    getLocalContext(): Promise<LocalContextSetting>;
    setLocalContext(setting: LocalContextSetting): Promise<LocalContextSetting>;
    /** Which local models each fixed size may not fit, by the memory estimate. */
    getLocalContextFit(): Promise<LocalContextFit>;
    /** Pin a conversation to a model. Null when the session is gone. */
    setSessionModel(sessionId: string, model: string): Promise<ChatSessionSummary | null>;
    /** Device-local only: moves a conversation whose model is not installed to the pick a send would use. */
    settleLocalModel(sessionId: string): Promise<{ session: ChatSessionSummary; notice?: string } | null>;
    setSessionHistory(sessionId: string, enabled: boolean): Promise<ChatSessionSummary | null>;
    searchHistory(query: string): Promise<LocalHistoryResult[]>;
    clearHistory(): Promise<LocalHistoryState>;
    historyState(): Promise<LocalHistoryState>;
    onHistoryChanged(listener: () => void): () => void;
    /** How hard this conversation's model should think. Null when the session is gone. */
    setSessionReasoningEffort(sessionId: string, effort: ReasoningEffortSetting): Promise<ChatSessionSummary | null>;
    /** How long this conversation's prompt cache lives. Null when the session is gone. */
    setSessionPromptCacheTtl(sessionId: string, ttl: PromptCacheTtl): Promise<ChatSessionSummary | null>;
    /** Pin a conversation to the top of the sidebar. Null when the session is gone. */
    setSessionPinned(sessionId: string, pinned: boolean): Promise<ChatSessionSummary | null>;
    /**
     * Set how much this conversation may do without asking. Called from the composer pill, in
     * response to the user clicking it, and from nowhere else - see IPC_CHANNELS above.
     */
    setApprovalMode(sessionId: string, mode: ChatApprovalMode): Promise<ChatSessionSummary | null>;
    /** Move a conversation into or out of the sidebar's Archived section. Reversible. */
    setSessionArchived(sessionId: string, archived: boolean): Promise<ChatSessionSummary | null>;
    listSessions(): Promise<ChatSessionSummary[]>;
    /** Start a Chat session: no project, the mode everything before this was. */
    createSession(request?: CreateSessionRequest): Promise<CreatedSession>;
    /**
     * Start a Code session, creating or adopting its worktree first when one is asked for.
     * A request with no `directory` creates an UNBOUND session, which the chip row then binds.
     */
    createCodeSession(request: CreateCodeSessionIpcRequest): Promise<CreateCodeSessionIpcResult>;
    /**
     * Ground a Code session that already exists: its first directory, or a different directory,
     * branch or workspace choice. Refused while the session is busy - see UpdateProjectResult.
     */
    updateProject(request: UpdateProjectRequest): Promise<UpdateProjectResult>;
    /** Open the OS folder picker for a project root. Null when the user cancels. */
    pickProjectDirectory(): Promise<string | null>;
    /** Recently used project folders that still exist, most recent first. */
    listRecentFolders(): Promise<RecentFolder[]>;
    /** Forget one; the folder itself is untouched. Resolves to the list that is left. */
    removeRecentFolder(directory: string): Promise<RecentFolder[]>;
    /** Read a directory's branches, for the branch chip. */
    inspectProject(directory: string): Promise<ProjectInspection>;
    /**
     * What this Code session's working directory has changed against its base branch, for the
     * changes bar above the composer. Null when there is nothing to show or git cannot answer.
     */
    workspaceChanges(sessionId: string): Promise<WorkspaceChanges | null>;
    /**
     * Share one more folder with this conversation: `path` when given (`/add-dir <path>`), the
     * folder picker otherwise. Allowed at any point in the session, a running turn included.
     */
    addContextDirectory(sessionId: string, path?: string): Promise<ShareDirectoryResult>;
    removeContextDirectory(sessionId: string, directory: string): Promise<ChatSessionSummary | null>;
    /** Null when the session is gone (deleted in another window, or a stale id). */
    getSession(sessionId: string): Promise<ChatSession | null>;
    renameSession(sessionId: string, title: string): Promise<ChatSessionSummary | null>;
    deleteSession(sessionId: string, removeWorktree?: boolean): Promise<void>;
    inspectWorktreeRemoval(sessionId: string): Promise<WorktreeRemoval | null>;
    /** Checkouts under the repository's app worktree root, with the conversation that owns each. */
    listWorktrees(directory: string): Promise<AppWorktree[]>;
    /** Removes the named orphan checkouts, or every safe one when `paths` is omitted. */
    removeWorktrees(directory: string, paths?: string[]): Promise<WorktreeSweepItem[]>;
    /** Reveals a currently listed worktree in the file manager; false when it is not listed. */
    revealWorktree(directory: string, path: string): Promise<boolean>;
    /** Resolves when the turn is accepted; the reply arrives via onStreamEvent. */
    sendMessage(request: SendMessageRequest): Promise<SendMessageResult>;
    /** Stop an in-flight reply, keeping what has streamed so far. No-op if none is running. */
    stopReply(sessionId: string): Promise<void>;
    /**
     * Carry on the last reply if the agent loop's budget cut it short. Streams into the SAME
     * message, so the events are indistinguishable from the turn never having stopped.
     */
    continueReply(sessionId: string): Promise<SendMessageResult>;
    /**
     * `/clear`: insert a context boundary, carrying nothing across. Instant - no model involved.
     * Nothing is deleted; the transcript keeps every message and folds the earlier ones away.
     */
    clearContext(sessionId: string): Promise<ContextBoundaryResult>;
    /**
     * `/compact`: summarise the conversation and insert a boundary carrying that summary.
     *
     * One round trip on the session's own model. Refused while a turn is streaming, and on ANY
     * failure the conversation is left exactly as it was - see ChatService.compactContext.
     */
    compactContext(sessionId: string, focus?: string): Promise<ContextBoundaryResult>;
    /**
     * Guess the message the user is most likely to send next, for the composer to draw greyed
     * out in its empty input. Null when there is nothing worth offering, which includes every
     * failure - this never reports one.
     *
     * Pulled per settled turn by the window that has the conversation open, so the cost falls
     * only where the hint can actually be shown. Calling it is what turns the feature on;
     * whether to call is the renderer's decision (see promptSuggestions.ts).
     *
     * The result is a DRAFT for the input box. Nothing on this channel can send a message.
     * `model` is the Settings pick; null or omitted is automatic.
     */
    suggestNextPrompt(sessionId: string, model?: string | null): Promise<string | null>;
    /**
     * Messages typed ahead for this conversation, waiting for the live turn to finish. Read on
     * open for the same reason as getSessionStatuses: the pushes below carry only CHANGES, and
     * a window opening onto a session that was queued into elsewhere would see nothing.
     */
    getQueuedMessages(sessionId: string): Promise<ChatQueuedMessage[]>;
    /** Take a queued message back; its text returns to the composer. Unknown ids are ignored. */
    cancelQueuedMessage(sessionId: string, queuedId: string): Promise<void>;
    /**
     * Interrupt the live reply and run this queued message next, instead of waiting for the
     * reply to finish. The result arrives on `onQueueChanged` like every other queue change, so
     * every window showing the conversation sees it.
     *
     * A no-op when the turn has already ended, when the id is unknown, and on a relayed
     * message. Unlike `stopReply`, the queue is NOT handed back.
     */
    sendQueuedMessageNow(sessionId: string, queuedId: string): Promise<void>;
    /** Subscribe to queue changes; returns the unsubscribe. */
    onQueueChanged(listener: (event: ChatQueueEvent) => void): () => void;
    /**
     * Start a pending spawn suggestion with the user's edits; allowed while a reply is running.
     * Suggestions arrive with the session itself, and changes as the 'spawn-suggestions' stream
     * event carrying the whole list.
     */
    startSpawnSuggestion(request: StartSpawnSuggestionRequest): Promise<SpawnSuggestionResult>;
    dismissSpawnSuggestion(sessionId: string, suggestionId: string): Promise<SpawnSuggestionResult>;
    /** Open the OS file picker and take in whatever is chosen. Resolves empty if the user cancels. */
    pickAttachments(sessionId: string): Promise<AddAttachmentsResult>;
    /** Take in dropped or pasted files. The bytes are written to disk before this resolves. */
    addAttachments(sessionId: string, inputs: ChatAttachmentInput[]): Promise<AddAttachmentsResult>;
    /**
     * The stored bytes of one attachment, for showing it: a `data:` URL for an image, the text
     * itself for a text file. Null when the file is gone from disk.
     */
    readAttachment(sessionId: string, attachmentId: string, mediaType: string): Promise<string | null>;
    /** Throw away an attachment the user removed before sending. Unknown ids are ignored. */
    discardAttachment(sessionId: string, attachmentId: string): Promise<void>;
    /** One image context menu item, run in main against a ref main resolves itself. Never rejects. */
    imageAction(image: ChatImageRef, action: ChatImageAction): Promise<ChatImageActionResult>;
    /** Add a thread image to this session's draft, through the same intake as a paste. */
    attachImage(sessionId: string, image: ChatImageRef): Promise<AddAttachmentsResult>;
    /**
     * Answer a tool call sitting at 'awaiting-approval'. Unknown or already-answered ids are
     * ignored, so a double click cannot approve a second, different command.
     */
    respondToApproval(approvalId: string, answer: ChatApprovalAnswer): Promise<void>;
    /**
     * Every artifact this account has made from a desktop client, newest first.
     *
     * Read from the SERVER, not from the local session files, so it spans machines and shows
     * whatever the current body is. Never rejects: an offline or signed-out read comes back as
     * `error` on the result, which the panel renders (see ChatArtifactLibrary).
     */
    listArtifacts(): Promise<ChatArtifactLibrary>;
    /** One artifact's body, fetched when the user opens its row. Never rejects. */
    readArtifact(artifactId: string): Promise<ChatArtifactContent>;
    /**
     * Publish an artifact so other people can open it, at the visibility named in the request.
     *
     * Outward-facing, and therefore ONLY ever called from an explicit user action: the renderer
     * invokes this from the publish button and from nowhere else. No tool, no model output and
     * no automatic path reaches it - a reply that asks for a publish produces text and nothing
     * more. Never rejects; a refusal comes back as a state the card renders.
     */
    publishArtifact(request: ChatArtifactPublishRequest): Promise<ChatArtifactPublish>;
    /**
     * Whether this artifact already has a publication, read when the user looks at it.
     *
     * One request per artifact, so it is deliberately not part of listArtifacts: a library of
     * hundreds of rows would otherwise be hundreds of queries to draw a list. Null means the
     * artifact has never been published.
     */
    readArtifactPublishState(artifactId: string): Promise<ChatArtifactPublish | null>;
    /** Which publish step is in flight, so a large bundle is not a frozen card. */
    onArtifactPublishProgress(listener: (progress: ChatArtifactPublishProgress) => void): () => void;
    /**
     * Background commands belonging to this conversation, running and recently finished.
     *
     * The renderer holds no state main does not: a window reload loses the live tail but not
     * the processes, so this is called on mount to rejoin whatever is still running.
     */
    listBackgroundProcesses(sessionId: string): Promise<BackgroundProcessInfo[]>;
    /** The newest output of one background process, for the panel after a reload. */
    readBackgroundOutput(sessionId: string, processId: string): Promise<string>;
    /** Stop a background process and everything it spawned. Unknown ids are ignored. */
    stopBackgroundProcess(sessionId: string, processId: string): Promise<void>;
    /**
     * Move a command still running in the foreground to the background, so the turn stops
     * waiting on it. Keyed on the tool call it belongs to, which is what the transcript row
     * already holds. Never rejects; see ChatMoveToBackgroundResult.
     */
    moveCommandToBackground(sessionId: string, callId: string): Promise<ChatMoveToBackgroundResult>;
    /**
     * The conversation's video jobs, oldest first. Asking also resumes polling for any that are
     * unfinished, which is how a job outlives a restart: it picks up when its card is next shown.
     */
    listVideoJobs(sessionId: string): Promise<ChatVideoJob[]>;
    /** Ask the server to cancel; the job's next state arrives as a 'video-job' event. */
    cancelVideoJob(sessionId: string, jobId: string): Promise<void>;
    /** Look again at a job polling gave up on. */
    recheckVideoJob(sessionId: string, jobId: string): Promise<void>;
    /** Open the downloaded clip in the system's default player. */
    openVideo(sessionId: string, jobId: string): Promise<void>;
    /** Save the downloaded clip where the user picks. False when they cancel. */
    saveVideo(sessionId: string, jobId: string): Promise<boolean>;
    /** Copy a freshly signed server link to the clipboard; it expires, so the result says when. */
    copyVideoLink(sessionId: string, jobId: string): Promise<ChatVideoLinkResult>;
    /** Subscribe to reply progress; returns the unsubscribe. */
    onStreamEvent(listener: (event: ChatStreamEvent) => void): () => void;
    /**
     * Every session that is busy right now. Read once on mount to seed the sidebar: the pushes
     * below only describe CHANGES, so a window that opened after a background session hit the
     * approval gate would otherwise never hear about it.
     */
    getSessionStatuses(): Promise<ChatSessionStatusEvent[]>;
    /** Subscribe to per-session status changes; returns the unsubscribe. */
    onSessionStatus(listener: (event: ChatSessionStatusEvent) => void): () => void;
    /**
     * Subscribe to summary changes main made on its own - a generated title. Returns the
     * unsubscribe. Not seeded on mount the way the statuses are: main only ever generates a
     * title for a session whose first prompt it is watching, so a window that missed the push
     * reads the stored title on its next list.
     */
    onSessionSummary(listener: (summary: ChatSessionSummary) => void): () => void;
    /**
     * The skills this conversation can run as `/name`, for the composer picker. Scoped to the
     * session: a Chat session gets the user's own, a Code session also gets its project's once
     * that project is trusted.
     */
    listSkills(sessionId: string): Promise<SkillsState>;
    /**
     * Trust (or untrust) this session's project to contribute its `.claude/skills/`. Called from
     * the picker's prompt in response to a click, and from nowhere else - see IPC_CHANNELS.
     * Returns the state the picker should now draw.
     */
    setProjectSkillsTrusted(sessionId: string, trusted: boolean): Promise<SkillsState>;
  };
  /**
   * The Skill Market, read through main (SkillMarket.ts). Nothing here rejects: a signed-out or
   * failed call comes back as `error` (or `ok: false`) on the result, which the panel renders.
   */
  skillMarket: {
    /** One page of listings, 1-based, with the web's filters. */
    browse(filters: SkillMarketFilters, page: number): Promise<SkillMarketPage>;
    recommended(): Promise<SkillMarketPage>;
    /** A listing's detail, with an update offer when the user's imported copy is behind. */
    listing(ref: SkillMarketListingRef): Promise<SkillMarketDetailResult>;
    /**
     * Import a listing, or update an imported copy in place. On success the next skills read
     * (picker, Customize, a turn) sees it without waiting for the account-skill cache.
     */
    importListing(request: SkillMarketImportRequest): Promise<SkillMarketImportResult>;
    /** The account's market imports, and which have a newer approved version. */
    imports(): Promise<SkillMarketImportsResult>;
    /** Open a market page on the web. False when there was nothing valid to open. */
    openOnWeb(target: SkillMarketWebTarget): Promise<boolean>;
    /**
     * Publishing. Main reads only a skill Customize listed for this session, or what the user
     * picks in the native dialog. Every write runs only from an explicit click, never from chat.
     */
    readLocalSkill(ref: SkillLocalRef): Promise<SkillUploadPreview>;
    pickUploadSource(): Promise<SkillUploadPreview>;
    /** `create` answers `name_taken` rather than overwrite; `update` replaces `targetSkillId`. */
    saveSkill(request: SkillSaveRequest): Promise<SkillSaveResult>;
    organizations(): Promise<SkillMarketOrgsResult>;
    publish(request: SkillPublishRequest): Promise<SkillSubmitResult>;
    /** Writes `fields` to the listing's source skill (when given), then submits a version of it. */
    submitVersion(request: SkillSubmitVersionRequest): Promise<SkillSubmitResult>;
    mine(): Promise<SkillMyListingsResult>;
    withdraw(listingId: string): Promise<SkillActionResult>;
    /** Copies an unlisted listing's share link; main builds it so the token stays there. */
    copyShareLink(listingId: string): Promise<SkillActionResult>;
    /** Opens an exported file's source link. False when the link is not openable. */
    openSource(url: string): Promise<boolean>;
  };
  /**
   * The agent's browser, as something the user can watch.
   *
   * The page takes the user's own clicks and keystrokes directly, and the agent drives it
   * through its tools in main. What is here is the url bar: the one part of driving the page
   * that the user cannot do by clicking on it, because the page has no chrome of its own.
   */
  browser: {
    /** Draw this conversation's page at these bounds, or nothing. Returns what the bar draws. */
    setPane(request: BrowserPaneRequest): Promise<BrowserPaneState>;
    /**
     * The page held off screen since the last null-bounds report, as an image data URL, or null
     * when nothing is held or it painted nothing.
     */
    freezeFrame(request: BrowserFreezeFrameRequest): Promise<string | null>;
    /** Open a url the user typed. Rejects with a reason for a scheme that is refused. */
    navigate(request: BrowserNavigateRequest): Promise<BrowserPaneState>;
    go(request: BrowserGoRequest): Promise<BrowserPaneState>;
    tab(request: BrowserTabRequest): Promise<BrowserPaneState>;
    /** Subscribe to page state; returns the unsubscribe. */
    onPageState(listener: (event: BrowserPageStateEvent) => void): () => void;
    /**
     * The user's own Chrome cookies, for sites they name.
     *
     * Reached from the pane's menu and from nowhere else. Nothing here is a tool, and nothing
     * that crosses it carries a cookie value or a cookie name - see @shared/browserCookies.
     */
    cookies: {
      getState(): Promise<CookieImportState>;
      listProfiles(): Promise<ChromeProfilesResult>;
      /** The sites one profile has cookies for. Decrypts nothing; the Keychain is untouched. */
      listHosts(profileDir: string): Promise<ChromeHostsResult>;
      /** Prompts the Keychain. Only `hosts` are read, and only they go into the jar. */
      import(request: CookieImportRequest): Promise<CookieImportResult>;
      forget(host: string): Promise<CookieImportState>;
      /** Signs the browser out of everything, imported or not. */
      clear(): Promise<CookieImportState>;
      onChanged(listener: (state: CookieImportState) => void): () => void;
    };
  };
  files: {
    /**
     * The absolute path of a dropped File, or '' when it has none (dragged out of a web page,
     * or a clipboard item). Lives in preload because Electron's webUtils is only reachable
     * there; it reads nothing, it only names what the user already dropped.
     */
    pathFor(file: File): string;
  };
  /**
   * The user's MCP servers. Configs travel renderer -> main WITH their secrets (that is where
   * the user types them) and come back without: an McpServersState names a server's env
   * variables and headers and never carries a value. See @shared/mcp.
   */
  mcp: {
    getServers(): Promise<McpServersState>;
    addServer(input: McpServerInput): Promise<McpMutationResult>;
    updateServer(id: string, input: McpServerInput): Promise<McpMutationResult>;
    removeServer(id: string): Promise<McpServersState>;
    setServerEnabled(id: string, enabled: boolean): Promise<McpServersState>;
    /** Drop a connection and dial again, for a server the user has just fixed. */
    reconnectServer(id: string): Promise<McpServersState>;
    /** Subscribe to connection-state pushes; returns the unsubscribe. */
    onChanged(listener: (state: McpServersState) => void): () => void;
  };
  /**
   * Model servers on other machines, "This computer" first. A credential travels renderer -> main
   * on probe, add and update, and never back: a view names only its kind. See @shared/modelServers.
   */
  modelServers: {
    list(): Promise<ModelServerView[]>;
    probe(input: ModelServerProbeInput): Promise<ModelServerProbeResult>;
    add(input: ModelServerAddInput): Promise<ModelServerMutationResult>;
    update(id: string, input: ModelServerUpdateInput): Promise<ModelServerMutationResult>;
    remove(id: string): Promise<ModelServerMutationResult>;
    /** Rechecks one server, or all of them when `id` is omitted. */
    check(id?: string): Promise<ModelServerView[]>;
    onChanged(listener: (servers: ModelServerView[]) => void): () => void;
  };
  /** User-made sidebar sections; see @shared/sidebarSections. */
  sidebar: {
    getSections(): Promise<SidebarSectionsState>;
    /** Makes a section and, when given a session, moves it in. A blank name changes nothing. */
    createSection(name: string, sessionId?: string): Promise<SidebarSectionsState>;
    renameSection(sectionId: string, name: string): Promise<SidebarSectionsState>;
    /** Deletes the section only; its sessions go back to the default groups. */
    deleteSection(sectionId: string): Promise<SidebarSectionsState>;
    /** Null takes the session out of its section. */
    moveSession(sessionId: string, sectionId: string | null): Promise<SidebarSectionsState>;
  };
  tools: {
    getAccess(): Promise<ToolAccessState>;
    /** Opens the OS folder picker. Resolves unchanged if the user cancels. */
    grantAccess(): Promise<ToolAccessState>;
    revokeAccess(root: string): Promise<ToolAccessState>;
  };
  permissions: {
    getState(): Promise<PermissionsState>;
    /** Replaces one scope's lists. Refused, with the reason, when any rule does not parse. */
    setRules(scope: PermissionScope, lists: PermissionRuleLists): Promise<PermissionMutationResult>;
    setSharing(share: boolean): Promise<PermissionsState>;
  };
  capabilities: {
    getState(): Promise<CapabilityLedgerState>;
    revoke(grantId: string): Promise<CapabilityLedgerState>;
  };
  claudeImport: {
    getState(): Promise<ClaudeImportState>;
    setCodeSettings(patch: {
      enabled?: boolean;
      includeSubagents?: boolean;
      projects?: 'all' | string[];
    }): Promise<ClaudeImportState>;
    /** Opens a folder picker in main; `reset` goes back to the default folder instead. */
    pickCodeFolder(reset: boolean): Promise<ClaudeImportState>;
    syncCode(): Promise<ClaudeImportState>;
    /** Opens a file picker in main for an export .zip or conversations.json. */
    importChatExport(): Promise<ClaudeImportResult>;
    /** Opens a folder picker in main; `clear` stops watching instead. */
    setWatchFolder(clear: boolean): Promise<ClaudeImportState>;
    remove(kind: 'claude-code' | 'claude-chat'): Promise<ClaudeRemoveResult>;
    onStateChanged(listener: (state: ClaudeImportState) => void): () => void;
    onSessionsChanged(listener: () => void): () => void;
  };
  pullRequests: {
    /**
     * Say which conversation this window shows (null for none). Answers with its bar, or null
     * when it has no PR; a read starts in main when the one in hand is missing or stale.
     */
    watch(sessionId: string | null): Promise<PrBarState | null>;
    /** Bind a pasted PR URL to the conversation. */
    bind(sessionId: string, url: string): Promise<PrActionResult>;
    dismiss(sessionId: string): Promise<PrActionResult>;
    refresh(sessionId: string): Promise<void>;
    /**
     * Switch one automation on or off for this conversation's PR. Each is consent for THAT PR
     * only; see PrBinding.
     */
    setOption(sessionId: string, option: PrOption, enabled: boolean): Promise<PrActionResult>;
    onStateChanged(listener: (state: PrBarState) => void): () => void;
    /** Every conversation's PR icon for the sidebar, from what main already knows. */
    getSummaries(): Promise<PrSummaryEvent[]>;
    onSummaryChanged(listener: (event: PrSummaryEvent) => void): () => void;
  };
  /**
   * The user's own terminals. Reached from the terminal panel and from nowhere else; the agent
   * has no tool on this surface. See @shared/terminal.
   */
  terminal: {
    list(sessionId: string): Promise<TerminalInfo[]>;
    /** Spawns the conversation's login shell in its working directory, or home with none. */
    create(request: TerminalCreateRequest): Promise<TerminalCreateResult>;
    /** Start receiving one terminal's output; answers with what it already printed. */
    attach(terminalId: string): Promise<TerminalAttachment | null>;
    detach(terminalId: string): void;
    write(terminalId: string, data: string): void;
    resize(terminalId: string, cols: number, rows: number): void;
    /** A fresh shell in the same tab; the old one is ended first. */
    restart(terminalId: string): Promise<TerminalInfo | null>;
    /** Ends the shell and drops the tab. */
    close(terminalId: string): Promise<void>;
    onData(listener: (event: TerminalDataEvent) => void): () => void;
    onChanged(listener: (event: TerminalsChangedEvent) => void): () => void;
  };
  shell: {
    /**
     * Hand a link to the user's real browser. Used by links in a reply, which must never be
     * followed in this window - see the `a` renderer in ReplyMarkdown.
     *
     * The url is untrusted: it comes out of model output. Main refuses anything that is not
     * http, https or mailto, so this resolves either way and the caller cannot tell whether
     * the link was opened. Nothing about a link in a reply needs to know.
     */
    openExternal(url: string): Promise<void>;
  };
  /**
   * The developer log window's own surface. Used by the `#/dev-logs` route and nothing else.
   */
  devLog: {
    /** Everything retained so far. Pushes carry only what arrives after; ids say which. */
    getSnapshot(): Promise<DevLogSnapshot>;
    /** Empty the buffer in main as well as the window, so the memory actually goes. */
    clear(): Promise<void>;
    /** Put the lines the window is showing on the clipboard. */
    copy(text: string): Promise<void>;
    /** Subscribe to batches of newly captured records; returns the unsubscribe. */
    onRecords(listener: (records: DevLogRecord[]) => void): () => void;
  };
}
