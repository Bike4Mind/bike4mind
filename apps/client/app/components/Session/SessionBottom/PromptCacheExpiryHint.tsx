import { FC, type ReactNode, useRef, useState } from 'react';
import { Box, IconButton, Typography, Tooltip, useTheme } from '@mui/joy';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';

const creditFormat = new Intl.NumberFormat('en-US');

interface PromptCacheExpiryHintProps {
  children: ReactNode;
  /** What the next message pays to re-cache the chat now that the cache is gone; null hides the hint. */
  credits: number | null;
  /** When the cache expired; dismissal lasts while this stays the same. */
  expiresAt: number | null;
}

/** Portaled callout anchored to the TTL chip, above chat controls and below menus and file drops.
 * Popper tracks the chip through layout changes without moving the surrounding composer.
 * Dismissal lasts until the next turn's cache expires.
 */
const PromptCacheExpiryHint: FC<PromptCacheExpiryHintProps> = ({ children, credits, expiresAt }) => {
  const theme = useTheme();
  const anchorRef = useRef<HTMLDivElement>(null);
  const dark = theme.palette.mode === 'dark';
  const [dismissedFor, setDismissedFor] = useState<number | null>(null);
  const open = credits !== null && dismissedFor !== expiresAt;

  const bg = dark ? '#3b2a0e' : '#fdf6cf';
  const border = dark ? 'rgba(234, 179, 8, 0.45)' : 'rgba(180, 122, 6, 0.4)';
  const accent = dark ? '#f2c14e' : '#9a6b00';

  return (
    <Tooltip
      open={open}
      arrow
      placement="top-end"
      describeChild
      disableHoverListener
      disableFocusListener
      disableTouchListener
      // Stay inside floating/docked window layers, but escape the opaque composer wrapper.
      slotProps={{
        root: {
          open,
          container: () => anchorRef.current?.closest<HTMLElement>('[data-chat-overlay-root]') ?? document.body,
        },
      }}
      variant="outlined"
      sx={{
        // Portal escapes the full composer's stacking context without covering the scroll button
        // with the composer's opaque surface. Menus (1500) and file drops (1300) stay above it.
        zIndex: 1200,
        p: 0,
        borderRadius: '8px',
        background: bg,
        borderColor: border,
        boxShadow: dark ? '0 4px 12px rgba(0, 0, 0, 0.35)' : '0 4px 12px rgba(120, 80, 0, 0.12)',
        '& .MuiTooltip-arrow::before': { borderTopColor: bg, borderRightColor: bg },
      }}
      title={
        <Box
          data-testid="prompt-cache-expiry-hint"
          role="status"
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 0.75,
            pl: 1.25,
            pr: 0.5,
            py: 0.75,
            borderRadius: '8px',
            whiteSpace: 'nowrap',
          }}
        >
          <Box
            data-testid="prompt-cache-expiry-hint-text"
            sx={{ display: 'flex', flexDirection: 'column', gap: '2px' }}
          >
            <Typography sx={{ fontSize: '12px', lineHeight: '16px', fontWeight: 600, color: 'text.primary' }}>
              Cache expired
            </Typography>
            <Typography sx={{ fontSize: '12px', lineHeight: '16px', color: 'text.tertiary' }}>
              Next message about {creditFormat.format(credits ?? 0)} credits
            </Typography>
          </Box>
          <IconButton
            data-testid="prompt-cache-expiry-hint-dismiss"
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Dismiss expired cache note"
            onClick={() => setDismissedFor(expiresAt)}
            sx={{
              '--IconButton-size': '20px',
              minHeight: 0,
              minWidth: 0,
              p: 0,
              ml: 0.25,
              mt: '-2px', // centred on the first line (16px) with its 20px box
              color: 'text.tertiary',
              // Joy paints a plain IconButton's icon in its own token, not in `color`.
              '--Icon-color': 'currentColor',
              '&:hover': { color: 'text.primary', background: 'transparent' },
              '&:focus-visible': { outline: `2px solid ${accent}`, outlineOffset: '1px' },
            }}
          >
            <CloseRoundedIcon sx={{ fontSize: '14px' }} />
          </IconButton>
        </Box>
      }
    >
      <Box ref={anchorRef} sx={{ display: 'flex' }}>
        {children}
      </Box>
    </Tooltip>
  );
};

export default PromptCacheExpiryHint;
