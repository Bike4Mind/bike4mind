import type { ChatTokenRate } from '@shared/chat';
import { formatTokens } from './statusLine';

function perSecond(tokens: number, ms: number): number {
  return (tokens / ms) * 1000;
}

function formatPerSecond(rate: number): string {
  return `${rate >= 100 ? Math.round(rate) : rate.toFixed(1)} tok/s`;
}

export function formatSeconds(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** "23.9 tok/s", or "~23.9 tok/s" when this app timed the stream itself. Null with nothing measured. */
export function formatTokenRate(rate: ChatTokenRate | null | undefined): string | null {
  if (!rate || rate.evalTokens <= 0 || rate.evalMs <= 0) return null;
  return `${rate.estimated ? '~' : ''}${formatPerSecond(perSecond(rate.evalTokens, rate.evalMs))}`;
}

/**
 * The tooltip lines: generation, then prompt, load and draft acceptance where the server reported
 * them. `outputTokens` is the whole turn's; when it exceeds the timed tokens, the line says so.
 */
export function describeTokenRate(rate: ChatTokenRate | null | undefined, outputTokens?: number): string | null {
  const headline = formatTokenRate(rate);
  if (!rate || !headline) return null;
  const timed =
    outputTokens !== undefined && outputTokens > rate.evalTokens
      ? `timed ${formatTokens(rate.evalTokens)} of ${formatTokens(outputTokens)} output tokens`
      : `${formatTokens(rate.evalTokens)} tokens`;
  const lines = [`Generation: ${headline} (${timed} in ${formatSeconds(rate.evalMs)})`];
  if (rate.estimated) lines.push('Estimated from stream timing; the server reported no timings');
  if (rate.promptTokens !== undefined && rate.promptMs !== undefined && rate.promptMs > 0)
    lines.push(
      `Prompt: ${formatPerSecond(perSecond(rate.promptTokens, rate.promptMs))} (${formatTokens(rate.promptTokens)} tokens in ${formatSeconds(rate.promptMs)})`
    );
  if (rate.loadMs !== undefined) lines.push(`Load (total): ${formatSeconds(rate.loadMs)}`);
  if (rate.draftTokens !== undefined && rate.draftAccepted !== undefined && rate.draftTokens > 0)
    lines.push(
      `Draft acceptance: ${Math.round((rate.draftAccepted / rate.draftTokens) * 100)}% (${rate.draftAccepted} of ${rate.draftTokens})`
    );
  return lines.join('\n');
}
