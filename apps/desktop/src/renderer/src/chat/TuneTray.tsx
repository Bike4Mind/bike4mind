import { useId, useState, type ReactNode } from 'react';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import { keyframes } from '@mui/system';
import { SlidersIcon } from './icons';

const slideIn = keyframes({
  from: { opacity: 0, transform: 'translateX(6px)' },
  to: { opacity: 1, transform: 'none' },
});

/**
 * The model's rarely-changed knobs (effort, params, cache) behind one sliders button, so the
 * composer row says only what differs from the defaults.
 *
 * Closed, `children(true)` renders each knob in its compact form: nothing at its default, a
 * resettable chip when changed. Open, `children(false)` lays every knob out in a tray that slides
 * out beside the button. The tray opens in place rather than as a popover because each knob
 * already owns a menu or panel, and a popover holding popovers closes under its own clicks.
 */
export function TuneTray({
  disabled,
  trailing,
  children,
}: {
  disabled?: boolean;
  /** Kept on one line with the sliders button (the model picker), so the two never wrap apart. */
  trailing?: ReactNode;
  children: (compact: boolean) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trayId = useId();
  const label = open ? 'Hide model settings' : 'Model settings';

  return (
    <>
      <Stack
        id={trayId}
        direction="row"
        alignItems="center"
        justifyContent="flex-end"
        flexWrap="wrap"
        data-testid="composer-tune-tray"
        data-open={open}
        sx={{
          minWidth: 0,
          gap: 0.5,
          '&:empty': { display: 'none' },
          ...(open && {
            px: 0.5,
            borderRadius: 'xl',
            bgcolor: 'background.level1',
            animation: `${slideIn} 140ms ease-out`,
            '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
            '&:empty': {
              display: 'flex',
              px: 1.25,
              py: 0.5,
              '&::before': {
                content: '"Nothing to tune for this model"',
                fontSize: 'var(--joy-fontSize-xs)',
                color: 'var(--joy-palette-text-tertiary)',
              },
            },
          }),
        }}
      >
        {children(!open)}
      </Stack>
      <Stack direction="row" alignItems="center" sx={{ flexShrink: 0, gap: 0.5 }}>
        <Tooltip title={label} size="sm" variant="soft" placement="top">
          <IconButton
            size="sm"
            variant={open ? 'soft' : 'plain'}
            color={open ? 'primary' : 'neutral'}
            disabled={disabled}
            onClick={() => setOpen(value => !value)}
            aria-label={label}
            aria-expanded={open}
            aria-controls={trayId}
            data-testid="composer-tune-btn"
            sx={{ flexShrink: 0, borderRadius: 'xl', color: open ? undefined : 'text.tertiary' }}
          >
            <SlidersIcon />
          </IconButton>
        </Tooltip>
        {trailing}
      </Stack>
    </>
  );
}
