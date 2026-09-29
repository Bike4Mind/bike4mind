import type { ChatDiff, ChatMedia, ChatSessionSummary, ChatToolNotice, RelayRefusal, SpawnRefusal } from '@shared/chat';

import type { MediaApiClient } from '../media/MediaApiClient';
import type { MediaStore } from '../media/MediaStore';
import type { BackgroundProcessRegistry } from './BackgroundProcessRegistry';

/**
 * What the server-backed generation tools need, and nothing else.
 *
 * This is the one place a tool is handed an API client. The local tools are deliberately given
 * none - they touch the filesystem and have no business on the network - but image generation
 * and speech synthesis ARE calls to b4m, so refusing them a client would only mean routing the
 * same request through a wrapper that pretends otherwise. The client is the app's own
 * authenticated session; the token itself is still never exposed.
 */
export interface MediaContext {
  client: MediaApiClient;
  store: MediaStore;
  /** Base for generated-file URLs, from serverConfig. Relative on self-host, absolute on a CDN. */
  cdnUrl: string;
  /** Names the notebook the server creates for this conversation's first generation. */
  notebookName: string;
  /** Image models this deployment offers. Lazy: a turn with no image generation never asks. */
  listImageModels(): Promise<string[]>;
  getRemoteSessionId(): string | undefined;
  setRemoteSessionId(remoteSessionId: string): Promise<void>;
}

/**
 * Side channels a tool can push to besides its return value, wired per call by ChatService.
 *
 * Absent in tests and anywhere a tool is run outside the chat loop; every tool treats it as
 * optional and keeps working without it, just more quietly.
 */
export interface ToolReporter {
  /** Replaces the previous line. For work measured in tens of seconds. */
  progress(text: string): void;
  /** Attach a generated image or audio clip to this call, for the UI only - not sent to the model. */
  media(item: ChatMedia): void;
  /** Raise a cost or provider outcome to its own state; see ChatToolNotice. */
  notice(notice: ChatToolNotice): void;
  /** Name this call's collapsed row, for a tool whose arguments do not read as one. */
  label(text: string): void;
}

/**
 * Everything a tool may use. Narrow by default: no api client and no token, except for the
 * server-backed generation tools, which get exactly {@link MediaContext}.
 */
export interface ToolContext {
  /** Granted roots. Empty means the user has allowed nothing, and every path tool denies. */
  roots: readonly string[];
  /**
   * Where this session's work happens: a Code session's resolved working directory, which is
   * its worktree when the workspace toggle is on. Commands default to running here and
   * relative paths resolve against it.
   *
   * Absent for a Chat session, which is grounded in nothing in particular and falls back to the
   * first granted root. This field is the whole reason a Code session bound to a worktree does
   * not quietly run its commands in the main checkout.
   */
  workingDirectory?: string;
  signal: AbortSignal;
  /**
   * Paths the app protects whatever the user granted - its own userData above all, which holds
   * the access token. A granted home folder would otherwise expose the vault to a shell command.
   */
  protectedPaths?: readonly string[];
  /**
   * The conversation this call belongs to. Background processes are scoped by it, so one
   * conversation cannot read or stop another's just by naming a handle.
   */
  sessionId?: string;
  /** Absent in tests and in builds without it; the background tools then refuse rather than run. */
  background?: BackgroundProcessRegistry;
  /** Absent when signed out, and in tests; the generation tools then refuse rather than run. */
  media?: MediaContext;
  /** Absent outside a Code session; the host-control tools are then not declared at all. */
  host?: HostContext;
  /** Absent outside the chat loop; every tool treats it as optional. */
  report?: ToolReporter;
}

/** What one session looks like to the host-control tools. */
export interface HostSessionView {
  id: string;
  title: string;
  /** Message count, and the timestamps the sidebar orders by. */
  messageCount: number;
  updatedAt: string;
  archived: boolean;
  /** Set when the agent spawned it; `self` marks the calling conversation's own children. */
  spawnedBy?: string;
  /** Present-tense state, the same one the sidebar row draws. */
  status: 'processing' | 'needs-action' | 'done';
}

/** A spawn that did not happen, and which of the caps or preconditions stopped it. */
export interface SpawnRejected {
  ok: false;
  reason: SpawnRefusal;
  message: string;
}

export type SpawnOutcome = { ok: true; session: ChatSessionSummary } | SpawnRejected;

/**
 * A delivered message, and whether the target took it up straight away.
 *
 * `title` is what the caller's transcript row names, resolved here because the model only ever
 * had the id. `queued` is the honest half: the target was mid-reply, so the message is waiting
 * behind that turn rather than running now.
 */
export interface RelayAccepted {
  ok: true;
  sessionId: string;
  title: string;
  queued: boolean;
}

export interface RelayRejected {
  ok: false;
  reason: RelayRefusal;
  message: string;
}

export type RelayOutcome = RelayAccepted | RelayRejected;

/**
 * The app itself, as a tool may drive it. Offered to Code sessions only.
 *
 * This is the third tool family, beside the local tools (filesystem risk) and the generation
 * tools (credit risk); its risk is that the agent changes what the USER sees - it can start
 * work that spends credits without them typing anything, and it can remove a conversation.
 *
 * Deliberately narrow, and narrow in a specific direction: everything here is scoped to the
 * calling session's own project, and `spawn` copies the caller's folder grants verbatim rather
 * than taking any of its own. There is no way through this interface to widen what the agent
 * may touch, which is the invariant the whole family rests on.
 */
export interface HostContext {
  /**
   * Start a session under this one's project and set it running on `prompt`.
   *
   * Refused rather than queued when a cap is hit; see SpawnRefusal for which caps and why the
   * model is told them apart.
   */
  spawn(prompt: string, title?: string): Promise<SpawnOutcome>;
  /** Sessions in this one's project, newest first. Includes archived ones, flagged as such. */
  listSessions(options: { includeArchived: boolean }): Promise<HostSessionView[]>;
  /** One session's transcript as plain text, or null when it is gone or not in this project. */
  readSession(sessionId: string): Promise<string | null>;
  /** Reversible; the row moves to the sidebar's Archived section. Null when not addressable. */
  setArchived(sessionId: string, archived: boolean): Promise<HostSessionView | null>;
  /** Irreversible. False when the id names nothing this session may address. */
  deleteSession(sessionId: string): Promise<boolean>;
  /** How a session is described in an approval prompt, so the user reads a title not a uuid. */
  describeSession(sessionId: string): Promise<string | null>;
  /**
   * Deliver `message` to an existing session in this project and let it run as a turn there.
   *
   * Fire and forget, like `spawn`: it resolves once the message is accepted, never when the
   * target has answered. Waiting would deadlock the moment the target parks at the approval
   * gate, which is a state only the user can leave.
   *
   * Bounded by the hop count on the relay and by the sends this turn has already made; see
   * ChatRelayOrigin. A refusal here is the bound working, not a transient failure.
   */
  sendTo(sessionId: string, message: string): Promise<RelayOutcome>;
}

/** What the user is asked to allow before a tool runs, for tools that declare `approval`. */
export interface ApprovalPrompt {
  /** Shown to the user verbatim. */
  detail: string;
  /** Identity for "always allow": two calls share a key only if they would do the same thing. */
  key: string;
  /**
   * The change a write tool proposes, shown under `detail`. Computed from the file as it is
   * on disk right now, before anything is written.
   */
  diff?: ChatDiff;
  /**
   * This call cannot be undone, so it is asked EVERY time: a standing approval is neither
   * honoured nor recordable against it, and the card does not offer one. Deleting a
   * conversation is the case this exists for.
   */
  irreversible?: true;
}

/** Wire shape the completions endpoint expects, matching CompletionToolSchema in common. */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface ToolDefinition {
  schema: ToolSchema;
  /**
   * Declared by tools that run code or change something. The gate is enforced by ChatService,
   * not here, so a tool cannot run itself past it by forgetting to ask.
   *
   * May be async and may touch the filesystem, because a write tool has to read the file to
   * say what it would change. Throwing here refuses the call WITHOUT asking the user - which
   * is what a write outside a granted folder must do, rather than being prompted around.
   */
  approval?(input: Record<string, unknown>, context: ToolContext): ApprovalPrompt | Promise<ApprovalPrompt>;
  /** Returns the text handed back to the model. Throwing is reported to it as a failure. */
  run(input: Record<string, unknown>, context: ToolContext): Promise<string>;
}

/**
 * Ceiling on what one tool may feed back into the conversation. A directory listing or a
 * large file would otherwise blow the context window in a single turn, and every later turn
 * resends it - this endpoint is stateless, so the cost recurs rather than being paid once.
 */
export const MAX_TOOL_OUTPUT_CHARS = 30_000;

export function capOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n[truncated: ${text.length - MAX_TOOL_OUTPUT_CHARS} more characters]`;
}

/** Read a required string argument, failing loudly rather than coercing a wrong type. */
export function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`The "${key}" argument is required and must be a non-empty string.`);
  }
  return value;
}

export function optionalNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
