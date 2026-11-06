import { useEffect, useState } from 'react';
import {
  DEFAULT_PROMPT_CACHE_TTL,
  PROMPT_CACHE_TTL_MS,
  isPromptCacheTtl,
  type PromptCacheTtl,
} from '@bike4mind/common';

interface TurnTimes {
  timestamp?: Date | string | number;
  turnTiming?: { queueMs: number; contextBuildMs?: number; totalMs?: number };
  promptMeta?: { tokenUsage?: { promptCacheTtl?: unknown } };
}

/**
 * When the prompt cache a turn left behind expires (epoch ms), or null when the turn has no time.
 *
 * A cache entry lives for its TTL after the start of the last request that wrote or read it. The
 * last request of a turn starts just before the reply finishes, so the anchor is the turn's end;
 * it errs late by at most that request's generation time and never calls a warm cache expired.
 * Turns from before the TTL was recorded ran on the 5-minute cache.
 */
export function promptCacheExpiresAt(turn: TurnTimes): number | null {
  if (turn.timestamp === undefined) return null;
  const startedAt = new Date(turn.timestamp).getTime();
  if (!Number.isFinite(startedAt)) return null;
  const timing = turn.turnTiming;
  const lastRequestAt =
    timing?.totalMs !== undefined
      ? startedAt + timing.totalMs
      : startedAt + (timing?.queueMs ?? 0) + (timing?.contextBuildMs ?? 0);
  return lastRequestAt + PROMPT_CACHE_TTL_MS[turnCacheTtl(turn)];
}

export function turnCacheTtl(turn: TurnTimes): PromptCacheTtl {
  const ttl = turn.promptMeta?.tokenUsage?.promptCacheTtl;
  return isPromptCacheTtl(ttl) ? ttl : DEFAULT_PROMPT_CACHE_TTL;
}

/** True once `expiresAt` has passed; one timer flips it at that moment, no polling. */
export function usePromptCacheExpired(expiresAt: number | null | undefined): boolean {
  const [now, setNow] = useState(() => Date.now());
  const expired = expiresAt != null && now >= expiresAt;

  useEffect(() => {
    if (expiresAt == null) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNow(Date.now());
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [expiresAt]);

  return expired;
}
