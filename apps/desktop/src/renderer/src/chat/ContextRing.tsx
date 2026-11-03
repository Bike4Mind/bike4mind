import { useEffect, useState } from 'react';
import Box from '@mui/joy/Box';
import CircularProgress from '@mui/joy/CircularProgress';
import Tooltip from '@mui/joy/Tooltip';
import { isLocalModel, type ChatPromptCacheStamp } from '@shared/chat';
import {
  cacheLine,
  coldAt,
  contextLine,
  contextRingValue,
  contextTooltip,
  showColdDot,
  type CacheStatus,
} from './contextStatus';
import { promptCacheExpiresAt } from './modelSwitchCost';
import { useLoadedModelState } from './useLoadedModelState';

/** Re-renders once a second while `active`, so a countdown in an open tooltip stays live. */
function useSecondTick(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick(tick => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
}

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Re-renders once when `at` passes, so the ring notices a cache going cold while its tooltip is closed. */
function useRerenderAt(at: number | null): void {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (at === null) return;
    const remaining = at - Date.now();
    if (remaining <= 0) return;
    // Each fire re-renders and re-arms until the clock really passes `at`; a timer can fire a
    // millisecond early, and setTimeout cannot wait longer than MAX_TIMEOUT_MS.
    const timer = setTimeout(() => setTick(count => count + 1), Math.min(remaining, MAX_TIMEOUT_MS));
    return () => clearTimeout(timer);
  }, [at, tick]);
}

/**
 * The composer's context ring: how full the conversation's context is, and in the tooltip what is
 * known about its cache. Cloud models count down the last reply's prompt-cache stamp; local
 * Ollama models report whether the model is loaded. Nothing is said about the cache mid-turn.
 * A cold cache after an earlier reply also puts an amber dot in the ring's center.
 */
export function ContextRing({
  tokens,
  limit,
  modelId,
  promptCache,
  streaming,
  hasReply,
}: {
  tokens: number | null;
  limit: number | null;
  modelId: string | null;
  /** The latest settled reply's stamp; only counts down while it was written for `modelId`. */
  promptCache: ChatPromptCacheStamp | undefined;
  streaming: boolean;
  /** Whether the conversation has an assistant reply for the cache to have been warmed by. */
  hasReply: boolean;
}) {
  const local = !!modelId && isLocalModel(modelId);
  const loaded = useLoadedModelState(local ? modelId : null, !streaming);
  const [open, setOpen] = useState(false);
  useSecondTick(open);

  const expiresAt = promptCache && promptCache.model === modelId ? promptCacheExpiresAt(promptCache) : null;
  let status: CacheStatus | null = null;
  if (!streaming && local && loaded.state) status = { kind: 'local', state: loaded.state };
  else if (!streaming && !local && expiresAt !== null) status = { kind: 'cloud', expiresAt };

  useRerenderAt(coldAt(status, Date.now()));

  const now = Date.now();
  const ring = contextRingValue(tokens, limit);
  const cache = cacheLine(status, now, tokens);
  const cold = showColdDot(status, now, { streaming, hasReply });
  const title = contextTooltip(tokens, limit, cache);
  const label = cold && cache ? `${contextLine(tokens, limit)}. ${cache}` : contextLine(tokens, limit);

  return (
    <Tooltip
      title={<span data-testid="composer-context-tooltip">{title}</span>}
      placement="top"
      variant="soft"
      size="sm"
      onOpen={() => {
        setOpen(true);
        loaded.refresh();
      }}
      onClose={() => setOpen(false)}
      sx={{ whiteSpace: 'pre-line', maxWidth: 360 }}
    >
      <Box tabIndex={0} sx={{ display: 'inline-flex', position: 'relative' }} data-testid="composer-context">
        <CircularProgress
          determinate
          value={ring.arc}
          color={ring.color}
          sx={{
            '--CircularProgress-size': '14px',
            '--CircularProgress-trackThickness': '2px',
            '--CircularProgress-progressThickness': '2px',
            ...(ring.percent === null ? { opacity: 0.5 } : {}),
          }}
          aria-label={label}
          data-testid="composer-context-ring"
        />
        {cold && (
          <Box
            aria-hidden
            data-testid="composer-context-cold"
            sx={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              width: 6,
              height: 6,
              transform: 'translate(-50%, -50%)',
              borderRadius: '50%',
              bgcolor: 'warning.solidBg',
            }}
          />
        )}
      </Box>
    </Tooltip>
  );
}
