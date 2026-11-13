import { FC, useState } from 'react';
import { Box, IconButton, Typography, useTheme } from '@mui/joy';
import { keyframes } from '@mui/system';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';

const creditFormat = new Intl.NumberFormat('en-US');

const ARROW = 8;
const GAP = 6;

const rise = keyframes`
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
`;

interface PromptCacheExpiryHintProps {
  /** What the next message pays to re-cache the chat now that the cache is gone; null hides the hint. */
  credits: number | null;
  /** When the cache expired; dismissal lasts while this stays the same. */
  expiresAt: number | null;
}

/**
 * Callout floating above the TTL chip in the composer's status line once the chat's cache has
 * expired, its arrow on the chip. The parent is the chip's wrapper (position: relative), so the
 * callout overlaps the chat instead of pushing it up and the arrow stays centred on the chip at any
 * width. Dismissal lasts until the next turn's cache expires.
 */
const PromptCacheExpiryHint: FC<PromptCacheExpiryHintProps> = ({ credits, expiresAt }) => {
  const theme = useTheme();
  const dark = theme.palette.mode === 'dark';
  const [dismissedFor, setDismissedFor] = useState<number | null>(null);
  if (credits === null || dismissedFor === expiresAt) return null;

  const bg = dark ? '#3b2a0e' : '#fdf6cf';
  const border = dark ? 'rgba(234, 179, 8, 0.45)' : 'rgba(180, 122, 6, 0.4)';
  const accent = dark ? '#f2c14e' : '#9a6b00';

  return (
    <Box
      data-testid="prompt-cache-expiry-hint"
      role="status"
      sx={{
        // Spans the chip's width at zero height, so "50%" below is the chip's centre; the bubble
        // hangs off its right end and grows leftwards.
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: `calc(100% + ${GAP + ARROW / 2}px)`,
        // Above the scroll-to-bottom button (SessionMiddle, 1100), below menus (1500).
        zIndex: 1200,
        animation: `${rise} 160ms ease-out`,
        '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
      }}
    >
      <Box
        sx={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 0.75,
          pl: 1.25,
          pr: 0.5,
          py: 0.75,
          borderRadius: '8px',
          whiteSpace: 'nowrap',
          background: bg,
          border: `1px solid ${border}`,
          boxShadow: dark ? '0 4px 12px rgba(0, 0, 0, 0.35)' : '0 4px 12px rgba(120, 80, 0, 0.12)',
        }}
      >
        <Box data-testid="prompt-cache-expiry-hint-text" sx={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <Typography sx={{ fontSize: '12px', lineHeight: '16px', fontWeight: 600, color: 'text.primary' }}>
            Cache expired
          </Typography>
          <Typography sx={{ fontSize: '12px', lineHeight: '16px', color: 'text.tertiary' }}>
            Next message about {creditFormat.format(credits)} credits
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
      {/* The arrow: a rotated square whose lower edges carry the border, upper half hidden under
          the bubble. Centred on the wrapper, i.e. the chip, whatever the bubble's width. */}
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          left: '50%',
          bottom: `-${ARROW / 2 + 1}px`,
          width: `${ARROW}px`,
          height: `${ARROW}px`,
          transform: 'translateX(-50%) rotate(45deg)',
          background: bg,
          borderRight: `1px solid ${border}`,
          borderBottom: `1px solid ${border}`,
        }}
      />
    </Box>
  );
};

export default PromptCacheExpiryHint;
