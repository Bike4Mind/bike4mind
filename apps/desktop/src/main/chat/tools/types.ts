import type { ChatDiff } from '@shared/chat';

import type { BackgroundProcessRegistry } from './BackgroundProcessRegistry';

/** Everything a tool may use. Deliberately narrow: no api client, no token. */
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
