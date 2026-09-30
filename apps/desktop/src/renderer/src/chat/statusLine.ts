import type { ChatToolCall, ChatUsage } from '@shared/chat';
import { pendingCodePhrase, type PendingCode } from './codeStream';
import { activePhrase } from './toolRows';

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
 * The third field: a short description of what the turn is doing right now.
 *
 * Read off the state the turn already publishes - tool statuses and the progress lines the slow
 * tools report - rather than asked for. Approval outranks everything, because a turn parked at
 * the gate is not working on anything at all. Code being written is named rather than shown; see
 * presentReply.
 */
export function describeActivity(
  calls: readonly ChatToolCall[],
  hasText: boolean,
  pending: PendingCode | null = null
): string {
  if (calls.some(call => call.status === 'awaiting-approval')) return 'Waiting for your answer...';

  const running = calls.filter(call => call.status === 'running');
  if (running.length === 1) {
    const only = running[0];
    return only.progress?.trim() || activePhrase(only.name);
  }
  if (running.length > 1) return 'Running tools...';
  if (pending) return pendingCodePhrase(pending);

  return hasText ? 'Responding...' : 'Thinking...';
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
