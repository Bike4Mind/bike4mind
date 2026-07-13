import { Box, Tooltip, Typography } from '@mui/joy';
import type { Theme } from '@mui/joy';
import { FC, useState } from 'react';

export interface SwitchSelectorOption {
  value: string;
  label?: string;
  icon?: React.ComponentType;
  tooltip?: string;
}

interface SwitchSelectorProps {
  options: SwitchSelectorOption[];
  value: string;
  onChange: (value: string) => void;
  width?: number | string;
  /**
   * 'sm' derives its geometry from the track's padding so each segment lands on an exact
   * square -- use it for icon-only switches. 'md' keeps the original hand-tuned offsets
   * that the text switches are built around; do not "fix" them.
   */
  size?: 'sm' | 'md';
}

// 'sm': a 32px track with 2px padding and a 2px gap; segments are the square that leaves
// (32 - 2px border - 2*pad = 26). 'md' keeps the legacy hand-tuned offsets.
const SM = { track: 32, pad: 2, gap: 2, border: 2 };
const SM_SEGMENT = SM.track - SM.border - 2 * SM.pad;

const SwitchSelector: FC<SwitchSelectorProps> = ({ options, value, onChange, width, size = 'md' }) => {
  const selectedIdx = options.findIndex(opt => opt.value === value);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const isSm = size === 'sm';
  const pad = isSm ? SM.pad : 4;
  const trackHeight = isSm ? SM.track : 32;
  const resolvedWidth =
    width ??
    (isSm ? SM.border + 2 * SM.pad + options.length * SM_SEGMENT + (options.length - 1) * SM.gap : 48 * options.length);
  // sm works in exact pixels (segments are squares); md keeps its percentage split.
  const segment = isSm ? `${SM_SEGMENT}px` : `calc(100% / ${options.length} - ${2 * pad}px)`;

  return (
    <Box
      // Backstop: if the pointer leaves the track without a segment's own mouseleave
      // firing (e.g. it exits across the tooltip popper), clear the hover anyway.
      onMouseLeave={() => setHoveredIdx(null)}
      sx={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        width: resolvedWidth,
        height: `${trackHeight}px`,
        padding: isSm ? `${pad}px` : 0,
        gap: isSm ? `${SM.gap}px` : 0,
        borderRadius: '6px',
        background: theme => theme.palette.common.switchSelector.background,
        border: theme => `1px solid ${theme.palette.neutral.outlinedBorder}`,
        boxShadow: 'none',
        cursor: 'pointer',
        userSelect: 'none',
        overflow: 'hidden',
      }}
    >
      {/* Sliding indicator */}
      <Box
        sx={{
          position: 'absolute',
          left: isSm
            ? `${pad + selectedIdx * (SM_SEGMENT + SM.gap)}px`
            : `calc(${pad}px + ${selectedIdx} * (100% / ${options.length}))`,
          width: segment,
          ...(isSm ? { top: `${pad}px`, bottom: `${pad}px` } : { height: '24px' }),
          borderRadius: '4px',
          background: theme => theme.palette.primary.solidBg,
          boxShadow: 'md',
          transition: 'left 0.25s cubic-bezier(0.4,0,0.2,1)',
          zIndex: 1,
        }}
      />
      {options.map(({ value: v, label, icon: Icon, tooltip }, idx) => {
        const content = (
          <Box
            key={v}
            data-testid={`view-mode-${v}`}
            onClick={() => onChange(v)}
            onMouseEnter={() => setHoveredIdx(idx)}
            onMouseLeave={() => setHoveredIdx(null)}
            sx={{
              zIndex: 2,
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'color 0.2s',
              cursor: 'pointer',
              height: '100%',
              position: 'relative',
              ...(selectedIdx !== idx && {
                // 'sm' already gets its inset from the track's padding, so the highlight
                // fills the segment; 'md' insets itself to match its legacy indicator.
                '&:hover::before': {
                  content: '""',
                  position: 'absolute',
                  inset: isSm ? 0 : '4px',
                  backgroundColor: theme => theme.palette.notebooklist.hoverBg,
                  borderRadius: '4px',
                  zIndex: -1,
                },
              }),
            }}
          >
            {Icon ? (
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  // Joy icons read --Icon-color/--Icon-fontSize; a plain `color` is outranked.
                  '--Icon-fontSize': '16px',
                  '--Icon-color':
                    selectedIdx === idx
                      ? 'white'
                      : (theme: Theme) => theme.palette.common.switchSelector.lightTextColor,
                }}
              >
                <Icon />
              </Box>
            ) : (
              <Typography
                sx={{
                  color: selectedIdx === idx ? 'white' : theme => theme.palette.common.switchSelector.lightTextColor,
                  fontSize: '12px',
                  fontWeight: selectedIdx === idx ? 500 : 400,
                  lineHeight: '150%',
                }}
              >
                {label}
              </Typography>
            )}
          </Box>
        );
        return tooltip ? (
          // Open state is driven by our own hover tracking rather than the Tooltip's: only
          // one segment can be hovered at a time, so sliding from one to the next closes the
          // previous tooltip instead of leaving it stranded over the switch.
          <Tooltip
            key={v}
            title={tooltip}
            placement="top"
            open={hoveredIdx === idx}
            disableHoverListener
            disableFocusListener
            disableTouchListener
            // The popup overlaps the track, so it must never swallow pointer events --
            // otherwise the segment under it stops seeing enter/leave and the tooltip
            // it belongs to never closes.
            sx={{ pointerEvents: 'none' }}
          >
            {content}
          </Tooltip>
        ) : (
          content
        );
      })}
    </Box>
  );
};

export default SwitchSelector;
