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

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  /**
   * Normalized reason generation ended, on assistant messages. 'max_tokens' means the reply
   * was CUT OFF rather than finished; 'aborted' is this client stopping it.
   */
  stopReason?: string;
  /** Set instead of a reply when the turn failed; the message is kept so the thread shows why. */
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
  | {
      type: 'done';
      sessionId: string;
      messageId: string;
      content: string;
      stopReason?: string;
      usage?: ChatUsage;
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
export type SendMessageResult = { ok: true; messageId: string } | { ok: false; error: string };
