import type { ReactNode } from 'react';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import { CloseIcon } from './icons';

/**
 * How a model knob's button looks. `compact` is the composer row with the tune tray closed: the
 * knob only shows there when it is off its default, so it is drawn as a tinted pill that says
 * "you changed this". In the open tray, and everywhere else, it stays a plain text button.
 */
export function knobButtonProps(compact: boolean) {
  return {
    size: 'sm',
    variant: compact ? 'soft' : 'plain',
    color: compact ? 'primary' : 'neutral',
    sx: compact
      ? { fontWeight: 'normal', minWidth: 0, flexShrink: 0, borderRadius: 'xl', pr: 0.5 }
      : { fontWeight: 'normal', minWidth: 0, flexShrink: 0 },
  } as const;
}

/**
 * A changed knob on the composer row: its own button, then a one-click way back to the default.
 * Two siblings rather than a button inside a button, so each one is focusable and named.
 */
export function ChangedKnob({
  children,
  resetLabel,
  onReset,
  disabled,
  testId,
}: {
  children: ReactNode;
  resetLabel: string;
  onReset: () => void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <Stack
      direction="row"
      alignItems="center"
      sx={{ flexShrink: 0, borderRadius: 'xl', bgcolor: 'primary.softBg', '& > button': { bgcolor: 'transparent' } }}
    >
      {children}
      <Tooltip title={resetLabel} size="sm" variant="soft" placement="top">
        <IconButton
          size="sm"
          variant="plain"
          color="primary"
          disabled={disabled}
          onClick={onReset}
          aria-label={resetLabel}
          data-testid={testId}
          sx={{ '--IconButton-size': '22px', borderRadius: 'xl', mr: 0.25, '& svg': { width: 10, height: 10 } }}
        >
          <CloseIcon />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}
