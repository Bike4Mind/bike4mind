import { useEffect, useState } from 'react';
import Box from '@mui/joy/Box';
import CircularProgress from '@mui/joy/CircularProgress';
import Tooltip from '@mui/joy/Tooltip';
import { isLocalModel, type ChatPromptCacheStamp } from '@shared/chat';
import { cacheLine, contextLine, contextRingValue, contextTooltip, type CacheStatus } from './contextStatus';
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

/**
 * The composer's context ring: how full the conversation's context is, and in the tooltip what is
 * known about its cache. Cloud models count down the last reply's prompt-cache stamp; local
 * Ollama models report whether the model is loaded. Nothing is said about the cache mid-turn.
 */
export function ContextRing({
  tokens,
  limit,
  modelId,
  promptCache,
  streaming,
}: {
  tokens: number | null;
  limit: number | null;
  modelId: string | null;
  /** The latest settled reply's stamp; only counts down while it was written for `modelId`. */
  promptCache: ChatPromptCacheStamp | undefined;
  streaming: boolean;
}) {
  const local = !!modelId && isLocalModel(modelId);
  const loaded = useLoadedModelState(local ? modelId : null, !streaming);
  const [open, setOpen] = useState(false);
  useSecondTick(open);

  const expiresAt = promptCache && promptCache.model === modelId ? promptCacheExpiresAt(promptCache) : null;
  let status: CacheStatus | null = null;
  if (!streaming && local && loaded.state) status = { kind: 'local', state: loaded.state };
  else if (!streaming && !local && expiresAt !== null) status = { kind: 'cloud', expiresAt };

  const ring = contextRingValue(tokens, limit);
  const title = contextTooltip(tokens, limit, cacheLine(status, Date.now()));

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
      <Box sx={{ display: 'inline-flex' }} data-testid="composer-context">
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
          aria-label={contextLine(tokens, limit)}
          data-testid="composer-context-ring"
        />
      </Box>
    </Tooltip>
  );
}
