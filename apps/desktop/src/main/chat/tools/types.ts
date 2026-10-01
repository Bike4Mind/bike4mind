import type { CustomCommand } from '@bike4mind/cli/skills';
import type {
  ChatApprovalOption,
  ChatDiff,
  ChatToolDetail,
  ChatMedia,
  ChatSessionSummary,
  ChatToolNotice,
  ChatUsage,
  RelayRefusal,
  SpawnRefusal,
} from '@shared/chat';

import type { CompletionRequest } from '../completions';
import type { CompletionStreamEvent } from '../streamEvents';

import type { MemoryStore } from '../project/memory';
import type { MediaApiClient } from '../media/MediaApiClient';
import type { MediaStore } from '../media/MediaStore';
import type { BackgroundProcessRegistry } from './BackgroundProcessRegistry';
import type { ForegroundCommandRegistry } from './ForegroundCommandRegistry';

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
 * What the `explore` tool needs to run its own completion loop: the turn's transport, a model
 * cheaper than the turn's, and somewhere to bill what it spends.
 *
 * Handed over as a narrow transport rather than an api client, for the same reason MediaContext
 * is the only other network door: every other tool here stays off the network.
 */
export interface ExploreTarget {
  model: string;
  maxTokens?: number;
  /** Whether `model` accepts `cache: true` on its messages; see supportsPromptCache. */
  cache?: boolean;
}

export interface ExploreContext extends ExploreTarget {
  /**
   * The session's own model, tried when the first request on `model` fails - a spent key or an
   * account limit on the cheaper model should cost the sub-agent's savings, not the whole explore.
   */
  fallback?: ExploreTarget;
  complete(
    request: CompletionRequest,
    onEvent: (event: CompletionStreamEvent) => void,
    signal: AbortSignal
  ): Promise<void>;
  /** Folded into the turn's total, so the status line counts what exploring cost. */
  addUsage(usage: ChatUsage): void;
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
  /**
   * Record what this call changed on disk. Called only once the write has landed: unlike the
   * other channels here, this one is kept off a call that failed. See ChatToolCall.diff.
   */
  diff(value: ChatDiff): void;
  /** Record what a sub-loop spent; see ChatToolCall.detail. */
  detail(value: ChatToolDetail): void;
  /**
   * Show the model an image alongside this call's text result, on the next request only; it is
   * not stored, so a reloaded conversation carries the text result alone.
   */
  image(bytes: Buffer, mimeType: string): void;
  /**
   * This call's command was moved to the background and is still running, so the row settles as
   * 'moved' rather than claiming the command finished here. The handle it became is in the
   * result text the model and the user both read.
   */
  moved(): void;
}

/** One conversation's agent browser: a hidden window with its own cookie jar. */
export interface BrowserPage {
  /** Where the page is now; empty before the first navigation. */
  currentUrl(): string;
  /** Load a URL and wait for it to settle. Resolves with where it ended up. */
  navigate(url: string): Promise<{ url: string; title: string; status?: number }>;
  back(): Promise<void>;
  snapshot(maxChars: number): Promise<{ url: string; title: string; text: string; truncated: boolean }>;
  click(ref: string): Promise<string>;
  fill(ref: string, text: string): Promise<string>;
  /** A named key such as Enter, Tab, Escape or ArrowDown, sent as real input to the focused element. */
  press(key: string): Promise<void>;
  screenshot(): Promise<Buffer>;
  evaluate(expression: string): Promise<unknown>;
  /** Console errors, failed requests and navigations since the last call, oldest first. */
  drainEvents(): string[];
  /** Wait for in-flight navigation and network to go quiet, bounded by `timeoutMs`. */
  settle(timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}

/** What ChatService holds: the Electron BrowserManager in the app, a fake in tests. */
export interface BrowserProvider {
  context(
    sessionId: string,
    keepScreenshot: (bytes: Buffer, caption: string) => Promise<ChatMedia | undefined>
  ): BrowserContext;
  closeSession(sessionId: string): Promise<void>;
}

export interface BrowserContext {
  /** The session's page, opened on first use. */
  page(): Promise<BrowserPage>;
  /** Keep a screenshot for the transcript, so the user sees what the model saw. */
  keepScreenshot(bytes: Buffer, caption: string): Promise<ChatMedia | undefined>;
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
  /**
   * This call's id, as the transcript row and the renderer know it. Absent outside the chat
   * loop, which is also when there is no row for a control to sit on.
   */
  callId?: string;
  /** Absent in tests and in builds without it; the background tools then refuse rather than run. */
  background?: BackgroundProcessRegistry;
  /** Where a running foreground command publishes itself as movable. Absent outside the chat loop. */
  foreground?: ForegroundCommandRegistry;
  /** Absent when signed out, and in tests; the generation tools then refuse rather than run. */
  media?: MediaContext;
  /** Absent outside a Code session; the host-control tools are then not declared at all. */
  host?: HostContext;
  /** Absent in tests and when signed out; `explore` then refuses rather than runs. */
  explore?: ExploreContext;
  /** Absent outside a Code session; the browser tools are then not declared at all. */
  browser?: BrowserContext;
  /**
   * Where this project's memories live. Resolved from the project, never from the tool's
   * arguments: the model names a memory, and nothing it can say chooses the folder.
   */
  memory?: MemoryStore;
  /**
   * The session's skills. Absent when the app has no catalog (tests), and then the `skill` tool
   * is not declared at all.
   */
  skills?: SkillContext;
  /** Absent outside the chat loop; every tool treats it as optional. */
  report?: ToolReporter;
}

/**
 * The skills this conversation may run, as the `skill` tool sees them.
 *
 * A function rather than a list because the catalog is scanned lazily and cached for seconds: a
 * turn that never calls the tool never walks the skill directories. What it returns is already
 * filtered - AI-visible only, and project skills only from a project the user trusted - so the
 * tool has no filtering of its own to forget, and the list it refuses against is the same list
 * the system prompt showed.
 */
export interface SkillContext {
  available(): Promise<readonly CustomCommand[]>;
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
 * Where a spawned session's tools run. Chosen by the USER on the approval card, never by the
 * model - see HostContext for why that distinction is the whole feature.
 *
 * 'worktree' carries a branch of its own rather than inheriting one, and it has to: a worktree
 * is keyed on its branch, so a child handed the parent's branch would be given the parent's
 * checkout back and be isolated in name only.
 */
export type SpawnPlacement = { kind: 'local' } | { kind: 'worktree'; branch: string };

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
 * calling session's own project, and `spawn` can put the child only where the USER said - in
 * the caller's own working directory, or in a worktree of the caller's own repository. There is
 * no way through this interface to widen what the agent may touch, which is the invariant the
 * whole family rests on.
 */
export interface HostContext {
  /**
   * Start a session under this one's project and set it running on `prompt`.
   *
   * `placement` reaches this from the approval card, NOT from the tool's arguments: the schema
   * has no property for it, so a model cannot ask for a directory of its own. That is what keeps
   * the invariant above true now that a child can land somewhere the parent is not.
   *
   * Refused rather than queued when a cap is hit; see SpawnRefusal for which caps and why the
   * model is told them apart.
   */
  spawn(prompt: string, title: string | undefined, placement: SpawnPlacement): Promise<SpawnOutcome>;
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
  /** Instead of `diff`, for a call that changes several files; one entry per file. */
  diffs?: ChatDiff[];
  /**
   * This call cannot be undone, so it is asked EVERY time: a standing approval is neither
   * honoured nor recordable against it, and the card does not offer one. Deleting a
   * conversation is the case this exists for.
   */
  irreversible?: true;
  /**
   * The ways this call may be allowed, when "allow it" is not one question but a choice between
   * several. The card draws a split button; whatever the user picks is folded into the tool's
   * input before `run` sees it.
   */
  choice?: ApprovalChoice;
  /**
   * Asked in 'auto' as well as 'ask' (only 'full' runs it). For a call that is allowed by
   * default but has a specific reason to stop first: a shell command naming a path outside the
   * project, or a read of a `.env` file.
   */
  askInAuto?: true;
  /**
   * For a shell command: what "always allow" remembers. Each sub-command of the script is
   * covered by a prefix pattern, and each directory outside the project by the directory.
   */
  always?: ApprovalAlways;
}

export interface ApprovalAlways {
  /** The tool the patterns belong to: allowing `npm run dev *` for one tool is not allowing it for the other. */
  namespace: string;
  /** One per sub-command, as written; matched against remembered `patterns`. */
  commands: readonly { text: string; pattern: string }[];
  /** Directories outside every granted root that the command reaches. */
  directories: readonly string[];
}

/** See ChatApprovalOption: this is that, plus what main does with the answer. */
export type ApprovalOption = ChatApprovalOption &
  (
    | {
        redirect: true;
        /** What the model is told INSTEAD of running the call. See ChatApprovalDecision. */
        note: string;
      }
    | {
        redirect?: undefined;
        /**
         * Merged into the tool's input when this option is chosen, with the field's value under
         * `field.name`. These properties are deliberately absent from the tool's JSON schema, so
         * the model cannot reach them: the choice is the user's and only the user's.
         */
        input?: Record<string, unknown>;
      }
  );

export interface ApprovalChoice {
  /** The first is the primary action, and the one a standing approval or an auto-approval takes. */
  options: readonly ApprovalOption[];
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
  /**
   * Consulted before `approval`: false lets this call through unasked. For a tool whose risk
   * depends on its target - the browser on a local dev server as against a real site.
   */
  needsApproval?(input: Record<string, unknown>, context: ToolContext): boolean | Promise<boolean>;
  /** Returns the text handed back to the model. Throwing is reported to it as a failure. */
  run(input: Record<string, unknown>, context: ToolContext): Promise<string>;
}

/**
 * Ceiling on what one tool may feed back into the conversation. A directory listing or a
 * large file would otherwise blow the context window in a single turn, and every later turn
 * resends it - this endpoint is stateless, so the cost recurs rather than being paid once.
 */
export const MAX_TOOL_OUTPUT_CHARS = 30_000;

export function capOutput(text: string, limit = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated: ${text.length - limit} more characters]`;
}

/**
 * Like capOutput, but keeps the start and the end and drops the middle. For command output,
 * where the failure and the exit line are at the bottom and a head-only cut discards both.
 * The result never exceeds `limit`, so a later capOutput at the same limit leaves it alone.
 */
export function capOutputMiddle(text: string, limit = MAX_TOOL_OUTPUT_CHARS, headShare = 0.25): string {
  if (text.length <= limit) return text;
  const marker = (dropped: number) => `\n\n[... ${dropped} characters omitted from the middle ...]\n\n`;
  const room = limit - marker(text.length).length;
  const head = Math.floor(room * headShare);
  const tail = room - head;
  return `${text.slice(0, head)}${marker(text.length - head - tail)}${text.slice(text.length - tail)}`;
}

/**
 * Higher than a file or search result because a report quotes the code the caller would otherwise
 * read again; cutting its tail would cut the edit points, which come last.
 */
export const MAX_EXPLORE_REPORT_CHARS = 60_000;

/**
 * About 25K tokens, the size of Claude Code's Read cap. A whole source file is the one result the
 * model needs complete: stopping short costs a second call and a re-read of what came before.
 */
export const MAX_FILE_READ_OUTPUT_CHARS = 100_000;

/** The cap a finished call's result is held to before the model sees it. */
export function outputCapFor(toolName: string): number {
  if (toolName === 'explore') return MAX_EXPLORE_REPORT_CHARS;
  if (toolName === 'file_read') return MAX_FILE_READ_OUTPUT_CHARS;
  return MAX_TOOL_OUTPUT_CHARS;
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
