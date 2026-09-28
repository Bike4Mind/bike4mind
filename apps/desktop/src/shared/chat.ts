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
 * A generated image or audio clip, ready for the renderer to load.
 *
 * `url` is always a `b4m-media://` URL served by the main process out of this app's own media
 * folder - never a data URL, and never the backend's URL. The bytes are fetched once in main
 * and written to disk there: the renderer runs under a CSP that admits neither `data:` media
 * nor an arbitrary remote origin, and inlining megabytes of base64 into a persisted
 * conversation would mean re-reading them on every session switch.
 */
export interface ChatMedia {
  kind: 'image' | 'audio';
  url: string;
  mimeType: string;
  byteLength: number;
  /** What produced it: the image prompt, or the spoken text. Used as the alt text and caption. */
  caption: string;
  /**
   * Id of the browsable copy the server kept, when it kept one. This app cannot open it, but it
   * is how the user finds the same file in the web app's file browser.
   */
  fabFileId?: string;
}

/**
 * An outcome of a server-backed tool that costs money, surfaced on its own rather than folded
 * into the result text.
 *
 * Both of these are things the user is entitled to see without expanding a tool call:
 * 'insufficient-credits' means they were charged nothing and the work did not happen, and
 * 'provider-substituted' means a different vendor - so a different voice - produced what they
 * are about to hear.
 */
export interface ChatToolNotice {
  kind: 'insufficient-credits' | 'provider-substituted';
  text: string;
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
  /**
   * Latest progress line while `status` is 'running'. Only the tools that take tens of seconds
   * report one: image generation polls a server-side job, and a bare spinner is
   * indistinguishable from a hang once it has been turning for half a minute.
   */
  progress?: string;
  /** Images or audio the tool produced, shown inline beneath it. */
  media?: ChatMedia[];
  /** A cost or provider outcome worth its own line; see ChatToolNotice. */
  notice?: ChatToolNotice;
}

/**
 * 'always' repeats the approval for identical later calls in the SAME conversation, and is
 * forgotten when the app exits. It is matched on the exact request - an approved `git status`
 * does not carry over to `git status; rm -rf ~`.
 */
export type ChatApprovalDecision = 'once' | 'always' | 'deny';

/**
 * What the user attached to a turn: an image the model looks at, or a text file inlined into
 * the prompt.
 *
 * Deliberately NOT the same thing as the file tools. The tools are the model going and looking
 * for something; an attachment is the user handing something over - "here is the screenshot of
 * the bug" - and it is in the turn whether or not any folder is shared.
 *
 * The bytes are NOT here. They live beside the session on disk (see main/chat/AttachmentStore),
 * because this descriptor is what gets persisted into the session JSON, and that file is read
 * in full every time the sidebar lists conversations.
 */
export type ChatAttachmentKind = 'image' | 'text';

export interface ChatAttachment {
  id: string;
  kind: ChatAttachmentKind;
  /** Basename, or a generated name for a pasted image. Safe to render: control characters and quotes are stripped. */
  name: string;
  mediaType: string;
  /** Size of what the model receives. For a truncated text file this is smaller than `sourceBytes`. */
  byteSize: number;
  /** Size of the file the user picked, before truncation or downscaling. */
  sourceBytes: number;
  /** Set when the file was too big to send whole; the model is told so in the attachment itself. */
  truncated?: boolean;
}

/**
 * One file on its way in, before it is classified and capped.
 *
 * Two shapes because the three entry paths genuinely differ: the picker and a drop both name a
 * file on disk, so main reads it (and can read only the first slice of a huge log). A pasted
 * screenshot exists only in the clipboard, so its bytes cross IPC.
 */
export type ChatAttachmentInput =
  { source: 'path'; path: string } | { source: 'bytes'; name: string; mediaType?: string; data: Uint8Array };

/** Attachments that made it in, plus the ones that did not and why - a silent drop is worse than a refusal. */
export interface AddAttachmentsResult {
  attachments: ChatAttachment[];
  rejected: { name: string; reason: string }[];
}

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
  /** Files the user attached to this turn. Only ever on a user message. */
  attachments?: ChatAttachment[];
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
  /**
   * Whether this model accepts images. Absent means the server said nothing, which is NOT the
   * same as "no": the catalog only carries the flag for backends that report it, so an attached
   * image is refused on an explicit `false` and allowed through on silence.
   */
  supportsVision?: boolean;
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

/**
 * Chat is the default and is every conversation this client had before modes existed; Code
 * adds project grounding on top of it.
 *
 * Deliberately NOT a tool switch. Both modes carry the same tools - the difference is that a
 * Code session knows which directory it is about, so its tools run there and its conversations
 * group under that project in the sidebar.
 */
export type ChatSessionMode = 'chat' | 'code';

/**
 * What a Code session is grounded in, fixed when the session is created.
 *
 * `workingDirectory` is the one field the tools read, and it is stored rather than recomputed
 * because resolving it can CREATE a worktree: recomputing on every turn would either repeat
 * that work or silently move a conversation to a different checkout halfway through.
 */
export interface ChatProject {
  /** Absolute path the user picked. Also the grouping identity in the sidebar. */
  directory: string;
  /** Basename of `directory`, for the group header. */
  name: string;
  branch: string;
  /** True when the session runs in its own git worktree for `branch` rather than in `directory`. */
  workspace: boolean;
  /**
   * Where this session's tools actually run: the worktree when `workspace` is on, and
   * `directory` when it is off. Always granted to the tools for this session.
   */
  workingDirectory: string;
  /** Extra folders granted to this session alone, on top of `workingDirectory`. */
  contextDirectories: string[];
}

interface ChatSessionMeta {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  mode: ChatSessionMode;
  /** Set on Code sessions only. A Chat session has no project and sits outside the groups. */
  project?: ChatProject;
  /** Pinned to the top of the sidebar, above both the groups and the loose conversations. */
  pinned?: boolean;
}

/** A session without its messages - what the sidebar needs, so a long thread is not loaded to list it. */
export interface ChatSessionSummary extends ChatSessionMeta {
  messageCount: number;
}

export interface ChatSession extends ChatSessionMeta {
  messages: ChatMessage[];
  /**
   * The b4m notebook this conversation files its generations under, created lazily by the
   * server on the first one.
   *
   * Desktop conversations are otherwise purely local (see the header). Image generation is the
   * exception: `POST /api/ai/generate-image` is notebook-scoped and creates one when given no
   * id, so without this every image would leave a separate stray notebook in the web app - and
   * the server's prompt resolver, which reads that notebook's history, could never bind a
   * follow-up like "make it darker" to the image before it.
   */
  remoteSessionId?: string;
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
  | { type: 'tool-progress'; sessionId: string; messageId: string; callId: string; text: string }
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

/**
 * What a session is doing, as the sidebar draws it.
 *
 * 'needs-action' outranks 'processing' whenever both are true, which they are for the whole
 * time a tool sits at the approval gate: the turn is still open, but the model is not what is
 * holding it up - the user is, and they may well be looking at a different conversation.
 */
export type ChatSessionStatus = 'processing' | 'needs-action' | 'done';

/**
 * One session's status changing, pushed main -> renderer.
 *
 * Deliberately NOT a member of ChatStreamEvent. That union is per-reply progress aimed at the
 * open conversation; this is per-session lifecycle for every conversation at once, including
 * ones with no reply in flight and no window showing them. Keeping them apart means neither
 * consumer has to filter the other's traffic, and it lets the snapshot channel that seeds this
 * one carry the same payload shape.
 */
export interface ChatSessionStatusEvent {
  sessionId: string;
  status: ChatSessionStatus;
}

export interface SendMessageRequest {
  sessionId: string;
  text: string;
  /** Descriptors returned by `addAttachments`; their bytes are already on disk. */
  attachments?: ChatAttachment[];
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

/**
 * What the New Code session dialog learned about a directory the user picked.
 *
 * `isRepository: false` is not an error: the directory is still usable as a project, it just
 * has no branches and no worktree to offer, so the dialog hides both controls rather than
 * refusing the folder.
 */
export interface ProjectInspection {
  directory: string;
  name: string;
  isRepository: boolean;
  branches: string[];
  currentBranch: string | null;
  /** Set when git could be asked but answered with a failure; the dialog shows it verbatim. */
  error?: string;
}

export interface CreateCodeSessionRequest {
  directory: string;
  branch: string;
  workspace: boolean;
  contextDirectories?: string[];
}

/**
 * `ok: false` carries the reason the session could not be created - almost always a worktree
 * that could not be made. Nothing is stored when it fails, so there is no half-created session
 * to clean up.
 */
export type CreateCodeSessionResult =
  | {
      ok: true;
      session: ChatSessionSummary;
      /** Set when an existing worktree was adopted. */ reusedWorkspace?: boolean;
    }
  | { ok: false; error: string };

/**
 * A change to what an EXISTING Code session is grounded in. Every field is optional; an
 * omitted one is left as it is.
 *
 * Separate from CreateCodeSessionRequest because the two are not the same act. Creating binds
 * a fresh conversation to a directory; this one moves a conversation that has already been
 * running commands somewhere - see UpdateProjectResult.busy for what that costs.
 */
export interface UpdateProjectRequest {
  sessionId: string;
  /** A different project root. Changing it invalidates the branch, which the caller re-reads. */
  directory?: string;
  branch?: string;
  workspace?: boolean;
}

/**
 * `busy: true` is a refusal on grounds of timing rather than validity: a reply is streaming or
 * a background process is still alive in the CURRENT working directory, and repointing the
 * session would leave that process running in a folder the session no longer claims. The same
 * request succeeds once the session is idle.
 */
export type UpdateProjectResult =
  { ok: true; session: ChatSessionSummary } | { ok: false; error: string; busy?: boolean };
