import type { AccountPage, AuthState, EnvironmentSelection, SetEnvironmentResult } from './auth';
import type {
  ChatApprovalDecision,
  ChatModelCatalog,
  ChatSession,
  ChatSessionSummary,
  ChatStreamEvent,
  SendMessageRequest,
  SendMessageResult,
  ToolAccessState,
} from './chat';

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
  chatListSessions: 'chat:list-sessions',
  chatCreateSession: 'chat:create-session',
  chatGetSession: 'chat:get-session',
  chatRenameSession: 'chat:rename-session',
  chatDeleteSession: 'chat:delete-session',
  chatSendMessage: 'chat:send-message',
  chatStopReply: 'chat:stop-reply',
  chatRespondToApproval: 'chat:respond-to-approval',
  /** main -> renderer push; reply tokens as they arrive. */
  chatStreamEvent: 'chat:stream-event',
  toolsGetAccess: 'tools:get-access',
  toolsGrantAccess: 'tools:grant-access',
  toolsRevokeAccess: 'tools:revoke-access',
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
    listSessions(): Promise<ChatSessionSummary[]>;
    createSession(): Promise<ChatSessionSummary>;
    /** Null when the session is gone (deleted in another window, or a stale id). */
    getSession(sessionId: string): Promise<ChatSession | null>;
    renameSession(sessionId: string, title: string): Promise<ChatSessionSummary | null>;
    deleteSession(sessionId: string): Promise<void>;
    /** Resolves when the turn is accepted; the reply arrives via onStreamEvent. */
    sendMessage(request: SendMessageRequest): Promise<SendMessageResult>;
    /** Stop an in-flight reply, keeping what has streamed so far. No-op if none is running. */
    stopReply(sessionId: string): Promise<void>;
    /**
     * Answer a tool call sitting at 'awaiting-approval'. Unknown or already-answered ids are
     * ignored, so a double click cannot approve a second, different command.
     */
    respondToApproval(approvalId: string, decision: ChatApprovalDecision): Promise<void>;
    /** Subscribe to reply progress; returns the unsubscribe. */
    onStreamEvent(listener: (event: ChatStreamEvent) => void): () => void;
  };
  tools: {
    getAccess(): Promise<ToolAccessState>;
    /** Opens the OS folder picker. Resolves unchanged if the user cancels. */
    grantAccess(): Promise<ToolAccessState>;
    revokeAccess(root: string): Promise<ToolAccessState>;
  };
}
