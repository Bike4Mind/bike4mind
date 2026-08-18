import React from 'react';
import { Tooltip, Typography, Box } from '@mui/joy';
import type { TooltipProps } from '@mui/joy';
import type { SxProps } from '@mui/joy/styles/types';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';

export interface FieldTooltipProps {
  /** Text or rich content shown inside the tooltip. */
  content: React.ReactNode;
  /** Optional label rendered to the left of the (!) icon. */
  label?: React.ReactNode;
  /** Tooltip placement (MUI Joy Tooltip placement). */
  placement?: TooltipProps['placement'];
  /** Icon size in px. */
  iconSize?: number;
  /** Color of the (!) icon. */
  iconColor?: string;
  /** Accessible label used for screen readers and the icon's aria-label. */
  ariaLabel?: string;
  /** Data test id forwarded to the trigger element. */
  'data-testid'?: string;
  /** Optional className applied to the wrapper Box. */
  className?: string;
  /** Extra styles merged into the wrapper Box (e.g. layout margins at a call site). */
  sx?: SxProps;
}

/**
 * Field-level help tooltip - a small (!) info icon that reveals contextual
 * mini-help on hover/focus without opening the full Help Center.
 *
 * Use this for passive, hover-only hints next to form fields and labels.
 * For clickable help that opens the full Help Center panel, use
 * `ContextHelpButton` (which renders a (?) icon).
 *
 * Accessibility:
 * - Trigger is a focusable element (tabIndex={0}) so keyboard users can
 *   tab to it and the tooltip will open on focus.
 * - Icon carries an aria-label, and the tooltip text itself is announced
 *   to screen readers via the underlying MUI Joy Tooltip.
 *
 * Usage:
 * ```tsx
 * <FieldTooltip
 *   label="Temperature"
 *   content="Higher values make output more random, lower values more deterministic."
 * />
 * ```
 */
const FieldTooltip: React.FC<FieldTooltipProps> = ({
  content,
  label,
  placement = 'top',
  iconSize = 14,
  iconColor,
  ariaLabel,
  'data-testid': dataTestId,
  className,
  sx,
}) => {
  const effectiveAriaLabel = ariaLabel ?? (typeof label === 'string' ? `Help: ${label}` : 'Help');
  const tooltipId = React.useId();

  const trigger = (
    <Box
      component="span"
      tabIndex={0}
      aria-label={effectiveAriaLabel}
      aria-describedby={tooltipId}
      data-testid={dataTestId ?? 'field-tooltip-trigger'}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        cursor: 'help',
        lineHeight: 0,
        borderRadius: '50%',
        outline: 'none',
        '&:focus-visible': {
          boxShadow: '0 0 0 2px var(--joy-palette-primary-500)',
        },
      }}
    >
      <InfoOutlinedIcon
        sx={{
          fontSize: iconSize,
          color: iconColor ?? 'var(--joy-palette-text-tertiary)',
          opacity: 0.6,
          '&:hover': { opacity: 1 },
        }}
      />
    </Box>
  );

  const tooltipNode = (
    <Tooltip
      id={tooltipId}
      title={content}
      placement={placement}
      arrow
      variant="soft"
      enterDelay={150}
      sx={{ maxWidth: 280 }}
    >
      {trigger}
    </Tooltip>
  );

  const hasLabel = label !== undefined;

  return (
    <Box
      component="span"
      className={className}
      sx={{ display: 'inline-flex', alignItems: 'center', gap: hasLabel ? 0.5 : 0, ...sx }}
    >
      {hasLabel &&
        (typeof label === 'string' ? (
          <Typography level="body-sm" component="span">
            {label}
          </Typography>
        ) : (
          label
        ))}
      {tooltipNode}
    </Box>
  );
};

export default FieldTooltip;
