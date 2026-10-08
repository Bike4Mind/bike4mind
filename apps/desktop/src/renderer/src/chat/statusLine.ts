import type { ChatToolCall, ChatUsage, ModelPhase } from '@shared/chat';
import { AUTO_COMPACT_PERCENT, autoCompactThreshold } from '@shared/contextLimit';
import { pendingCodePhrase, type PendingCode } from './codeStream';
import { activePhrase } from './toolRows';

export { contextTokens, inputSide, latestReply } from '@shared/contextLimit';

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
}

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

/** "$3.20", or four places where two would round a real charge away to "$0.00". */
function formatUsd(usd: number): string {
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
}

/** "$3.20" from the server's own figure, or "12 credits" when only credits came; null when neither. */
export function formatCost(usage: ChatUsage | null | undefined): string | null {
  if (!usage) return null;
  if (usage.usdCost !== undefined) return formatUsd(usage.usdCost);
  if (usage.creditsUsed !== undefined) return `${Math.round(usage.creditsUsed).toLocaleString('en-US')} credits`;
  return null;
}

/**
 * What one reply cost, in CREDITS - deliberately not formatCost, which prefers the dollar.
 *
 * A reader asking what a reply cost is asking against a balance, and the balance is denominated
 * in credits; "$0.0004" cannot be subtracted from "31,667 credits" by eye. The dollar figure is
 * still the better one for an absolute sense of spend, so it stays - see describeReplyCost.
 *
 * Null when the server reported no credit figure. That is NOT zero, per ChatUsage: a reply from
 * before this was captured, or a turn that failed, has to render nothing rather than "0 credits".
 */
export function formatCreditsSpent(usage: ChatUsage | null | undefined): string | null {
  const credits = usage?.creditsUsed;
  if (credits === undefined) return null;
  // Spending under a credit is still spending, and rounding it to "0 credits" says it was free -
  // the same lie this file refuses to tell by rendering an absent figure as a zero.
  if (credits > 0 && Math.round(credits) === 0) return '<1 credit';
  return `${formatCredits(credits)} ${Math.round(credits) === 1 ? 'credit' : 'credits'}`;
}

/**
 * The detail behind that figure: where the tokens went, then what it came to in dollars.
 *
 * The dollar line reads `usdCost` directly rather than calling formatCost, which falls back to
 * credits when no dollar figure came - repeating the headline in the line meant to add to it.
 */
export function describeReplyCost(usage: ChatUsage | null | undefined): string | null {
  const lines: string[] = [];
  const split = describeSplit(usage);
  if (split) lines.push(split);
  if (usage?.usdCost !== undefined) lines.push(formatUsd(usage.usdCost));
  return lines.length === 0 ? null : lines.join('\n');
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
 * The third field: a short description of what the turn is doing right now.
 *
 * Read off the state the turn already publishes - tool statuses and the progress lines the slow
 * tools report - rather than asked for. Approval outranks everything, because a turn parked at
 * the gate is not working on anything at all. Code being written is named rather than shown; see
 * presentReply.
 */
export function describeActivity(
  calls: readonly ChatToolCall[],
  phase: ModelPhase | null,
  pending: PendingCode | null = null
): string {
  if (calls.some(call => call.status === 'awaiting-approval')) return 'Waiting for your answer...';

  const running = calls.filter(call => call.status === 'running');
  if (running.length === 1) {
    const only = running[0];
    return only.progress?.trim() || activePhrase(only.name);
  }
  if (running.length > 1) return 'Running tools...';
  // Named as the tool it will be while the model is still writing the call: the call's
  // arguments (a whole file, for an edit) are what takes the time, not running it.
  if (phase?.kind === 'writing-tool') return activePhrase(phase.name);
  if (pending) return pendingCodePhrase(pending);

  // Waiting reads as thinking too: a model that hides its reasoning sends nothing while it thinks.
  return phase?.kind === 'responding' ? 'Responding...' : 'Thinking...';
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
 * How full the conversation's context is, and what the account has left to spend.
 *
 * Every field is nullable and every null means NOT KNOWN rather than zero: a fresh conversation
 * has measured no request, a backend may state no window, and `/api/v1/me` can be unreachable.
 * A stand-in zero in any of them reads as a fact the server never stated.
 */
export interface ComposerUsage {
  /**
   * The whole input side of the LATEST request - cache reads included. See contextTokens: this
   * is window occupancy, which is not the same quantity as `totalTokens` above.
   */
  contextTokens: number | null;
  /**
   * What the percentage and the ring measure against: the model's window, capped - see
   * effectiveContextLimit. Not the raw window, because the conversation compacts well before a
   * 1M window fills, and a ring at 30% on the eve of a compaction would be telling the user it
   * had room it does not.
   */
  contextLimit: number | null;
  /** The model's own window, from the server's catalog, for the tooltip only. Null when unstated. */
  modelWindow?: number | null;
  /** The account's personal credit balance. Null when it could not be read. */
  credits: number | null;
  /** Why the balance is null, for the tooltip. Never set alongside a real balance. */
  creditsError?: string;
  /** What the last completed turn cost, for the tooltip's split. Deliberately a SEPARATE figure. */
  lastTurn?: ChatUsage | null;
}

/** Stands in for a figure nobody has stated, so the row keeps its shape and reads as unknown. */
const UNKNOWN = '--';

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
 * danger once a long reply plus its tool results would not fit - which is also where the next
 * message compacts the conversation first. Returned as a Joy palette name
 * rather than a colour so both themes get their own value for it.
 *
 * An unknown occupancy is neutral: there is no band to be in, and borrowing the full-window
 * colour for a figure nobody stated is the one reading this file never allows.
 */
export function occupancyColor(percent: number | null): 'neutral' | 'primary' | 'warning' | 'danger' {
  if (percent === null) return 'neutral';
  if (percent >= AUTO_COMPACT_PERCENT) return 'danger';
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
  const percent = contextPercent(usage.contextTokens, usage.contextLimit);
  if (percent === null && usage.credits === null) return null;

  return `Context ${percent === null ? UNKNOWN : formatOccupancy(percent, usage.contextTokens ?? 0)}`;
}

/** "31,667" - the balance as the server stated it, grouped so a five-figure number stays readable. */
export function formatCredits(balance: number): string {
  return Math.round(balance).toLocaleString('en-US');
}

/**
 * When the conversation will compact itself, and the model's own window where the cap hides it,
 * so nobody has to work out from "/ 400k" why a 1M model stops short of 1M.
 */
function describeCompaction(limit: number, modelWindow: number | null): string {
  const at = `Compacts automatically at ${formatTokens(autoCompactThreshold(limit))}`;
  return modelWindow !== null && modelWindow > limit
    ? `${at} - the model's own window is ${formatTokens(modelWindow)}`
    : at;
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
  } else if (usage.contextLimit === null) {
    // No percentage, rather than a percentage of a window this client made up.
    lines.push(`Context ${formatTokens(usage.contextTokens)} used - this model reports no window size`);
  } else {
    const percent = contextPercent(usage.contextTokens, usage.contextLimit) ?? 0;
    const share = formatOccupancy(percent, usage.contextTokens);
    lines.push(`Context ${formatTokens(usage.contextTokens)} / ${formatTokens(usage.contextLimit)} (${share})`);
  }
  if (usage.contextLimit !== null) lines.push(describeCompaction(usage.contextLimit, usage.modelWindow ?? null));

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
