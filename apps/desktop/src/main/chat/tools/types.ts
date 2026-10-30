import type { CustomCommand } from '@bike4mind/cli/skills';
import type { VideoModel } from '@bike4mind/common';
import type { BrowserSnapshot } from '@shared/browserPage';
import type { McpServerState, McpServersState } from '@shared/mcp';
import type { PrActionResult, PrBindOutcome } from '@shared/pullRequest';
import type {
  ChatApprovalOption,
  ChatDiff,
  ChatToolDetail,
  ChatMedia,
  ChatSessionSummary,
  ChatSpawnSuggestion,
  ChatToolNotice,
  ChatUsage,
  RelayRefusal,
  SpawnRefusal,
} from '@shared/chat';

import type { ScrollTarget } from '../browser/pageScripts';
import type { CompletionRequest } from '../completions';
import type { CompletionStreamEvent } from '../streamEvents';

import type { MemoryStore } from '../project/memory';
import type { MediaApiClient } from '../media/MediaApiClient';
import type { MediaStore } from '../media/MediaStore';
import type { VideoJobScheduler } from '../media/VideoJobScheduler';
import type { BackgroundProcessRegistry } from './BackgroundProcessRegistry';
import type { ForegroundCommandRegistry } from './ForegroundCommandRegistry';
import type { WebSearchTurn } from './webSearchLimits';

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
  /** Video models this caller can use; cached, and read at turn start to decide whether to offer the tool. */
  listVideoModels(): Promise<VideoModel[]>;
  /** Records and follows a created video job. Absent where nothing can follow one. */
  videoJobs?: Pick<VideoJobScheduler, 'track'>;
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
 * The web tools' door to the server: /api/tools/web-search and /api/tools/web-fetch over the
 * app's authenticated session. The server does the reaching - its configured search provider,
 * and its SSRF-guarded fetch - so a model-chosen URL never leaves from this machine.
 *
 * Each resolves with the route's `result` text, unframed. Errors are thrown as they come.
 */
export interface WebContext {
  search(body: { query: string; num_results?: number }, signal: AbortSignal): Promise<string>;
  fetch(body: { url: string; offset?: number }, signal: AbortSignal): Promise<string>;
  /** The turn's budget, slots and cache; see webSearchLimits.ts. Absent, every search is sent. */
  searches?: WebSearchTurn;
  /** The main-process log, for the raw reason behind a failure the tool result words plainly. */
  log?: (line: string) => void;
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
  /**
   * This call's result is text the user wrote or chose to load - a skill from their own folder or
   * from a project they trusted - so reading it does not make the reply untrusted. See
   * ChatToolCall.ownContent.
   */
  ownContent(): void;
}

/** One conversation's agent browser: a hidden window with its own cookie jar. */
export interface BrowserPage {
  /** Where the page is now; empty before the first navigation. */
  currentUrl(): string;
  /** Every frame's committed url, the top one included: a screenshot shows them all. */
  frameUrls(): string[];
  /**
   * Load a URL and wait for it to settle. Resolves with where it ended up; `stillLoading` when it
   * showed a page but was still loading at the deadline, and was stopped there.
   */
  navigate(url: string): Promise<{ url: string; title: string; status?: number; stillLoading?: boolean }>;
  /** Stop whatever the page is loading, as the toolbar's stop button would. */
  stop(): void;
  back(): Promise<void>;
  /** With `inView`, only what intersects the viewport. */
  snapshot(maxChars: number, inView?: boolean): Promise<BrowserSnapshot>;
  click(ref: string): Promise<string>;
  /** Scroll and describe what moved; an element target resolves to its visible name. */
  scroll(target: ScrollTarget): Promise<string>;
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

/** One of a conversation's tabs, as browser_tabs lists it. */
export interface BrowserTabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
}

export interface BrowserContext {
  /** The session's ACTIVE tab, opened on first use. Every page tool acts on this one. */
  page(): Promise<BrowserPage>;
  /** In strip order. */
  tabs(): BrowserTabInfo[];
  /** Open a blank tab and make it the active one. Null when the conversation is at the tab cap. */
  newTab(): Promise<BrowserPage | null>;
  /** Make a tab the active one, which the user's pane follows. Throws for an id that is not open. */
  selectTab(id: number): Promise<BrowserTabInfo>;
  /** Close a tab; the one beside it becomes active if it was. Throws for an id that is not open. */
  closeTab(id: number): Promise<BrowserTabInfo>;
  /** Keep a screenshot for the transcript, so the user sees what the model saw. */
  keepScreenshot(bytes: Buffer, caption: string): Promise<ChatMedia | undefined>;
  /**
   * Whether this url is a site the USER imported their own Chrome cookies for, which makes
   * reaching it a different act from reaching it anonymously - so the browser tools ask about
   * it in every mode. Reading the flag is all a tool may do: nothing here can cause an import.
   */
  usesImportedCookies(url: string): boolean;
}

/** An image fitted to what the model's provider accepts, and the size it was read at. */
export interface PreparedImage {
  bytes: Buffer;
  mediaType: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}

/** How a tool shows the model an image through ToolReporter.image. */
export interface ImageContext {
  /**
   * False when the turn's model is known not to read images. ChatService drops the image then
   * anyway; this is so the tool can say so rather than tell the model to look at nothing.
   */
  vision: boolean;
  /**
   * Downscale to the long-edge limit and fit under `maxBytes`. Null for bytes the decoder cannot
   * read, which nativeImage does not for GIF and WebP. Injected so only main/chat imports Electron.
   */
  prepare(bytes: Buffer, mediaType: string, maxBytes: number): PreparedImage | null;
}

/** A window or display, as screen_capture lists it. */
export interface ScreenSource {
  /** desktopCapturer's id, `window:<n>:<n>` or `screen:<n>:<n>`: stable for the window's lifetime. */
  id: string;
  kind: 'window' | 'screen';
  /** A window's title, or a display's name. */
  name: string;
}

export type ScreenAccess =
  | { state: 'granted' }
  /** macOS has not asked yet; the first capture raises its prompt. */
  | { state: 'not-determined' }
  /** `message` is what the model is told, with where the user can change it. */
  | { state: 'denied' | 'unsupported'; message: string };

/** The desktop's windows and displays: Electron's desktopCapturer in the app, a fake in tests. */
export interface ScreenCapturer {
  /** Read on every call, never cached: the user can grant it in System Settings at any time. */
  access(): ScreenAccess;
  list(): Promise<ScreenSource[]>;
  /** A PNG at most `maxEdge` pixels on its long side; null when the source is gone or came back blank. */
  capture(id: string, maxEdge: number): Promise<Buffer | null>;
}

export interface ScreenContext {
  capturer: ScreenCapturer;
  /** Keep a capture for the transcript, as BrowserContext.keepScreenshot does. */
  keepScreenshot(bytes: Buffer, caption: string): Promise<ChatMedia | undefined>;
}

/**
 * Everything a tool may use. Narrow by default: no api client and no token, except for the
 * server-backed generation tools, which get exactly {@link MediaContext}, and the web tools,
 * which get exactly {@link WebContext}.
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
   * Called by a tool the moment it starts changing something that must not be left half done,
   * after its last abort check. From then on a stop waits for this call instead of abandoning it
   * (see interruptible.ts). Throws if the turn has already been stopped. Absent outside the chat
   * loop, where nothing abandons a call.
   */
  beginWrite?(): void;
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
  /** Absent when signed out; web_search and web_fetch are then not declared, and refuse if called. */
  web?: WebContext;
  /** Absent outside a Code session; the browser tools are then not declared at all. */
  browser?: BrowserContext;
  /** Absent in a build without desktopCapturer; screen_capture is then not declared at all. */
  screen?: ScreenContext;
  /** Absent outside the chat loop, where an image has nowhere to go; file_read then describes it in text. */
  images?: ImageContext;
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
  /** The user's MCP servers. Absent in a build or test without them; the mcp_* tools then refuse. */
  mcp?: McpToolContext;
  /** The calling session's PR binding. Absent in tests; set_session_pull_request then refuses. */
  pullRequests?: PullRequestContext;
  /** Absent outside the chat loop; every tool treats it as optional. */
  report?: ToolReporter;
  /**
   * The approval key this call was let through under, whether the user answered the card, a
   * standing answer covered it, or the mode did. Absent for a call that was never gated. Set by
   * ChatService only, so a tool can tell what the user agreed to from what it merely ended up
   * doing - a browser page that redirected somewhere no approval named.
   */
  approvedKey?: string;
  /** Whether the user said "always" to this key in this conversation. Absent outside the chat loop. */
  isStanding?(key: string): boolean;
}

/**
 * The MCP manager as the mcp_* tools may drive it. No add or update here: those run in
 * ChatService on the card's click, because they need the secret values only the click carries.
 */
export interface McpToolContext {
  state(): Promise<McpServersState>;
  find(idOrName: string): Promise<McpServerState | null>;
  settle(id: string): Promise<McpServerState | null>;
  reconnect(id: string): Promise<McpServerState | null>;
  setEnabled(id: string, enabled: boolean): Promise<McpServersState>;
  removeServer(id: string): Promise<McpServersState>;
}

/** One session's PR binding, as set_session_pull_request may change it. See PrMonitor. */
export interface PullRequestContext {
  bind(target: string): Promise<PrBindOutcome>;
  clear(): Promise<PrActionResult>;
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
 * checkout back and be isolated in name only. `base` is what that branch is cut from - the
 * parent's own branch, never the parent's checkout - see HostContext.spawnBase.
 */
export type SpawnPlacement = { kind: 'local' } | { kind: 'worktree'; branch: string; base: string };

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
  /**
   * What a worktree child's new branch is cut from: the branch this session is on. Resolved once,
   * for the approval card, and carried from there in the placement, so the base the card names
   * is the base the child gets.
   */
  spawnBase(): Promise<string>;
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
  /**
   * Present only when a user is in this conversation to act on a suggestion. session_spawn then
   * proposes rather than starts, and the turn is never held on the answer. Absent in a spawned
   * session, which keeps the approval-gated start.
   */
  suggestions?: SpawnSuggestionHost;
}

export interface SpawnSuggestionTask {
  prompt: string;
  title?: string;
  summary?: string;
}

/** A suggestion the model addressed that cannot take the change, and why. */
export type SuggestionOutcome = { ok: true; suggestion: ChatSpawnSuggestion } | { ok: false; message: string };

/** The spawn suggestions of the calling conversation, and only that conversation. */
export interface SpawnSuggestionHost {
  suggest(task: SpawnSuggestionTask): Promise<ChatSpawnSuggestion>;
  /** Only a pending suggestion can change. */
  update(id: string, changes: Partial<SpawnSuggestionTask>): Promise<SuggestionOutcome>;
  dismiss(id: string): Promise<SuggestionOutcome>;
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
   * project, a read of a `.env` file, or a command that can send data out.
   */
  askInAuto?: true;
  /**
   * Proven by the shell scan to keep to this computer or only read from GitHub (see
   * shellScan's `containedCommand`), so untrusted content read earlier in the reply is no reason
   * to ask: steered or not, the call has nowhere to send what it reads.
   */
  contained?: true;
  /**
   * Asked in every mode, 'full' included, and so stronger than `askInAuto` - a call 'full' must
   * stop for is not one 'auto' may run. For a call whose risk is NOT the filesystem risk that
   * 'full' is a decision about: a script in a page the user has signed in to reads that site's
   * cookies and calls its API as them, and what it returns goes to the model's provider.
   *
   * Unlike `irreversible` this still allows an 'always': the consent is specific and the user
   * gave it, it just cannot be inherited from a mode they set for something else.
   */
  askInFull?: true;
  /**
   * For a shell command: what "always allow" remembers. Each sub-command of the script is
   * covered by a prefix pattern, and each directory outside the project by the directory.
   */
  always?: ApprovalAlways;
  /** For an MCP tool: the server's slug and the tool's own name, which an `mcp__server__tool` rule names. */
  mcp?: { server: string; tool: string };
  /** What "always allow" in this conversation covers, for a `key` broader than this one call. */
  alwaysCovers?: string;
}

export interface ApprovalAlways {
  /** The tool the patterns belong to: allowing `npm run dev *` for one tool is not allowing it for the other. */
  namespace: string;
  /**
   * One per sub-command, as written; matched against remembered `patterns`. Never covered when
   * not `coverable` (see ShellCommand.coverable).
   */
  commands: readonly { text: string; pattern: string; coverable: boolean; words?: string; opaque?: string }[];
  /** Directories outside every granted root that the command reaches. */
  directories: readonly string[];
  /** Physical paths named by a shell command, used to protect permission files even through aliases. */
  paths?: readonly string[];
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
   * Waits on the user for an answer rather than for permission. ChatService validates the call,
   * shows the card, and hands `run` the outcome as `input.outcome`. Never approval-gated and
   * never offered to a conversation with no user in it.
   */
  interactive?: true;
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
