import type { ChatMessage, ChatToolCall, ChatUsage } from '@shared/chat';
import { pendingCodePhrase, type PendingCode } from './codeStream';
import { activePhrase, namedAction } from './toolRows';

/**
 * What the status line under the transcript knows about the turn in flight.
 *
 * `tokens` is deliberately nullable and deliberately server-sourced. The completions endpoint
 * reports usage per request, so the count only becomes real when a round trip finishes; until
 * then the field is ABSENT rather than estimated. A client-side guess that reads as an
 * authoritative number is worse than a number that shows up a second late.
 */
export interface TurnProgress {
  /** Epoch ms the turn started, for the elapsed clock. Local, because only this client knows it. */
  startedAt: number;
  /** Sum of the server's counts for the round trips that have COMPLETED. Null until the first. */
  tokens: number | null;
  /** The same report the count came from, for the split and the cost. */
  usage?: ChatUsage | null;
  /**
   * The live tail of what the model is REASONING, when that is the last thing that arrived.
   *
   * Main emits a 'reasoning' event per chunk and the thread deliberately draws none of it, so a
   * model that thinks for five minutes before writing a word arrives as five minutes of nothing
   * - which is how a turn mid-thought and a turn whose stream died came to render identically,
   * both as "Responding...". Held here rather than on the message because it is not part of the
   * reply: it is evidence that the turn is alive, and the one thing in flight that the
   * transcript has no copy of.
   *
   * Bounded to REASONING_TAIL_CHARS and republished no more than once a second - see
   * EVENT_STAMP_RESOLUTION_MS. Cleared the moment text or a tool arrives.
   */
  reasoning?: string;
  /**
   * Epoch ms the last stream event arrived, which is the only thing separating a working turn
   * from a dead one. Elapsed-since-start cannot: a turn that stopped receiving anything twenty
   * minutes ago renders exactly like one streaming tokens right now.
   *
   * Stamped once per batched flush of live events and no finer - see EVENT_STAMP_RESOLUTION_MS.
   * Absent until the first event, which is what `startedAt` stands in for.
   */
  lastEventAt?: number;
}

/**
 * How long a turn may go quiet before the line stops claiming it is working.
 *
 * Measured against this server rather than guessed: a thinking model sends NOTHING while it
 * thinks - the completions stream carries no frame for it - so the quiet before a Claude turn's
 * first token is normal and long. Two turns timed through the hosted backend went 12.5s and 42s
 * from the request to their first event, and a resumed turn on a large conversation was reported
 * at over a minute. A threshold under that would call every thinking turn stalled, which is how
 * a warning stops being read. The case this exists for sat at "Responding..." for 27 minutes.
 *
 * The waiting line says only that it is waiting, and how long: see activityDetail.
 */
export const STALL_AFTER_MS = 45_000;

/**
 * The finest `lastEventAt` is recorded to.
 *
 * A stamp per delta would hand back exactly what the renderer's frame batching buys - see the
 * live-event path in useChat. Nothing reads this at a finer grain than whole seconds against a
 * ten-second threshold, so a coarse stamp costs the display nothing and saves a state update on
 * every frame of a fast stream.
 */
export const EVENT_STAMP_RESOLUTION_MS = 1000;

/**
 * How much of the model's reasoning is kept for the disclosure.
 *
 * A tail, and bounded where it is accumulated rather than where it is shown: a long think runs
 * to tens of thousands of tokens and none of it is worth holding in state to print twelve lines.
 */
export const REASONING_TAIL_CHARS = 2000;

/**
 * New input, cache writes and output. Cache reads are left out: a long tool loop re-reads the
 * same context every round, which inflates the figure into the millions while costing a tenth
 * of fresh input. They stay in the tooltip split, and the cost figure already prices them.
 *
 * NOT the number to measure the context window with - see `inputSide`, which is the other half
 * of this distinction and includes exactly what this drops.
 */
export function totalTokens(usage: ChatUsage | undefined): number | null {
  if (!usage) return null;
  const total = (usage.inputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0) + (usage.outputTokens ?? 0);
  return total > 0 ? total : null;
}

/** "$3.20" from the server's own figure, or "12 credits" when only credits came; null when neither. */
export function formatCost(usage: ChatUsage | null | undefined): string | null {
  if (!usage) return null;
  if (usage.usdCost !== undefined) return `$${usage.usdCost.toFixed(usage.usdCost < 0.01 ? 4 : 2)}`;
  if (usage.creditsUsed !== undefined) return `${Math.round(usage.creditsUsed).toLocaleString('en-US')} credits`;
  return null;
}

/** The four-way split, for a tooltip: "12k new input, 1.1M cached, 40k cache write, 3.2k output". */
export function describeSplit(usage: ChatUsage | null | undefined): string | null {
  if (!usage) return null;
  const parts: [number | undefined, string][] = [
    [usage.inputTokens, 'new input'],
    [usage.cacheReadInputTokens, 'cached'],
    [usage.cacheCreationInputTokens, 'cache write'],
    [usage.outputTokens, 'output'],
  ];
  const shown = parts.filter((part): part is [number, string] => part[0] !== undefined);
  return shown.length === 0 ? null : shown.map(([count, label]) => `${formatTokens(count)} ${label}`).join(', ');
}

/** "12s", "3m 7s", "1h 4m" - the same shape at every scale, so the line never changes width much. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Compact counts: "820", "1.1k", "12k", "1.2M". One decimal only where it still carries meaning. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * The third field: WHAT the turn is doing, and - where the transcript cannot show it - a way in.
 *
 * Read off the state the turn already publishes - tool statuses, the progress lines the slow
 * tools report - rather than asked for. Approval outranks everything, because a turn parked at
 * the gate is not working on anything at all.
 *
 * The line DISCLOSES ONLY WHAT THE TRANSCRIPT IS NOT ALREADY SHOWING, which is nearly nothing:
 * prose streams into the thread as it arrives, tool rows are drawn there with their own
 * disclosures, and an approval is a card the user is already looking at. Naming any of those a
 * second time under the line is the same words twice on one screen. The exceptions are the two
 * things the thread genuinely does not have: code being written, which presentReply HIDES, and
 * a stream that has gone quiet, which is an absence and so cannot be drawn anywhere.
 *
 * So most kinds carry a label and nothing else. `pending` is a handle on the live body rather
 * than a rendered string, because this is recomputed on every frame of a stream and the detail
 * is built only once somebody opens it. See activityDetail.
 */
export type TurnActivity =
  | { kind: 'approval'; label: string }
  | { kind: 'tool'; label: string }
  | { kind: 'tools'; label: string }
  | { kind: 'code'; label: string; pending: PendingCode }
  | { kind: 'text'; label: string }
  | { kind: 'thinking'; label: string; reasoning?: string }
  | { kind: 'stalled'; label: string; silentMs: number };

/** As much of a label as fits a line that must not wrap at any window width. */
const MAX_LABEL_CHARS = 90;

/** Whitespace flattened and the whole thing capped: a label is one line or it is not a label. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_LABEL_CHARS ? flat : `${flat.slice(0, MAX_LABEL_CHARS - 3)}...`;
}

/** A named action as a clause rather than a sentence, so a count can follow it. */
function withoutTrail(label: string): string {
  return label.endsWith('...') ? label.slice(0, -3) : label;
}

/**
 * What a running call is doing, in the order the line can say it: the tool and what it was
 * called on, else whatever the tool reports about its own progress, else its bare phrase.
 */
function runningLabel(call: ChatToolCall): string {
  return namedAction(call) || oneLine(call.progress ?? '') || activePhrase(call.name);
}

/**
 * Whether prose for the ROUND IN FLIGHT is arriving.
 *
 * Not "has this reply said anything". A turn that spoke, ran tools and is now composing its
 * next step has said plenty and is saying nothing, and "Responding..." sitting over a finished
 * tool row is exactly the stale label this line exists to stop - it is also why "Thinking..."
 * was almost never seen, since the first sentence of a turn made the whole rest of it read as
 * responding.
 *
 * Text that arrives after a round's tool calls opens a NEW round (see appendText in
 * shared/liveReply), so a last round carrying calls is a round that has no prose yet. A message
 * stored before rounds were recorded has none to read, and falls back to its flattened content.
 */
export function writingProse(message: ChatMessage | undefined | null): boolean {
  if (!message) return false;
  const open = message.rounds?.[message.rounds.length - 1];
  if (!open) return message.content.length > 0;
  return open.toolCallIds.length === 0 && open.text.length > 0;
}

export function describeActivity(
  calls: readonly ChatToolCall[],
  hasText: boolean,
  pending: PendingCode | null = null,
  reasoning?: string
): TurnActivity {
  if (calls.some(call => call.status === 'awaiting-approval'))
    return { kind: 'approval', label: 'Waiting for your answer...' };

  // What the model is doing, named: the tool's own word for itself and the thing it was called
  // on, which is the only part of a turn the user cannot work out from the thread while it is
  // still in flight. "Running a command" for seven minutes names nothing - it is true of every
  // command this app has ever run.
  const running = calls.filter(call => call.status === 'running');
  if (running.length === 1) return { kind: 'tool', label: runningLabel(running[0]) };
  if (running.length > 1) {
    // The newest, because it is the one that just started and the one the rows have not settled
    // yet; the others are named in full by their own rows a few lines above.
    const newest = running[running.length - 1];
    return { kind: 'tools', label: `${withoutTrail(runningLabel(newest))} and ${running.length - 1} more...` };
  }
  if (pending) return { kind: 'code', label: pendingCodePhrase(pending), pending };

  // Reasoning outranks both words below it, and only those two. A model that wrote a sentence
  // and then thought for four minutes is NOT still responding - nothing has been added to the
  // reply in all that time - and reporting it as such is the five-to-ten-minute "Responding..."
  // that this line was built to end.
  if (reasoning) return { kind: 'thinking', label: 'Thinking...', reasoning };

  // "Responding..." says little, and that is correct here: the words it would otherwise repeat
  // are being drawn in the thread a few lines above as they arrive.
  return hasText ? { kind: 'text', label: 'Responding...' } : { kind: 'thinking', label: 'Thinking...' };
}

/**
 * The same activity, or a stalled one wrapping it when nothing has arrived for a while.
 *
 * Applied where `now` already ticks rather than inside describeActivity, which is computed from
 * the thread and knows nothing about the clock. See TurnStatus.
 *
 * A running tool and a waiting approval are never called stalled: the silence is theirs - a
 * command can take minutes without printing a line, and an approval is waiting on the user by
 * definition - and "Waiting for the model" would name the wrong thing entirely.
 */
export function withStall(activity: TurnActivity, turn: TurnProgress, now: number): TurnActivity {
  if (activity.kind === 'approval' || activity.kind === 'tool' || activity.kind === 'tools') return activity;

  const silentMs = now - (turn.lastEventAt ?? turn.startedAt);
  if (silentMs < STALL_AFTER_MS) return activity;
  return { kind: 'stalled', label: `Waiting for the model... ${formatElapsed(silentMs)}`, silentMs };
}

/** What the line discloses, built only for an OPEN disclosure. */
export interface ActivityDetail {
  /** A block of text, already bounded to a tail this view can hold. */
  body?: string;
}

/**
 * Whether the label has anything behind it, cheaply enough to ask on every frame.
 *
 * False for everything the thread already draws, which is what keeps the line from being a
 * second copy of the reply. Deliberately not "is the detail non-empty", which would mean
 * building the detail to find out - the one thing a collapsed line must never do.
 */
export function hasActivityDetail(activity: TurnActivity): boolean {
  if (activity.kind === 'code') return activity.pending.body.trim().length > 0;
  if (activity.kind === 'thinking') return (activity.reasoning ?? '').trim().length > 0;
  return false;
}

const DETAIL_CHARS = 1200;
const DETAIL_LINES = 12;

/** The end of a stream, which is where the news is. Bounded twice: characters, then lines. */
function tailBlock(text: string): string {
  const tail = text.length > DETAIL_CHARS ? text.slice(text.length - DETAIL_CHARS) : text;
  const lines = tail.split('\n');
  return (lines.length > DETAIL_LINES ? lines.slice(lines.length - DETAIL_LINES) : lines).join('\n').trim();
}

/**
 * The live detail behind the label - the only expensive thing in this file.
 *
 * Called ONLY from an expanded disclosure, once per render of it, and bounded to a capped tail of
 * the hidden stream. Nothing here grows with the length of a turn, and nothing here repeats
 * something the thread is already drawing.
 *
 * A waiting turn has nothing behind it and opens nothing. There is a live stream to show or
 * there is not; an explanation of why a stream is empty is a thing the user should not have to
 * read, let alone click for.
 */
export function activityDetail(activity: TurnActivity): ActivityDetail | null {
  if (activity.kind === 'code') return { body: tailBlock(activity.pending.body) };
  if (activity.kind === 'thinking') return activity.reasoning ? { body: tailBlock(activity.reasoning) } : null;
  return null;
}

/** The whole line, dot-separated, as one string - which is also how a test can read it. */
export function statusFields(turn: TurnProgress, now: number, activity: string): string[] {
  return [
    formatElapsed(now - turn.startedAt),
    ...(turn.tokens === null ? [] : [`${formatTokens(turn.tokens)} tokens`]),
    ...(formatCost(turn.usage) ? [formatCost(turn.usage) as string] : []),
    activity,
  ];
}

/**
 * How full the model's context window is, and what the account has left to spend.
 *
 * Every field is nullable and every null means NOT KNOWN rather than zero: a fresh conversation
 * has measured no request, a backend may state no window, and `/api/v1/me` can be unreachable.
 * A stand-in zero in any of the three reads as a fact the server never stated.
 */
export interface ComposerUsage {
  /**
   * The whole input side of the LATEST request - cache reads included. See contextTokens: this
   * is window occupancy, which is not the same quantity as `totalTokens` above.
   */
  contextTokens: number | null;
  /** The active model's window, from the server's catalog. Null when it states none. */
  contextWindow: number | null;
  /** The account's personal credit balance. Null when it could not be read. */
  credits: number | null;
  /** Why the balance is null, for the tooltip. Never set alongside a real balance. */
  creditsError?: string;
  /** What the last completed turn cost, for the tooltip's split. Deliberately a SEPARATE figure. */
  lastTurn?: ChatUsage | null;
}

/** Stands in for a figure nobody has stated, so the row keeps its shape and reads as unknown. */
const UNKNOWN = '--';

/**
 * The input side of one request: everything that occupied the context window to serve it.
 *
 * Cache reads are INCLUDED here and excluded from `totalTokens`, and the difference is the
 * whole point of the two functions. `totalTokens` is a COST proxy, so it drops the tokens that
 * were served cheaply from cache; this is an OCCUPANCY measure, and a cached token takes up
 * exactly as much of the window as a fresh one. Folding the two together makes the status line
 * either overprice a tool loop or understate how full it is.
 */
export function inputSide(usage: ChatUsage | null | undefined): number | null {
  if (!usage) return null;
  const parts = [usage.inputTokens, usage.cacheReadInputTokens, usage.cacheCreationInputTokens];
  if (parts.every(part => part === undefined)) return null;
  return parts.reduce((sum: number, part) => sum + (part ?? 0), 0);
}

/**
 * How full the window was when this reply's last request went out.
 *
 * The LAST ROUND's input, never a sum over the rounds. An agent turn makes one request per tool
 * round and each one re-sends the conversation so far, so summing them counts the same context
 * dozens of times over and sails past 100% in any real tool loop. The message's own `usage` is
 * that sum - it is the turn's BILL, and it is the wrong number for this.
 *
 * A message with tool calls but no rounds was stored before rounds were recorded: its per-round
 * inputs were never kept, so the answer is unknown rather than its summed bill.
 */
export function contextTokens(message: ChatMessage | null | undefined): number | null {
  if (!message || message.role !== 'assistant') return null;

  const rounds = message.rounds;
  if (rounds?.length) {
    for (let index = rounds.length - 1; index >= 0; index--) {
      const measured = inputSide(rounds[index].usage);
      if (measured !== null) return measured;
    }
    return null;
  }

  if (message.toolCalls?.length) return null;
  return inputSide(message.usage);
}

/**
 * The reply whose request the context figure describes: the most recent assistant message.
 *
 * Messages typed since are deliberately skipped rather than counted - they will occupy the
 * window on the next request, and this reports what the last one actually used.
 *
 * The scan STOPS at a context boundary, which is what makes the indicator answer the question
 * the user asked `/clear` or `/compact` to change. The request behind a reply from before the
 * boundary measured a window that no longer exists, and reporting it would tell the user their
 * compaction did nothing. With no reply since, the answer is null - not measured yet - and the
 * figure reads as unknown until the next turn states a real one.
 *
 * `turnOpen` exists because a reply being streamed has stated nothing to measure yet. Its
 * `rounds` and its own `usage` both arrive with the terminal event, and the 'usage' events in
 * between carry the turn's running BILL, which is the wrong quantity for occupancy - see
 * inputSide. Read off the open reply, the figure would be unknown for the whole turn, so the
 * indicator would blank itself the moment the user pressed send. With it set, an assistant
 * message that measures nothing is passed over and the last request that DID state a figure is
 * the one reported, which is why the ring holds still through a turn and steps at the end of
 * it. Only while the turn is open: a settled conversation still reports its newest reply, so a
 * stored message that measured nothing still reads as unknown rather than as an older turn.
 */
export function latestReply(messages: readonly ChatMessage[], turnOpen = false): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.boundary) return null;
    if (message.role !== 'assistant') continue;
    if (turnOpen && contextTokens(message) === null) continue;
    return message;
  }
  return null;
}

/** "22" for a window that is 22% full; null when either half of the fraction is unknown. */
export function contextPercent(tokens: number | null, window: number | null): number | null {
  if (tokens === null || window === null || window <= 0) return null;
  return Math.round((tokens / window) * 100);
}

/**
 * What the ring is coloured by: how much room is left, in the three bands that change a
 * decision.
 *
 * The number itself is one hover and one squint away, and the user glancing at the composer is
 * asking one question - do I still have room? Primary up to three quarters, warning past it,
 * danger once a long reply plus its tool results would not fit. Returned as a Joy palette name
 * rather than a colour so both themes get their own value for it.
 *
 * An unknown occupancy is neutral: there is no band to be in, and borrowing the full-window
 * colour for a figure nobody stated is the one reading this file never allows.
 */
export function occupancyColor(percent: number | null): 'neutral' | 'primary' | 'warning' | 'danger' {
  if (percent === null) return 'neutral';
  if (percent >= 90) return 'danger';
  if (percent >= 75) return 'warning';
  return 'primary';
}

/**
 * The arc the ring draws for an occupancy, as a percentage of the circle.
 *
 * Floored, and the floor is the point. The ring is the whole indicator now, so the only thing
 * telling a measured context from an unmeasured one is whether an arc is there at all - and a
 * real occupancy under a percent draws two or three pixels on a 14px circle, which is the empty
 * ring. This is the same distinction formatOccupancy makes by writing "<1%" instead of "0%",
 * said in the only language a ring has.
 */
export function occupancyArc(percent: number): number {
  return Math.min(100, Math.max(4, percent));
}

/**
 * How full the window reads on the indicator: "22%", or "<1%" for a real but tiny occupancy.
 *
 * A million-token window sits under half a percent for the first several turns, and rounding
 * that to "0%" renders a measured context identically to no context at all - the same
 * something-shown-as-nothing this file avoids everywhere else.
 */
function formatOccupancy(percent: number, tokens: number): string {
  if (percent === 0 && tokens > 0) return '<1%';
  return `${percent}%`;
}

/**
 * The composer's usage indicator in words: how full the context window is, in one short field.
 *
 * No longer drawn. The ring took over the composer's status line and this became its ACCESSIBLE
 * NAME, which is why it still keeps the noun: "3%" announced on its own, on a row that also
 * carries a model and an effort, names no quantity at all. Dropping the words along with the
 * glyph would have taken the figure away from a screen reader entirely, which is not what
 * replacing a label with a picture is supposed to mean.
 *
 * The balance is deliberately NOT here. It belongs to the account rather than to this
 * conversation, it is the slower-moving of the two, and putting both on a row that already
 * carries the approval pill and the model picker is what would squeeze the line. It is one
 * hover away instead - see describeUsage.
 *
 * `--` rather than an omitted field when the window figure is unknown, so the row holds its
 * shape and the hover target stays where the user last found it. Null only when NEITHER figure
 * is known, which is the caller's cue to fall back to its own word.
 */
export function usageLabel(usage: ComposerUsage): string | null {
  const percent = contextPercent(usage.contextTokens, usage.contextWindow);
  if (percent === null && usage.credits === null) return null;

  return `Context ${percent === null ? UNKNOWN : formatOccupancy(percent, usage.contextTokens ?? 0)}`;
}

/** "31,667" - the balance as the server stated it, grouped so a five-figure number stays readable. */
export function formatCredits(balance: number): string {
  return Math.round(balance).toLocaleString('en-US');
}

/**
 * The tooltip behind that line: the same two figures in full, plus what the last turn cost.
 *
 * Context and cost are named apart on purpose. They are computed from different sides of the
 * same reports and a reader who takes one for the other will conclude the window is far fuller
 * than it is - see inputSide.
 */
export function describeUsage(usage: ComposerUsage): string | null {
  const lines: string[] = [];

  if (usage.contextTokens === null) {
    lines.push('Context - nothing measured in this conversation yet');
  } else if (usage.contextWindow === null) {
    // No percentage, rather than a percentage of a window this client made up.
    lines.push(`Context ${formatTokens(usage.contextTokens)} used - this model reports no window size`);
  } else {
    const percent = contextPercent(usage.contextTokens, usage.contextWindow) ?? 0;
    const share = formatOccupancy(percent, usage.contextTokens);
    lines.push(`Context ${formatTokens(usage.contextTokens)} / ${formatTokens(usage.contextWindow)} (${share})`);
  }

  lines.push(
    usage.credits === null
      ? `Credits - ${usage.creditsError ?? 'not available'}`
      : // Named as personal because it is: a turn billed to an organization draws on a pool
        // this number does not describe, per the endpoint's own contract.
        `Credits ${formatCredits(usage.credits)} personal balance`
  );

  const split = describeSplit(usage.lastTurn);
  if (split) {
    const cost = formatCost(usage.lastTurn);
    lines.push(`Last turn ${split}${cost ? ` - ${cost}` : ''}`);
  }

  return lines.join('\n');
}
