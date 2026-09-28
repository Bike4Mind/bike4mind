/**
 * The chat vocabulary that crosses the contextBridge.
 *
 * Sessions are stored on this machine, not on the server - the desktop client follows the
 * CLI's completion path (`POST /api/ai/v1/completions`), which is stateless: it takes a
 * message array and streams a reply, and knows nothing about sessions. A consequence worth
 * knowing before you look for them: desktop conversations do not appear in the web app.
 *
 * Credential-free like @shared/auth, for the same reason - see src/shared/ipc.ts.
 */

export type ChatRole = 'user' | 'assistant';

export type ChatToolStatus = 'awaiting-approval' | 'running' | 'done' | 'error' | 'denied';

/**
 * One tool the model asked for, and what running it produced.
 *
 * The loop runs in the main process: the model names a tool, main executes it locally and
 * feeds the result back, so the model never touches the filesystem itself.
 */
export interface ChatToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: ChatToolStatus;
  /** Truncated for display; the model receives the full (size-capped) result. */
  preview?: string;
  error?: string;
  /**
   * Set only while `status` is 'awaiting-approval': the token to pass back to
   * `respondToApproval`. The tool is not running and has had no effect until that answer
   * arrives, so a renderer that never answers leaves the machine untouched.
   */
  approvalId?: string;
  /** What the user is being asked to allow, ready to display. Set with `approvalId`. */
  approvalDetail?: string;
}

/**
 * 'always' repeats the approval for identical later calls in the SAME conversation, and is
 * forgotten when the app exits. It is matched on the exact request - an approved `git status`
 * does not carry over to `git status; rm -rf ~`.
 */
export type ChatApprovalDecision = 'once' | 'always' | 'deny';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  /** Tools this assistant turn ran, in the order the model asked for them. */
  toolCalls?: ChatToolCall[];
  /**
   * Provider-shaped reasoning blocks (Anthropic extended thinking). Opaque: they are replayed
   * verbatim into the next request, because dropping them breaks thinking-plus-tools turns.
   */
  thinking?: unknown[];
  /**
   * Normalized reason generation ended, on assistant messages. 'max_tokens' means the reply
   * was CUT OFF rather than finished; 'aborted' is this client stopping it.
   */
  stopReason?: string;
  /** Set instead of a reply when the turn failed; the message is kept so the thread shows why. */
  error?: string;
}

/**
 * One model this deployment offers, as the picker renders it.
 *
 * Sourced from `GET /api/models`, which builds the list from the calling account's effective
 * provider keys - so this is genuinely per-deployment and per-account, and the desktop client
 * never ships a list of its own.
 */
export interface ChatModelOption {
  id: string;
  name: string;
  /** Provider serving it ("anthropic", "ollama", ...). Shown as a secondary label. */
  backend?: string;
  contextWindow?: number;
}

/**
 * The answer to `listModels`.
 *
 * `error` set means the list could not be READ (offline, signed out, server error) and says
 * nothing about what the deployment offers. An empty list with no error is the other case: the
 * server answered, and holds no model this client can drive. The picker distinguishes the two,
 * because "try again" is only useful advice for the first.
 */
export interface ChatModelCatalog {
  models: ChatModelOption[];
  error?: string;
}

/** Token counts for a finished turn. Absent when the server sent none. */
export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
}

interface ChatSessionMeta {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

/** A session without its messages - what the sidebar needs, so a long thread is not loaded to list it. */
export interface ChatSessionSummary extends ChatSessionMeta {
  messageCount: number;
}

export interface ChatSession extends ChatSessionMeta {
  messages: ChatMessage[];
}

/**
 * Reply progress, pushed main -> renderer. Every event carries both ids so a renderer showing
 * one session can drop events belonging to another that is still streaming in the background.
 *
 * Exactly one terminal event ('done' | 'error') follows a 'start'. A stopped reply is a 'done'
 * with `stopReason: 'aborted'` and whatever text had arrived, not an error - the partial reply
 * is kept, matching what the user saw on screen when they pressed stop.
 */
export type ChatStreamEvent =
  | { type: 'start'; sessionId: string; messageId: string }
  | { type: 'delta'; sessionId: string; messageId: string; text: string }
  | { type: 'tool-start'; sessionId: string; messageId: string; call: ChatToolCall }
  | { type: 'tool-end'; sessionId: string; messageId: string; call: ChatToolCall }
  | {
      type: 'done';
      sessionId: string;
      messageId: string;
      content: string;
      stopReason?: string;
      usage?: ChatUsage;
      toolCalls?: ChatToolCall[];
    }
  | { type: 'error'; sessionId: string; messageId: string; message: string };

export interface SendMessageRequest {
  sessionId: string;
  text: string;
}

/**
 * `sendMessage` resolves as soon as the turn is accepted, not when the reply finishes - the
 * reply arrives as stream events. A rejection here means the turn never started.
 */
export type SendMessageResult =
  | {
      ok: true;
      messageId: string;
      /**
       * Set when accepting the turn changed something the user did not ask for - today only
       * a model substitution, when the conversation's saved model is no longer offered by
       * this deployment. Shown once, beside the composer; not an error.
       */
      notice?: string;
    }
  | { ok: false; error: string };

/**
 * Folders the tools are allowed to touch.
 *
 * Nothing is readable until the user grants a root. The model drives these tools, so the
 * grant is the only thing standing between a crafted prompt and the rest of the disk -
 * enforcement lives in main (src/main/chat/tools/paths.ts), and this type is only the view
 * of it that the settings UI renders.
 */
export interface ToolAccessState {
  /** Absolute paths, each granting its whole subtree. */
  roots: string[];
}
