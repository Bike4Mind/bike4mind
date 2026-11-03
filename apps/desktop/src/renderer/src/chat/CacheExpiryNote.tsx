import { useEffect, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import IconButton from '@mui/joy/IconButton';
import type { SxProps } from '@mui/joy/styles/types';
import type { PromptCacheTtl } from '@bike4mind/common';
import type { ChatModelOption, ChatPromptCacheStamp } from '@shared/chat';
import { CloseIcon } from './icons';
import { cacheExpiryNoticeCredits, promptCacheExpiresAt } from './modelSwitchCost';

const creditFormat = new Intl.NumberFormat('en-US');

/** Flips once at `expiresAt` from a single timer; no polling. */
export function usePromptCacheExpired(expiresAt: number | null): boolean {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (expiresAt == null) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      setNow(Date.now());
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [expiresAt]);

  return expiresAt != null && now >= expiresAt;
}

/**
 * Above the composer once the last reply's prompt cache has expired and the next message would
 * re-write enough of the conversation to matter. Hidden while a turn runs; a dismissal lasts until
 * the next reply leaves a new cache behind.
 */
export function CacheExpiryNote({
  stamp,
  model,
  contextTokens,
  ttl,
  turnOpen,
  sx,
}: {
  /** The latest settled reply's stamp; absent for a new chat or a model Desktop does not cache. */
  stamp: ChatPromptCacheStamp | undefined;
  model: ChatModelOption | undefined;
  contextTokens: number;
  /** The TTL the next message will write at. */
  ttl: PromptCacheTtl;
  turnOpen: boolean;
  /** The wrapper's layout, so nothing takes space while the note is hidden. */
  sx?: SxProps;
}) {
  const expiresAt = promptCacheExpiresAt(stamp);
  const expired = usePromptCacheExpired(expiresAt);
  const [dismissedFor, setDismissedFor] = useState<number | null>(null);
  const credits = cacheExpiryNoticeCredits({ expired, stamp, model, contextTokens, ttl });
  if (turnOpen || credits === null || dismissedFor === expiresAt) return null;

  return (
    <Box sx={sx}>
      <Alert
        size="sm"
        color="neutral"
        variant="soft"
        data-testid="chat-cache-expiry-note"
        endDecorator={
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Dismiss expired cache note"
            data-testid="chat-cache-expiry-note-dismiss"
            onClick={() => setDismissedFor(expiresAt)}
          >
            <CloseIcon />
          </IconButton>
        }
      >
        <span data-testid="chat-cache-expiry-note-text">
          This chat&apos;s cache has expired: about {creditFormat.format(credits)} credits for the next message.
        </span>
      </Alert>
    </Box>
  );
}
