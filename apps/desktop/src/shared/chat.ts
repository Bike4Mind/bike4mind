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

import type { ChatQuestionAnswer } from './questions';
import type { SkillSource } from './skills';

export type ChatRole = 'user' | 'assistant';

/**
 * 'moved' is a settled state that is not an outcome: the command did not finish here, it was
 * handed to the background and is still going. Neither 'done' nor 'error' could say that
 * without claiming something that did not happen.
 */
export type ChatToolStatus = 'awaiting-approval' | 'running' | 'done' | 'error' | 'denied' | 'moved';

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
 * A line-by-line change to one file.
 *
 * It is carried in two places, and which one holds it is the whole contract:
 *  - `ChatToolCall.approvalDiff` is an INTENTION, computed BEFORE the user is asked. That is
 *    the point of the write gate: approving "write file" with no visible change is not
 *    informed consent. Nothing has touched the disk for as long as it is on screen.
 *  - `ChatToolCall.diff` is a RECORD, attached only after the write returned.
 *
 * One shape serves both because the write tools hold a per-file lock across the read and the
 * write and re-check the file against the snapshot they planned against, so the change they
 * planned is the change they applied. Neither field is ever set on the other's behalf.
 */
export interface ChatDiff {
  /** Absolute path the change applies to. */
  path: string;
  operation: 'create' | 'overwrite' | 'edit' | 'delete';
  /** Set when the file was renamed as well as changed: where it was before. */
  movedFrom?: string;
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
   * Set with `approvalId` on a tool whose effect cannot be undone. The card must not offer
   * "always in this chat" for one of these, and main refuses to honour a standing approval
   * against it however the user answered an earlier identical call.
   */
  approvalIrreversible?: boolean;
  /**
   * Set with `approvalId` on a shell call: the SCOPE an "always" would grant, ready to display
   * beside the buttons. Capped and with its paths abbreviated, because it is written from the
   * command and a command can name any number of directories. Never a button label: the card
   * names the action on the button and puts this next to it.
   */
  approvalAlways?: string;
  /**
   * The same scope with nothing capped and no path shortened, for the card's tooltip. Set only
   * when it differs from `approvalAlways` - an abbreviated path must not be the only account of
   * what is being granted.
   */
  approvalAlwaysFull?: string;
  /**
   * Set with `approvalId` when the call can be allowed in more than one way, so the card draws
   * a split button rather than a plain "allow". The chosen option is folded into `input` before
   * the tool runs, which is what makes the settled row report what the user actually picked.
   */
  approvalChoice?: ChatApprovalChoice;
  /**
   * The change a write tool proposes, set with `approvalId` on tools that edit files. The
   * user sees it before answering; nothing has been written while this is on screen.
   */
  approvalDiff?: ChatDiff;
  /** Set instead of `approvalDiff` when one call proposes changes to several files. */
  approvalDiffs?: ChatDiff[];
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
  /**
   * The collapsed row's text, when the tool knows something its arguments do not say. Today
   * only session_send, whose only readable argument is a uuid: the row has to name the
   * conversation, and only the call that resolved the id knows its title.
   */
  label?: string;
  /**
   * What a write tool actually changed, set only once the bytes landed - see ChatDiff for why
   * the diff planned before the write is a truthful record of it.
   *
   * Never present on a call that failed, was declined, or was stopped by the stale-file
   * re-check. The transcript keeps this row for good, and a diff under a row for a write that
   * did not happen is a claim the reader has no way to check.
   *
   * Absent on every message stored before writes recorded one; the row then renders exactly as
   * it did then, with no diff panel.
   */
  diff?: ChatDiff;
  /** Set instead of `diff` when one call changed several files; same contract. */
  diffs?: ChatDiff[];
  /** Epoch ms. Display and diagnosis only; never sent to the model. Absent on older sessions. */
  startedAt?: number;
  endedAt?: number;
  /** What a tool that runs its own model loop spent; today only explore. */
  detail?: ChatToolDetail;
  /**
   * The model is sent a short placeholder instead of `preview`, because a later write or wider
   * read made this result stale. Never unset once set: every later request has to reproduce the
   * same bytes or the prompt cache is lost from this point on. `preview` stays for the thread.
   */
  cleared?: true;
}

/** Sum over a sub-loop's rounds: how many requests it made and where its time went. */
export interface ChatToolDetail {
  rounds: number;
  modelMs: number;
  toolMs: number;
  /** Summed over the sub-loop's requests; absent when the server reported none. */
  usage?: ChatUsage;
}

/**
 * 'always' repeats the approval for identical later calls in the SAME conversation, and is
 * forgotten when the app exits. It is matched on the exact request - an approved `git status`
 * does not carry over to `git status; rm -rf ~`.
 *
 * 'redirect' is NOT a refusal, and the difference is the whole point of it: the user wants the
 * work done, just in the conversation they are already in rather than by the tool. A denial
 * tells the model to stop and ask what to do instead, which is the opposite of what they asked
 * for, so the two settle the call with different text. See ChatApprovalOption.redirect.
 */
export type ChatApprovalDecision = 'once' | 'always' | 'deny' | 'redirect';

/**
 * One alternative on an approval card that offers a choice, as a button the user can click.
 *
 * The options are the same act done differently - not a menu of unrelated things - so the card
 * draws them as a split button: the first is the primary action and the rest sit under its
 * caret.
 */
export interface ChatApprovalOption {
  id: string;
  /** The button face, in the imperative: what clicking it does. */
  label: string;
  /** One line under the label saying what it means, since the labels hide the axis they differ on. */
  description: string;
  /**
   * A value this option needs before the call can run, prefilled with a suggestion and editable
   * on the card. Prefilled rather than derived silently so a bad guess is visible and fixable
   * BEFORE anything is created.
   */
  field?: ChatApprovalField;
  /**
   * Choosing this does NOT run the call: the user wants the work done in this conversation
   * instead. It is a redirect for this one call rather than a policy, so the card offers no
   * standing approval alongside it and none is ever recorded - the rule `irreversible` follows,
   * for a different reason.
   */
  redirect?: true;
}

export interface ChatApprovalField {
  /** Which of the tool's inputs the value lands in; also the field's testid suffix. */
  name: string;
  label: string;
  /** The suggestion, which the user may replace before answering. */
  value: string;
}

/** The alternatives an approval card offers. The first option is its primary action. */
export interface ChatApprovalChoice {
  options: ChatApprovalOption[];
}

/** What the user clicked on an approval card, answered back through `respondToApproval`. */
export interface ChatApprovalAnswer {
  decision: ChatApprovalDecision;
  /** Which of the card's options; absent on a card that offered none. */
  optionId?: string;
  /** What the user left in the chosen option's field, when it had one. */
  value?: string;
  /**
   * An `ask_user` card's replies, one per question, sent with decision 'once'. A 'deny' on that
   * card is Skip. Question cards ride the approval channel because they wait on the user the
   * same way: same id, same gate, same needs-action status.
   */
  answers?: ChatQuestionAnswer[];
}

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

/**
 * Everything the artifact card needs to draw one, whether it came out of a reply or back off
 * the server.
 *
 * Only a subset is RENDERED (see the renderer's ArtifactCard): an artifact body is code the
 * model wrote, and this app has a filesystem and a shell behind its preload bridge, so a type
 * renders only where its content can run with no reach into this process. The rest is shown as
 * source. `type` is the server's ArtifactType vocabulary, held as a plain string so this file
 * stays free of core imports (see the header).
 */
export interface ChatArtifactView {
  id: string;
  /** Server artifact type: 'html', 'react', 'svg', 'mermaid', 'code', 'python', ... */
  type: string;
  title: string;
  /** The body, verbatim. Never rendered as markup except through an isolated frame. */
  content: string;
  /**
   * How the copy on the server went. Only a reply's artifact carries one - a row read back out
   * of the library is on the server by definition, so saying so there would be noise.
   */
  save?: ChatArtifactSave;
}

/** What an <artifact> block in a reply became, with the fields only a reply's artifact has. */
export interface ChatArtifact extends ChatArtifactView {
  /** The model's own `identifier` attribute, when it gave one. Its handle for an update. */
  identifier?: string;
  /** The `type` attribute verbatim, so the markup can be rebuilt for the next turn. */
  mimeType: string;
  language?: string;
}

/**
 * One row of the artifact library, WITHOUT its body.
 *
 * `GET /api/artifacts` returns artifact documents only - the bodies live in their own
 * collection and come back from `GET /api/artifacts/{id}?includeContent=true`. That split is
 * kept rather than papered over: a library of fifty artifacts should not pull fifty HTML files
 * across to draw a list of titles.
 */
export interface ChatArtifactSummary {
  id: string;
  title: string;
  type: string;
  /** ISO timestamp from the server row. */
  createdAt: string;
  description?: string;
}

/**
 * The answer to `listArtifacts`.
 *
 * `error` set means the library could not be READ - offline, signed out, server error - and
 * says nothing about what is stored. An empty list with no error is the other case: the server
 * answered and this account has no desktop artifact yet. The panel distinguishes them, because
 * "try again" is only useful advice for the first.
 */
export interface ChatArtifactLibrary {
  artifacts: ChatArtifactSummary[];
  /** Total matching rows on the server, which may exceed what `artifacts` holds. */
  total: number;
  error?: string;
}

/** The answer to `readArtifact`: the body for one row, or why it could not be fetched. */
export interface ChatArtifactContent {
  artifact?: ChatArtifactView;
  error?: string;
}

/**
 * Whether the server kept a copy, shown on the card.
 *
 * Reported rather than left silent because the outcomes differ for the user: a desktop
 * conversation is otherwise local-only, so saving is the one thing that makes an artifact
 * reachable from the web app, and a failure means it exists here and nowhere else.
 */
export interface ChatArtifactSave {
  status: 'saved' | 'failed' | 'disabled';
  /** Why it did not save. Set on 'failed' and 'disabled'. */
  reason?: string;
}

/**
 * Where a relayed message came from, and how far down an agent-to-agent chain it is.
 *
 * `hops` is the whole cycle bound. Messaging makes the session graph cyclic - A can message B
 * and B can message A - so neither of the spawn caps applies: nothing about that exchange is a
 * tree, and no parent is left to stop it. Each relay starts a turn one hop deeper than the turn
 * that sent it, and a turn at the limit cannot send at all, so any chain of relayed messages is
 * finite by construction. A turn the USER typed is hop 0 again: a person spending their own
 * attention is not a runaway, which is the same line MAX_CONCURRENT_SPAWNED draws.
 */
export interface ChatRelayOrigin {
  fromSessionId: string;
  /** The sending conversation's title as it was at send time, for the row that names it. */
  fromTitle: string;
  hops: number;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  /** Tools this assistant turn ran, in the order the model asked for them. */
  toolCalls?: ChatToolCall[];
  /**
   * The same turn split the way it was PRODUCED: one entry per tool round, each carrying that
   * round's prose and the calls it went on to make.
   *
   * `content` and `toolCalls` stay the flattened view, because that is what the request builder,
   * the plain-text transcript and search all want. This is what the thread reads to draw a reply
   * in the order it happened rather than every tool row piled up after every word.
   *
   * Absent on messages stored before rounds were recorded, and on a message that ran no tools and
   * showed no reasoning. A reader that finds it missing has to fall back to `content` then `toolCalls`: the
   * ordering was never captured for those and cannot be recovered.
   */
  rounds?: ChatReplyRound[];
  /** What the whole reply cost, summed over its requests, on assistant messages. Never sent to the model. */
  usage?: ChatUsage;
  /**
   * Provider-shaped reasoning blocks (Anthropic extended thinking). Opaque: they are replayed
   * verbatim into the next request, because dropping them breaks thinking-plus-tools turns.
   */
  thinking?: unknown[];
  /**
   * Normalized reason generation ended, on assistant messages. 'max_tokens' means the reply
   * was CUT OFF rather than finished; 'aborted' is this client stopping it. The three values
   * `isTurnBudgetStop` covers mean the agent loop's own budget ran out mid-task.
   */
  stopReason?: string;
  /** Set instead of a reply when the turn failed; the message is kept so the thread shows why. */
  error?: string;
  /** Files the user attached to this turn. Only ever on a user message. */
  attachments?: ChatAttachment[];
  /**
   * Written by the app rather than typed by anyone: today only a spawned session reporting back
   * to the conversation that started it.
   *
   * It carries `role: 'user'` because that is the only way out-of-band information reaches a
   * stateless completions endpoint, but it is not the user talking, and the thread draws it as a
   * notice rather than as their words.
   */
  system?: boolean;
  /**
   * Set with `system` when the text came from another conversation via session_send, naming
   * which one. It is what stops a relayed message reading as the user's own words, in the
   * thread and on the wire alike.
   */
  relay?: ChatRelayOrigin;
  /**
   * What the THREAD shows in place of `content`, on messages the app wrote rather than either
   * speaker.
   *
   * `content` stays the model's copy, for the same reason `skill` leaves it alone: the transcript
   * is what the next request replays, and a spawned session's report is only useful to the model
   * if it still carries the id that session_read needs. That id and that tool name are exactly
   * what the user does not want to read, so the two audiences get two strings.
   *
   * Absent on messages stored before this field existed, and on every message nobody writes a
   * user-facing wording for. A reader that finds it missing falls back to `content`.
   */
  display?: string;
  /**
   * Artifacts parsed out of this reply. Their markup is NOT in `content`, which holds the prose
   * around them; the wire rebuilds it from here (restoreArtifactMarkup) so the model still sees
   * its own artifact on a follow-up while the body is stored exactly once.
   */
  artifacts?: ChatArtifact[];
  /**
   * Set on the one message that marks a context boundary. See ChatContextBoundary.
   *
   * It is a marker rather than a property of the message after it, so `/clear` and `/compact`
   * produce the same shape: one message, differing only in whether it carries a summary.
   */
  boundary?: ChatContextBoundary;
  /**
   * Set when this user turn was a `/skill` invocation rather than typed prose.
   *
   * `content` still holds the EXPANDED body, because that is what the model was asked and the
   * transcript is what the next request replays - storing the short form would mean the model
   * loses the instructions it was following on the very next turn. This field is what lets the
   * thread draw the turn as "/review src/foo.ts" with the expansion folded away, so the user can
   * see which skill ran instead of a screen of prose they never wrote.
   */
  skill?: ChatMessageSkill;
}

/**
 * A point in the transcript the model is shown nothing before.
 *
 * `/clear` and `/compact` are the same mechanism with one difference: whether a summary rides
 * across. So the boundary is ONE message - `kind` says which command wrote it, and `content`
 * holds the summary on a compaction and is empty on a clear. Adding a third command that keeps
 * some other form of carry-over is then a new `kind`, not a second mechanism.
 *
 * Nothing is deleted. The messages before a boundary stay in the session file and in the
 * transcript, folded away: a session is the user's record of their own work, and neither
 * command is a delete. What changes is only what goes on the wire - see messagesSinceBoundary.
 */
export interface ChatContextBoundary {
  kind: 'clear' | 'compact';
}

/** Index of the most recent boundary marker, or -1 when the conversation has none. */
export function lastBoundaryIndex(messages: readonly ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].boundary) return index;
  }
  return -1;
}

/**
 * The history a request may carry: everything from the most recent boundary on, the marker
 * included so a compaction's summary is the first thing the model reads.
 *
 * The marker is INCLUSIVE and a later boundary supersedes an earlier one, which is what makes
 * compacting a compacted conversation work without any bookkeeping: the scan only ever finds
 * the last marker, and everything the previous summary stood for is already behind it.
 */
export function messagesSinceBoundary(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  const index = lastBoundaryIndex(messages);
  return index < 0 ? messages : messages.slice(index);
}

/** Which skill a user turn ran. See ChatMessage.skill. */
export interface ChatMessageSkill {
  name: string;
  /** Whatever followed the name, verbatim. Absent when the skill was run bare. */
  args?: string;
  /** 'project' means these instructions came out of the repository, not the user's own folder. */
  source: SkillSource;
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
 * The answer to moving a running foreground command to the background.
 *
 * A refusal is a result rather than a thrown error: a command that finished a moment before the
 * click, and one turned away by the background process cap, are both things the user asked for
 * and is entitled to read back.
 */
export type ChatMoveToBackgroundResult = { ok: true; process: BackgroundProcessInfo } | { ok: false; message: string };

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
   * The most output tokens this model can produce in one reply, sent as `max_tokens` on every
   * turn. Without it the server falls back to 4096 for a model that does not reason, which a
   * single file write outgrows.
   */
  maxOutputTokens?: number;
  /**
   * Whether this model accepts images. Absent means the server said nothing, which is NOT the
   * same as "no": the catalog only carries the flag for backends that report it, so an attached
   * image is refused on an explicit `false` and allowed through on silence.
   */
  supportsVision?: boolean;
  /**
   * Whether a reasoning effort may be sent with this model. Decided by the adapter's own list
   * rather than by the server's catalog, so it is always stated - unlike `supportsVision`, an
   * absent flag here only means the model was not in a list that had loaded.
   */
  supportsReasoningEffort?: boolean;
}

/**
 * How hard a model that reasons thinks before answering.
 *
 * `default` sends nothing and leaves the provider at its own effort, which is what every
 * conversation did before the setting existed. It is a real choice in the picker rather than
 * an empty state, because "let the provider decide" is a different instruction from "low".
 */
export type ReasoningEffortSetting = 'default' | 'minimal' | 'low' | 'medium' | 'high';

/** Ascending, which is the order the picker lists them in. */
export const REASONING_EFFORT_SETTINGS: readonly ReasoningEffortSetting[] = [
  'default',
  'minimal',
  'low',
  'medium',
  'high',
];

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

/**
 * Token counts the SERVER reported, never a client-side estimate.
 *
 * The completions endpoint reports usage per request, so an agent turn - which makes one
 * request per tool round trip - produces several of these, and the turn's cost is their sum.
 * Absent means the server sent none, which is not the same as zero.
 */
export interface ChatUsage {
  /** Input the provider billed at the full rate; excludes the two cache counts below. */
  inputTokens?: number;
  outputTokens?: number;
  /** Input served from the prompt cache, billed at a fraction of the input rate. */
  cacheReadInputTokens?: number;
  /** Input written to the prompt cache this request, billed above the input rate. */
  cacheCreationInputTokens?: number;
  /** Credits the server charged for these requests. */
  creditsUsed?: number;
  usdCost?: number;
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
 * How much the user has agreed to be asked before a tool that runs code or changes a file
 * goes ahead.
 *
 * Deliberately NOT ChatSessionMode, which says what a conversation is FOR. This says what it
 * may do without stopping, and it governs one axis only: filesystem and execution. The
 * generation tools are gated on COST, not safety, and ask in every mode - approving
 * `bash_execute` says nothing about whether the user wants to spend credits on an image.
 *
 *  - 'ask'  every gated tool asks. The behaviour this client had before modes existed.
 *  - 'auto' everything runs unasked except a call with a named reason to stop: a shell
 *           command naming a path outside the granted folders (or one that does not parse), a
 *           read of a `.env` file, or the same call a third time in a row. Modelled on
 *           opencode's permission defaults; see ChatService.autoApproves.
 *  - 'full' no gate at all for the filesystem and the shell. A command can then read any file
 *           this user can read and reach the internet with nobody looking. Chosen per
 *           conversation, never inherited by a spawned one, and reset to 'ask' on relaunch.
 *
 * Changed by the user in the renderer and nowhere else. No tool, no MCP server and no model
 * output can raise it; see ChatService.setApprovalMode and HostContext.
 */
export type ChatApprovalMode = 'ask' | 'auto' | 'full';

/**
 * What a Code session is grounded in, once the user has chosen it.
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

/**
 * Where a session came from, when it was not the user who started it.
 *
 * Absent means a person created it, which is also what `depth: 0` would mean - the distinction
 * matters because the spawn caps count agent-created sessions only, and a user is not rationed.
 *
 * `depth` is stored rather than walked back up the chain at spawn time: a parent can be deleted
 * while its child is still running, and a cap that stops being enforceable because a row was
 * removed from the sidebar is not a cap.
 */
export interface ChatSessionOrigin {
  parentSessionId: string;
  /** 1 for a session spawned by one the user made. Capped - see MAX_SPAWN_DEPTH in main. */
  depth: number;
  /** The prompt it was started with, so the row can say what it was sent off to do. */
  seedPrompt: string;
}

interface ChatSessionMeta {
  id: string;
  /**
   * What the sidebar row says. Provisionally a truncation of the first prompt, replaced moments
   * later by a generated name unless `titleLocked` says otherwise.
   */
  title: string;
  /**
   * Set once somebody named this conversation on purpose - the user renaming it, or the agent
   * naming a session it spawned. It exists to be read by the title generator, which never
   * overwrites a title it did not put there; nothing in the renderer draws it.
   */
  titleLocked?: boolean;
  model: string;
  createdAt: string;
  updatedAt: string;
  mode: ChatSessionMode;
  /**
   * Per conversation, not app-wide: the risk of running unattended is a property of what this
   * thread is pointed at, and one runaway conversation must not loosen the next. Always on
   * screen in the composer pill, so it is never a setting the user has forgotten they set.
   */
  approvalMode: ChatApprovalMode;
  /**
   * Per conversation for the same reason `model` is: comparing a cheap fast answer against a
   * careful one is a thing to do WITHIN one app, and reopening a thread should resume the
   * effort it was held at rather than whatever the last conversation was set to.
   *
   * Only a model in the catalog's reasoning set is actually sent one - see
   * `ChatModelOption.supportsReasoningEffort`. On any other model this is stored and inert.
   */
  reasoningEffort: ReasoningEffortSetting;
  /**
   * Set on Code sessions that have been pointed at a directory. Absent on a Chat session, and
   * on a Code session nobody has chosen a folder for yet - which is a usable state, not a
   * broken one, and the only thing it cannot do is run a turn.
   */
  project?: ChatProject;
  /** Pinned to the top of the sidebar, above both the groups and the loose conversations. */
  pinned?: boolean;
  /** Set when the agent spawned this session rather than the user starting it. */
  origin?: ChatSessionOrigin;
  /**
   * Out of the way but not gone: archived sessions drop into their own collapsed section at the
   * bottom of the sidebar instead of sitting among the live ones. Reversible from the same menu,
   * which is what separates it from delete.
   */
  archived?: boolean;
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
  /**
   * The reply streaming into this conversation right now, and when its turn started. Never
   * stored: ChatService.getSession adds it, so a window joining mid-turn can show the turn's
   * status line with a true elapsed time rather than none at all.
   */
  replyInFlight?: { messageId: string; startedAt: number };
}

/**
 * Reply progress, pushed main -> renderer. Every event carries both ids so a renderer showing
 * one session can drop events belonging to another that is still streaming in the background.
 *
 * Exactly one terminal event ('done' | 'error') follows a 'start'. A stopped reply is a 'done'
 * with `stopReason: 'aborted'` and whatever text had arrived, not an error - the partial reply
 * is kept, matching what the user saw on screen when they pressed stop.
 *
 * The two 'background-*' events and 'message' are the exception to all of that: a background
 * process outlives the turn that started it and a spawned session reports back long after, so
 * they keep arriving with no reply in flight and carry no `messageId`. A consumer that only cares about replies must ignore them explicitly rather
 * than treating an unrecognised event as terminal.
 *
 * 'usage' is non-terminal too: several arrive during one reply, each carrying the running total.
 */
export type ChatStreamEvent =
  | { type: 'start'; sessionId: string; messageId: string }
  | { type: 'delta'; sessionId: string; messageId: string; text: string }
  | { type: 'tool-start'; sessionId: string; messageId: string; call: ChatToolCall }
  | { type: 'tool-end'; sessionId: string; messageId: string; call: ChatToolCall }
  | { type: 'tool-progress'; sessionId: string; messageId: string; callId: string; text: string }
  /** Readable reasoning, streamed ahead of the round's prose; see ChatReplyRound.reasoning. */
  | { type: 'reasoning'; sessionId: string; messageId: string; text: string }
  /**
   * The turn's cost so far, emitted after each tool round trip completes and once more with
   * the reply. `usage` is the running total of what the server reported, so a consumer shows a
   * real number from the first round trip on rather than waiting for 'done' - or estimating.
   */
  | { type: 'usage'; sessionId: string; messageId: string; usage: ChatUsage }
  | {
      type: 'done';
      sessionId: string;
      messageId: string;
      content: string;
      stopReason?: string;
      usage?: ChatUsage;
      toolCalls?: ChatToolCall[];
      /** The reply's round structure; see ChatMessage.rounds. Absent when no tool ever ran. */
      rounds?: ChatReplyRound[];
      /** `content` has had their markup removed, so these ride with it rather than following it. */
      artifacts?: ChatArtifact[];
    }
  | { type: 'error'; sessionId: string; messageId: string; message: string }
  | {
      type: 'background-output';
      sessionId: string;
      processId: string;
      stream: 'stdout' | 'stderr';
      text: string;
    }
  | { type: 'background-status'; sessionId: string; process: BackgroundProcessInfo }
  /**
   * A whole message appeared in a conversation without anyone typing it: today only a spawned
   * session reporting back to the one that started it.
   *
   * Non-terminal, and it carries no `messageId` of a reply in flight - it is not part of one.
   * It exists because the thread is otherwise built entirely from a reply being streamed, so a
   * parent sitting open would not show the report until it was reloaded.
   */
  | { type: 'message'; sessionId: string; message: ChatMessage };

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
 * What the user typed while a reply was still running, waiting to become the next turn.
 *
 * There is at most one per session: sending again while something is already pending appends
 * to it, so the whole wait produces a single next turn rather than a line of them.
 *
 * Queued messages live in the MAIN process, keyed by session, and are never persisted. That
 * lifetime is chosen rather than defaulted: one is only ever meaningful for as long as the
 * turn it was queued behind is still open, and a reply is anchored to an in-memory
 * AbortController - so after a restart there is no turn left for a queued message to follow,
 * and anything that survived would fire against a conversation the user last saw hours ago.
 * Main is still the owner rather than the renderer, because main streams replies for sessions
 * no window has open (see useConversation) and a queue in renderer state would die on a
 * session switch while the turn it belongs to carried on.
 */
export interface ChatQueuedMessage {
  id: string;
  sessionId: string;
  text: string;
  /** Descriptors whose bytes are already on disk; they are held back from pruning while queued. */
  attachments?: ChatAttachment[];
  queuedAt: string;
  /**
   * Set when another conversation sent this rather than the user typing it. A relay never
   * merges with what the user is typing and never goes back to their composer; see
   * ChatQueueEvent.returned.
   */
  relay?: ChatRelayOrigin;
}

/**
 * Why a queued message left the queue WITHOUT being sent.
 *
 * Every one of these hands the text back to the composer rather than dropping it - see
 * ChatQueueEvent.returned. 'stopped' is the case the whole design turns on: pressing stop is
 * the user changing their mind about the answer they were queueing against, so firing the
 * queued message into that is the opposite of what they meant.
 */
export type ChatQueueReturnReason =
  /** The user cancelled it from the pending row. */
  | 'cancelled'
  /** The user stopped the reply it was waiting behind. */
  | 'stopped'
  /** That reply ended in an error. */
  | 'failed'
  /** Its turn came and main refused it - signed out, or a model that cannot read its image. */
  | 'refused';

/**
 * One session's queue changing, pushed main -> renderer.
 *
 * Deliberately NOT a member of ChatStreamEvent, for the same reason ChatSessionStatusEvent is
 * not: that union is progress within one reply, and this is per-session state that outlives
 * any single reply and matters for conversations no window is showing.
 *
 * `queued` is always the AUTHORITATIVE list for the session, so a renderer replaces rather
 * than reconciles. `returned` is the separate half: messages that are no longer queued and
 * whose text the composer must take back.
 */
export interface ChatQueueEvent {
  sessionId: string;
  queued: ChatQueuedMessage[];
  /**
   * A queued message that just became a real turn, and the thread message it became.
   *
   * The renderer cannot draw this one itself. A turn it sends by hand is drawn optimistically
   * from the text in its own composer, but a flushed message is appended to the thread by main
   * with no window involved - so without this, the reply would stream in under no visible
   * prompt at all. Emitted BEFORE the reply's 'start', so the prompt lands above it.
   */
  sent?: { queuedId: string; message: ChatMessage };
  /**
   * Messages the user must take back. RELAYS ARE NEVER HERE: another conversation's words
   * belong in this one's transcript, not in the user's composer waiting to be re-sent as
   * though they had written them. Main strands those into the thread instead.
   */
  returned?: {
    messages: ChatQueuedMessage[];
    reason: ChatQueueReturnReason;
    /** The refusal, on 'refused'. Absent on the others, which the reason alone explains. */
    detail?: string;
  };
}

/**
 * `sendMessage` resolves as soon as the turn is accepted, not when the reply finishes - the
 * reply arrives as stream events. A rejection here means the turn never started.
 *
 * `queued: true` is the third outcome: the conversation was already replying, so nothing was
 * sent and the message is waiting. Main decides this, not the renderer - a reply finishing
 * between a renderer-side "is it streaming?" check and the IPC call would otherwise queue a
 * message behind a turn that had already ended, and nothing would ever release it.
 */
export type SendMessageResult =
  | {
      ok: true;
      queued?: false;
      messageId: string;
      /**
       * Set when accepting the turn changed something the user did not ask for - today only
       * a model substitution, when the conversation's saved model is no longer offered by
       * this deployment. Shown once, beside the composer; not an error.
       */
      notice?: string;
    }
  | { ok: true; queued: true; message: ChatQueuedMessage }
  | { ok: false; error: string };

/**
 * The answer to `/clear` and `/compact`.
 *
 * A refusal is a result rather than a thrown error, for the reason ChatMoveToBackgroundResult
 * is: "this conversation is still replying" is a thing the user asked for and is entitled to
 * read back, not a fault.
 *
 * `ok: true` carries the session as it now stands, so the window that asked draws the boundary
 * without a second read.
 */
export type ContextBoundaryResult = { ok: true; session: ChatSession } | { ok: false; error: string };

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
 * What the app learned about a directory the user picked for a project.
 *
 * `isRepository: false` is not an error: the directory is still usable as a project, it just
 * has no branches and no worktree to offer, so the branch chip says so rather than the folder
 * being refused.
 */
export interface ProjectInspection {
  directory: string;
  name: string;
  isRepository: boolean;
  branches: string[];
  currentBranch: string | null;
  /** Set when git could be asked but answered with a failure; the dialog shows it verbatim. */
  error?: string;
  /**
   * Set when the folder cannot ground a session at all, with the reason and what to pick
   * instead. Binding is refused in main as well; this is so the picker can say why without
   * first attempting a move it knows will fail. See git.unusableProjectReason.
   */
  refusal?: string;
}

/**
 * Start a Code session. Every field is optional, because a Code session is allowed to exist
 * with nothing chosen yet - that unbound state is what the chip row above the composer fills
 * in, and it is the reason creating one does not depend on completing a native dialog.
 *
 * An unbound session has NO working directory, so it can run nothing: `send` refuses it and
 * its tools are granted no roots at all. See ChatService.resolveToolScope.
 */
export interface CreateCodeSessionRequest {
  /** Absent leaves the session unbound; the folder chip is then the picker. */
  directory?: string;
  branch?: string;
  workspace?: boolean;
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

/**
 * Why a spawn was refused, for the message handed back to the MODEL.
 *
 * Distinguished rather than collapsed into one string because the model can act on two of them
 * differently: 'depth' is permanent for this session and it should stop asking, while
 * 'concurrency' clears on its own and waiting is a real option.
 *
 * 'branch' is the user's choice failing rather than the model's: the branch they named for the
 * child's worktree is unusable or already taken. Told apart so the model reports it back rather
 * than retrying, since nothing it can do changes the answer.
 */
export type SpawnRefusal = 'depth' | 'concurrency' | 'no-project' | 'empty-prompt' | 'branch';

/**
 * A session_send that did not happen, and which bound or precondition stopped it.
 *
 * 'hops' and 'fan-out' are the two halves of the cycle bound - chain length and branching -
 * and are told apart because only one of them is worth waiting out: a turn that has run out of
 * hops will never get more, and saying so stops the model retrying.
 */
export type RelayRefusal = 'hops' | 'fan-out' | 'no-target' | 'archived' | 'self' | 'empty-message' | 'unavailable';

/**
 * One tool round of a reply: what the model said, and then what it went on to run.
 *
 * Holds call IDS rather than the calls, so a call has exactly one home - the message's
 * `toolCalls` - and a round naming one that is no longer there draws prose with no row instead
 * of the same row twice.
 */
export interface ChatRoundTiming {
  startedAt: number;
  /** The first streamed delta of any kind; absent when the stream produced nothing. */
  firstTokenAt?: number;
  endedAt: number;
}

export interface ChatReplyRound {
  text: string;
  toolCallIds: string[];
  /** Epoch ms, display and diagnosis only; absent on rounds stored before timing was kept. */
  timing?: ChatRoundTiming;
  /** What this round's request cost, as the server reported it. Never sent to the model. */
  usage?: ChatUsage;
  /**
   * The model's readable reasoning before this round's prose, drawn in the transcript as a row
   * that is closed by default (ReasoningRow) and never drawn for the round still streaming -
   * the status line speaks for that one, and the same thought in both places is it twice.
   *
   * Never the replay channel: what goes back to the provider is the message's opaque
   * `thinking`, never this.
   */
  reasoning?: string;
}

/**
 * The stop reasons that mean the agent loop ran out of ITS budget rather than the model
 * finishing, the server truncating, or the user pressing Stop.
 *
 * Every one of them describes a turn that was still working when it was cut, so all three are
 * resumable: the transcript already ends on a complete round of tool results, which is exactly
 * the state a fresh request needs to carry on from. Callers that care about "stopped short vs
 * answered" - the Continue affordance, and a parent reading a spawned session's outcome - go
 * through here so a fourth budget added later reaches both without being wired twice.
 */
export function isTurnBudgetStop(reason?: string): boolean {
  return reason === 'tool_turn_limit' || reason === 'turn_time_limit' || reason === 'tool_stall_limit';
}
