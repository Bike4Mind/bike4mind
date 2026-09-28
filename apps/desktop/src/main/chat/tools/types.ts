import type { ChatDiff, ChatMedia, ChatToolNotice } from '@shared/chat';

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
}

/**
 * Everything a tool may use. Narrow by default: no api client and no token, except for the
 * server-backed generation tools, which get exactly {@link MediaContext}.
 */
export interface ToolContext {
  /** Granted roots. Empty means the user has allowed nothing, and every path tool denies. */
  roots: readonly string[];
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
  /** Absent outside the chat loop; every tool treats it as optional. */
  report?: ToolReporter;
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
