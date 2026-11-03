import type { LoadedModelState } from '@shared/models';
import {
  contextPercent,
  formatElapsed,
  formatOccupancy,
  formatTokens,
  occupancyArc,
  occupancyColor,
} from './statusLine';

/** How often an idle local conversation re-reads `/api/ps`; Ollama's default keep-alive is 5 minutes. */
export const LOADED_POLL_MS = 20_000;

/** Past this a keep-alive is effectively forever (Ollama's `keep_alive: -1` reports a date centuries out). */
export const KEEP_ALIVE_FOREVER_MS = 30 * 24 * 60 * 60 * 1000;

/** What the tooltip says about the cache: a cloud prompt cache's expiry, or a local model's memory state. */
export type CacheStatus = { kind: 'cloud'; expiresAt: number } | { kind: 'local'; state: LoadedModelState };

export function contextRingValue(
  tokens: number | null,
  limit: number | null
): { percent: number | null; arc: number; color: ReturnType<typeof occupancyColor> } {
  const percent = contextPercent(tokens, limit);
  return { percent, arc: percent === null ? 0 : occupancyArc(percent), color: occupancyColor(percent) };
}

/** "34k / 262k context (13%)". */
export function contextLine(tokens: number | null, limit: number | null): string {
  if (tokens === null) return 'Context not measured yet';
  const percent = contextPercent(tokens, limit);
  if (limit === null || percent === null) return `${formatTokens(tokens)} context used`;
  return `${formatTokens(tokens)} / ${formatTokens(limit)} context (${formatOccupancy(percent, tokens)})`;
}

/** Null when there is nothing honest to say: no stamp, a runtime with no report, or a failed read. */
export function cacheLine(status: CacheStatus | null, now: number): string | null {
  if (!status) return null;
  if (status.kind === 'cloud') {
    const remaining = status.expiresAt - now;
    return remaining > 0 ? `Prompt cache warm, expires in ${formatElapsed(remaining)}` : 'Prompt cache expired';
  }
  const { state } = status;
  if (state.kind === 'unloaded') return 'Model not loaded';
  if (state.kind !== 'loaded') return null;
  if (state.expiresAt === null) return 'Model loaded';
  const remaining = state.expiresAt - now;
  if (remaining > KEEP_ALIVE_FOREVER_MS) return 'Model loaded, no keep-alive limit';
  return remaining > 0 ? `Model loaded, unloads in ${formatElapsed(remaining)}` : 'Model not loaded';
}

export function contextTooltip(tokens: number | null, limit: number | null, cache: string | null): string {
  return cache ? `${contextLine(tokens, limit)}\n${cache}` : contextLine(tokens, limit);
}
