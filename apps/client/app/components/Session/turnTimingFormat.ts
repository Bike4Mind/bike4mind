import { MAX_RECORDED_TURN_RETRIES, type ITurnTiming, type TurnRetryReason } from '@bike4mind/common';
import { formatDuration } from './formatDuration';

export const TURN_RETRY_REASON_LABELS: Record<TurnRetryReason, string> = {
  stream_idle_timeout: 'response stalled',
  stream_truncated: 'response cut off',
  request_timeout: 'request timed out',
  rate_limit: 'rate limited',
  overloaded: 'provider busy',
  server_error: 'provider error',
  transport: 'connection dropped',
  tool_pairing: 'tool history repaired',
  other: 'other error',
};

/** A reply took long enough that its turn ID is worth surfacing even without retries, in ms. */
export const SLOW_TURN_THRESHOLD_MS = 60_000;

/** Whether the reply footer should offer the turn ID: the turn retried, fell back, or ran slow. */
export function isNotableTurn(timing: ITurnTiming | undefined): timing is ITurnTiming {
  if (!timing) return false;
  return timing.retries.length > 0 || timing.fallbackHops > 0 || (timing.totalMs ?? 0) >= SLOW_TURN_THRESHOLD_MS;
}

/** Distinct reasons in first-seen order, so "stalled, stalled, busy" reads as "stalled, busy". */
function distinctReasonLabels(timing: ITurnTiming): string[] {
  return [...new Set(timing.retries.map(retry => TURN_RETRY_REASON_LABELS[retry.reason] ?? retry.reason))];
}

/** A full list means the recorder stopped at its cap, so the real count is that or more. */
function formatRetryCount(timing: ITurnTiming): string {
  const count = timing.retries.length;
  return count >= MAX_RECORDED_TURN_RETRIES ? `${count}+` : `${count}`;
}

/** One line for the reply footer, e.g. "Took 6m 55s - 3 retries (response stalled)". */
export function summarizeTurnTiming(timing: ITurnTiming): string {
  const parts: string[] = [];
  if (timing.totalMs !== undefined) parts.push(`Took ${formatDuration(timing.totalMs)}`);

  const retryCount = timing.retries.length;
  if (retryCount > 0) {
    parts.push(
      `${formatRetryCount(timing)} ${retryCount === 1 ? 'retry' : 'retries'} (${distinctReasonLabels(timing).join(', ')})`
    );
  }
  if (timing.fallbackHops > 0) {
    parts.push(`${timing.fallbackHops} model ${timing.fallbackHops === 1 ? 'switch' : 'switches'}`);
  }
  return parts.join(' - ');
}

/** The inspector's "copy as markdown" section. */
export function turnTimingMarkdown(timing: ITurnTiming | undefined): string {
  if (!timing) return '## Turn Timing\n- not recorded for this reply';

  const lines = [
    '## Turn Timing',
    `- **Total**: ${timing.totalMs !== undefined ? `${timing.totalMs} ms` : 'still running'}`,
    `- **Queue (created to processing)**: ${timing.queueMs} ms`,
    `- **Context build**: ${timing.contextBuildMs !== undefined ? `${timing.contextBuildMs} ms` : 'N/A'}`,
    `- **Concurrency slot wait**: ${timing.semaphoreWaitMs} ms`,
    `- **Fallback hops**: ${timing.fallbackHops}`,
    `- **Retries**: ${formatRetryCount(timing)}`,
  ];
  for (const retry of timing.retries) {
    const details = [
      retry.status !== undefined ? `status ${retry.status}` : null,
      retry.retryAfterMs !== undefined ? `retry-after ${retry.retryAfterMs} ms` : null,
      retry.requestId ? `request ${retry.requestId}` : null,
    ].filter(Boolean);
    lines.push(
      `  - ${new Date(retry.at).toISOString()} ${retry.reason} on ${retry.model}, waited ${retry.delayMs} ms` +
        (details.length ? ` (${details.join(', ')})` : '')
    );
  }
  return lines.join('\n');
}
