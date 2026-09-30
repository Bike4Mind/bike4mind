import type { AccountPage, AuthState, EnvironmentSelection, SetEnvironmentResult } from './auth';
import type { McpMutationResult, McpServerInput, McpServersState } from './mcp';
import type {
  AddAttachmentsResult,
  BackgroundProcessInfo,
  ChatApprovalDecision,
  ChatApprovalMode,
  ChatArtifactContent,
  ChatArtifactLibrary,
  ChatAttachmentInput,
  ChatModelCatalog,
  ChatPendingApproval,
  ChatQueueEvent,
  ChatQueuedMessage,
  ChatSession,
  ChatSessionStatusEvent,
  ChatSessionSummary,
  ChatStreamEvent,
  CreateCodeSessionRequest,
  CreateCodeSessionResult,
  ProjectInspection,
  SendMessageRequest,
  SendMessageResult,
  ToolAccessState,
  UpdateProjectRequest,
  UpdateProjectResult,
} from './chat';
import type { SkillsState } from './skills';
import type { UpdateInstallResult, UpdateState } from './update';

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
  chatListModels: 'chat:list-models',
  chatSetSessionModel: 'chat:set-session-model',
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
  chatInspectProject: 'chat:inspect-project',
  chatAddContextDirectory: 'chat:add-context-directory',
  chatRemoveContextDirectory: 'chat:remove-context-directory',
  chatGetSession: 'chat:get-session',
  chatRenameSession: 'chat:rename-session',
  chatDeleteSession: 'chat:delete-session',
  chatSendMessage: 'chat:send-message',
  chatStopReply: 'chat:stop-reply',
  chatContinueReply: 'chat:continue-reply',
  chatSuggestNextPrompt: 'chat:suggest-next-prompt',
  chatGetQueued: 'chat:get-queued',
  chatCancelQueued: 'chat:cancel-queued',
  /** main -> renderer push; one session's queue of typed-ahead messages changed. */
  chatQueueChanged: 'chat:queue-changed',
  chatRespondToApproval: 'chat:respond-to-approval',
  chatPickAttachments: 'chat:pick-attachments',
  chatAddAttachments: 'chat:add-attachments',
  chatReadAttachment: 'chat:read-attachment',
  chatDiscardAttachment: 'chat:discard-attachment',
  chatListArtifacts: 'chat:list-artifacts',
  chatReadArtifact: 'chat:read-artifact',
  chatListBackground: 'chat:list-background',
  chatReadBackground: 'chat:read-background',
  chatStopBackground: 'chat:stop-background',
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
  chatGetPendingApprovals: 'chat:get-pending-approvals',
  chatListSkills: 'chat:list-skills',
  /**
   * The one way a project's skills become loadable. Renderer -> main only, driven by the
   * picker's trust prompt: a project skill is instruction text that arrived with a clone, so
   * nothing the MODEL can reach may widen this - the same rule as toolsGrantAccess.
   */
  chatSetProjectSkillsTrusted: 'chat:set-project-skills-trusted',
  /** main -> renderer push; the whole set of approvals waiting on the user, whenever it moves. */
  chatPendingApprovals: 'chat:pending-approvals',
  mcpGetServers: 'mcp:get-servers',
  mcpAddServer: 'mcp:add-server',
  mcpUpdateServer: 'mcp:update-server',
  mcpRemoveServer: 'mcp:remove-server',
  mcpSetServerEnabled: 'mcp:set-server-enabled',
  mcpReconnectServer: 'mcp:reconnect-server',
  /** main -> renderer push; a server changed state, which the renderer never polls for. */
  mcpServersChanged: 'mcp:servers-changed',
  toolsGetAccess: 'tools:get-access',
  toolsGrantAccess: 'tools:grant-access',
  toolsRevokeAccess: 'tools:revoke-access',
  updateGetState: 'update:get-state',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  /** The one channel that can end this process. Main gates it on work in flight. */
  updateInstall: 'update:install',
  /** main -> renderer push; a check, a download or an install offer changed state. */
  updateStateChanged: 'update:state-changed',
  /** Renderer -> main only. Main decides what may be opened; see isExternallyOpenable. */
  shellOpenExternal: 'shell:open-external',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export interface AppInfo {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
}

/** The whole surface exposed on `window.b4m`. Mirrored in src/preload/index.d.ts. */
export interface DesktopApi {
  getAppInfo(): Promise<AppInfo>;
  update: {
    getState(): Promise<UpdateState>;
    /** Resolves when the check finishes; the OUTCOME arrives on onStateChanged. */
    check(): Promise<void>;
    download(): Promise<void>;
    /**
     * Restart into the new version. Without `force` this reports what is still running and
     * does nothing, so the renderer can put that to the user before anything is lost.
     */
    install(force: boolean): Promise<UpdateInstallResult>;
    onStateChanged(listener: (state: UpdateState) => void): () => void;
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
  chat: {
    /**
     * Models this deployment offers the agent, from the server's own catalog. `force` skips
     * the main-process cache, which is what a "try again" affordance needs.
     */
    listModels(force?: boolean): Promise<ChatModelCatalog>;
    /** Pin a conversation to a model. Null when the session is gone. */
    setSessionModel(sessionId: string, model: string): Promise<ChatSessionSummary | null>;
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
    createSession(): Promise<ChatSessionSummary>;
    /**
     * Start a Code session, creating or adopting its worktree first when one is asked for.
     * A request with no `directory` creates an UNBOUND session, which the chip row then binds.
     */
    createCodeSession(request: CreateCodeSessionRequest): Promise<CreateCodeSessionResult>;
    /**
     * Ground a Code session that already exists: its first directory, or a different directory,
     * branch or workspace choice. Refused while the session is busy - see UpdateProjectResult.
     */
    updateProject(request: UpdateProjectRequest): Promise<UpdateProjectResult>;
    /** Open the OS folder picker for a project root. Null when the user cancels. */
    pickProjectDirectory(): Promise<string | null>;
    /** Read a directory's branches, for the branch chip. */
    inspectProject(directory: string): Promise<ProjectInspection>;
    /** Grant one more folder to a Code session. Opens the folder picker; null when cancelled. */
    addContextDirectory(sessionId: string): Promise<ChatSessionSummary | null>;
    removeContextDirectory(sessionId: string, directory: string): Promise<ChatSessionSummary | null>;
    /** Null when the session is gone (deleted in another window, or a stale id). */
    getSession(sessionId: string): Promise<ChatSession | null>;
    renameSession(sessionId: string, title: string): Promise<ChatSessionSummary | null>;
    deleteSession(sessionId: string): Promise<void>;
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
     * Guess the message the user is most likely to send next, for the composer to draw greyed
     * out in its empty input. Null when there is nothing worth offering, which includes every
     * failure - this never reports one.
     *
     * Pulled per settled turn by the window that has the conversation open, so the cost falls
     * only where the hint can actually be shown. Calling it is what turns the feature on;
     * whether to call is the renderer's decision (see promptSuggestions.ts).
     *
     * The result is a DRAFT for the input box. Nothing on this channel can send a message.
     */
    suggestNextPrompt(sessionId: string): Promise<string | null>;
    /**
     * Messages typed ahead for this conversation, waiting for the live turn to finish. Read on
     * open for the same reason as getSessionStatuses: the pushes below carry only CHANGES, and
     * a window opening onto a session that was queued into elsewhere would see nothing.
     */
    getQueuedMessages(sessionId: string): Promise<ChatQueuedMessage[]>;
    /** Take a queued message back; its text returns to the composer. Unknown ids are ignored. */
    cancelQueuedMessage(sessionId: string, queuedId: string): Promise<void>;
    /** Subscribe to queue changes; returns the unsubscribe. */
    onQueueChanged(listener: (event: ChatQueueEvent) => void): () => void;
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
    /**
     * Answer a tool call sitting at 'awaiting-approval'. Unknown or already-answered ids are
     * ignored, so a double click cannot approve a second, different command.
     */
    respondToApproval(approvalId: string, decision: ChatApprovalDecision): Promise<void>;
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
     * Every tool call waiting on the user, in any conversation.
     *
     * Read once on mount for the same reason as the statuses above, and pushed whole rather
     * than as deltas: the set is small, and a renderer that missed one push would otherwise be
     * left showing an approval that has already been answered.
     */
    getPendingApprovals(): Promise<ChatPendingApproval[]>;
    /** Subscribe to the pending-approval set; returns the unsubscribe. */
    onPendingApprovals(listener: (pending: ChatPendingApproval[]) => void): () => void;
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
  tools: {
    getAccess(): Promise<ToolAccessState>;
    /** Opens the OS folder picker. Resolves unchanged if the user cancels. */
    grantAccess(): Promise<ToolAccessState>;
    revokeAccess(root: string): Promise<ToolAccessState>;
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
}
