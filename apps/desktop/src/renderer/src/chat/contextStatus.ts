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

/** Epoch ms when the status turns cold on its own, or null when it never does or already is. */
export function coldAt(status: CacheStatus | null, now: number): number | null {
  if (!status) return null;
  const at =
    status.kind === 'cloud' ? status.expiresAt : status.state.kind === 'loaded' ? status.state.expiresAt : null;
  return at !== null && at > now && at - now <= KEEP_ALIVE_FOREVER_MS ? at : null;
}

/** True when the next message would pay to rebuild the cache: an expired prompt cache or an unloaded model. */
export function isCacheCold(status: CacheStatus | null, now: number): boolean {
  if (!status) return false;
  if (status.kind === 'cloud') return status.expiresAt <= now;
  const { state } = status;
  if (state.kind === 'unloaded') return true;
  return state.kind === 'loaded' && state.expiresAt !== null && state.expiresAt <= now;
}

/**
 * Whether the ring shows its cold dot. A conversation with no earlier reply has nothing to be warm
 * from, so a fresh chat never shows it even when its local model is not loaded.
 */
export function showColdDot(
  status: CacheStatus | null,
  now: number,
  { streaming, hasReply }: { streaming: boolean; hasReply: boolean }
): boolean {
  return !streaming && hasReply && isCacheCold(status, now);
}

/** Null when there is nothing honest to say: no stamp, a runtime with no report, or a failed read. */
export function cacheLine(status: CacheStatus | null, now: number, tokens: number | null = null): string | null {
  if (!status) return null;
  const reread = tokens === null ? '' : ` ${formatTokens(tokens)} tokens`;
  if (status.kind === 'cloud') {
    const remaining = status.expiresAt - now;
    if (remaining > 0) return `Prompt cache warm, expires in ${formatElapsed(remaining)}`;
    return tokens === null ? 'Prompt cache expired' : `Prompt cache expired: the next message re-reads${reread}`;
  }
  const { state } = status;
  if (state.kind === 'loaded') {
    if (state.expiresAt === null) return 'Model loaded';
    const remaining = state.expiresAt - now;
    if (remaining > KEEP_ALIVE_FOREVER_MS) return 'Model loaded, no keep-alive limit';
    if (remaining > 0) return `Model loaded, unloads in ${formatElapsed(remaining)}`;
  } else if (state.kind !== 'unloaded') return null;
  return tokens === null ? 'Model not loaded' : `Model not loaded: the next reply loads it first and re-reads${reread}`;
}

export function contextTooltip(tokens: number | null, limit: number | null, cache: string | null): string {
  return cache ? `${contextLine(tokens, limit)}\n${cache}` : contextLine(tokens, limit);
}
