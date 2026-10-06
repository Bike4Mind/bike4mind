import type { ChatMessage, ChatToolCall, ChatUsage } from '@shared/chat';
import { pendingCodePhrase, type PendingCode } from './codeStream';
import { activePhrase, summarizeInput } from './toolRows';

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
 * A second or two between tokens is ordinary model latency; ten is not. The case this exists
 * for sat at "Responding..." for 27 minutes with nothing arriving behind it.
 */
export const STALL_AFTER_MS = 10_000;

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
 * The third field: WHAT the turn is doing, as something that can be opened.
 *
 * Read off the state the turn already publishes - tool statuses, the progress lines the slow
 * tools report, the text arriving - rather than asked for. Approval outranks everything,
 * because a turn parked at the gate is not working on anything at all.
 *
 * `label` is the one line the status row reads at rest. Everything beside it is a HANDLE on the
 * live thing - the call, the calls, the streamed body - and never a rendered string: this is
 * recomputed on every frame of a stream, and the detail behind the label is built only once
 * somebody expands it. See activityDetail.
 *
 * Code being written is still named rather than shown in the transcript; `pending` carries its
 * body for the disclosure, which the user opens on purpose. See presentReply.
 */
export type TurnActivity =
  | { kind: 'approval'; label: string; call: ChatToolCall }
  | { kind: 'tool'; label: string; call: ChatToolCall }
  | { kind: 'tools'; label: string; calls: readonly ChatToolCall[] }
  | { kind: 'code'; label: string; pending: PendingCode }
  | { kind: 'text'; label: string; text: string }
  | { kind: 'thinking'; label: string }
  | { kind: 'stalled'; label: string; silentMs: number; last: TurnActivity };

/** As much of a label as fits a line that must not wrap at any window width. */
const MAX_LABEL_CHARS = 90;

/** Whitespace flattened and the whole thing capped: a label is one line or it is not a label. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_LABEL_CHARS ? flat : `${flat.slice(0, MAX_LABEL_CHARS - 3)}...`;
}

/**
 * As much of the last line with anything on it as a label could ever use.
 *
 * Scanned backwards rather than `split('\n').at(-1)`, and only the first LABEL_SCAN_CHARS of the
 * line are taken: both halves of that are the per-frame cost. A reply with no newline in it at
 * all is one line of half a megabyte, and trimming and flattening the whole of it to print
 * ninety characters measured 2.2ms per frame - on a path that runs on every frame of a stream.
 */
const LABEL_SCAN_CHARS = 400;

function lastLine(text: string): string {
  let end = text.length;
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 1) + 1;
    const line = text.slice(start, Math.min(end, start + LABEL_SCAN_CHARS)).trim();
    if (line) return line;
    end = start - 1;
  }
  return '';
}

export function describeActivity(
  calls: readonly ChatToolCall[],
  hasText: boolean,
  pending: PendingCode | null = null,
  text = ''
): TurnActivity {
  const waiting = calls.find(call => call.status === 'awaiting-approval');
  if (waiting) return { kind: 'approval', label: 'Waiting for your answer...', call: waiting };

  const running = calls.filter(call => call.status === 'running');
  if (running.length === 1) {
    const only = running[0];
    return { kind: 'tool', label: oneLine(only.progress ?? '') || activePhrase(only.name), call: only };
  }
  if (running.length > 1) return { kind: 'tools', label: `Running ${running.length} tools...`, calls: running };
  if (pending) return { kind: 'code', label: pendingCodePhrase(pending), pending };

  if (!hasText) return { kind: 'thinking', label: 'Thinking...' };
  // The text itself, not a word for it: "Responding..." is true of every turn that ever ran and
  // tells the reader nothing about this one. Only when there is no line yet to show.
  return { kind: 'text', label: oneLine(lastLine(text)) || 'Responding...', text };
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
  return { kind: 'stalled', label: `Waiting for the model... ${formatElapsed(silentMs)}`, silentMs, last: activity };
}

/** One running tool inside the disclosure, as its own row. */
export interface ActivityDetailRow {
  id: string;
  /** Present tense: these rows are things still happening. */
  label: string;
  /** What it was called with, already flattened to a line. */
  input?: string;
  /** The tool's latest progress line, when it reports one. */
  progress?: string;
}

/** What the line discloses, built only for an OPEN disclosure. */
export interface ActivityDetail {
  note?: string;
  rows?: ActivityDetailRow[];
  /** A block of text, already bounded to a tail this view can hold. */
  body?: string;
}

/**
 * Whether the label has anything behind it, cheaply enough to ask on every frame.
 *
 * Deliberately not "is the detail non-empty", which would mean building the detail to find out -
 * the one thing a collapsed line must never do.
 */
export function hasActivityDetail(activity: TurnActivity): boolean {
  switch (activity.kind) {
    case 'approval':
    case 'tool':
    case 'tools':
    case 'stalled':
      return true;
    case 'code':
      return activity.pending.body.trim().length > 0;
    case 'text':
      return activity.text.trim().length > 0;
    default:
      return false;
  }
}

const DETAIL_CHARS = 1200;
const DETAIL_LINES = 12;

/**
 * How many tools one disclosure lists.
 *
 * A turn can fan out further than this, and a panel that grows a row per call is the unbounded
 * block this view exists to avoid. The rest are counted rather than drawn.
 */
const MAX_DETAIL_ROWS = 6;

/** The end of a stream, which is where the news is. Bounded twice: characters, then lines. */
function tailBlock(text: string): string {
  const tail = text.length > DETAIL_CHARS ? text.slice(text.length - DETAIL_CHARS) : text;
  const lines = tail.split('\n');
  return (lines.length > DETAIL_LINES ? lines.slice(lines.length - DETAIL_LINES) : lines).join('\n').trim();
}

/** The start of a fixed argument, which is where ITS meaning is - a command, a path, a prompt. */
function headBlock(text: string): string {
  const lines = text.slice(0, DETAIL_CHARS).split('\n');
  const kept = lines.length > DETAIL_LINES ? lines.slice(0, DETAIL_LINES) : lines;
  const block = kept.join('\n').trim();
  return block.length < text.trim().length ? `${block}\n...` : block;
}

function runningRow(call: ChatToolCall): ActivityDetailRow {
  const input = oneLine(summarizeInput(call));
  const progress = oneLine(call.progress ?? '');
  return {
    id: call.id,
    // activePhrase, never the transcript's row label: that one is past tense, and a call that is
    // still running has not done anything yet.
    label: activePhrase(call.name),
    ...(input ? { input } : {}),
    ...(progress ? { progress } : {}),
  };
}

function runningRows(calls: readonly ChatToolCall[]): ActivityDetailRow[] {
  const shown = calls.slice(0, MAX_DETAIL_ROWS).map(runningRow);
  const hidden = calls.length - shown.length;
  return hidden > 0 ? [...shown, { id: 'more', label: `and ${hidden} more...` }] : shown;
}

/**
 * The live detail behind the label - the only expensive thing in this file.
 *
 * Called ONLY from an expanded disclosure, once per render of it, and every branch returns
 * something bounded: a capped head or tail of a block, or at most MAX_DETAIL_ROWS rows carrying
 * one progress line each. Nothing here grows with the length of a turn.
 */
export function activityDetail(activity: TurnActivity): ActivityDetail | null {
  switch (activity.kind) {
    case 'approval': {
      const asked = activity.call.approvalDetail ?? summarizeInput(activity.call);
      return {
        note: 'Waiting for you to answer this in the transcript:',
        ...(asked ? { body: headBlock(asked) } : {}),
      };
    }
    case 'tool':
      return { rows: runningRows([activity.call]) };
    case 'tools':
      return { rows: runningRows(activity.calls) };
    case 'code':
      return { body: tailBlock(activity.pending.body) };
    case 'text':
      return { body: tailBlock(activity.text) };
    case 'stalled': {
      const under = activityDetail(activity.last);
      return {
        note: `Nothing has arrived for ${formatElapsed(activity.silentMs)}. Last: ${activity.last.label}`,
        ...(under?.rows ? { rows: under.rows } : {}),
        ...(under?.body ? { body: under.body } : {}),
      };
    }
    default:
      return null;
  }
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
