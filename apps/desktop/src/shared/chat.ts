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
 * One line of a proposed change, as the approval prompt renders it.
 *
 * Structured rather than a unified-diff string: the renderer shows line numbers and colours
 * each line by kind, and parsing "+"/"-" prefixes back out of text would misread any source
 * line that legitimately starts with one.
 */
export type ChatDiffLineKind = 'context' | 'add' | 'remove' | 'gap';

export interface ChatDiffLine {
  kind: ChatDiffLineKind;
  text: string;
  /** Line number before the change; absent on added lines and on gaps. */
  oldLine?: number;
  /** Line number after the change; absent on removed lines and on gaps. */
  newLine?: number;
}

/**
 * What a write tool is about to do, computed BEFORE the user is asked.
 *
 * This is the whole point of the write gate: approving "write file" with no visible change is
 * not informed consent. It describes an intention, never a completed action - nothing has
 * touched the disk when this is shown.
 */
export interface ChatDiff {
  /** Absolute path the change applies to. */
  path: string;
  operation: 'create' | 'overwrite' | 'edit';
  added: number;
  removed: number;
  lines: ChatDiffLine[];
  /** Set when the change was too large to render exactly; `lines` is then a summary of it. */
  truncated?: boolean;
}

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
  /**
   * The change a write tool proposes, set with `approvalId` on tools that edit files. The
   * user sees it before answering; nothing has been written while this is on screen.
   */
  approvalDiff?: ChatDiff;
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

export type BackgroundProcessStatus = 'running' | 'exited' | 'killed' | 'failed';

/**
 * A command started with `bash_background` and left running past the turn that started it.
 *
 * These live in the main process and ONLY in memory: nothing is persisted, and nothing
 * survives a restart. Every exit path kills the process group, so a handle here always refers
 * to something that either is running now or ended during this run of the app.
 */
export interface BackgroundProcessInfo {
  /** Short handle the model passes to `bash_output` and `bash_kill`. */
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  status: BackgroundProcessStatus;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  /** Characters of output currently retained; the buffer keeps a bounded tail. */
  bufferedChars: number;
  /** Characters produced but discarded by that cap. */
  droppedChars: number;
  /** Set when the process could not be spawned at all. */
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
 *
 * The two 'background-*' events are the exception to all of that: a background process outlives
 * the turn that started it, so they keep arriving with no reply in flight and carry no
 * `messageId`. A consumer that only cares about replies must ignore them explicitly rather
 * than treating an unrecognised event as terminal.
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
  | { type: 'error'; sessionId: string; messageId: string; message: string }
  | {
      type: 'background-output';
      sessionId: string;
      processId: string;
      stream: 'stdout' | 'stderr';
      text: string;
    }
  | { type: 'background-status'; sessionId: string; process: BackgroundProcessInfo };

export interface SendMessageRequest {
  sessionId: string;
  text: string;
}

/**
 * `sendMessage` resolves as soon as the turn is accepted, not when the reply finishes - the
 * reply arrives as stream events. A rejection here means the turn never started.
 */
export type SendMessageResult = { ok: true; messageId: string } | { ok: false; error: string };

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
