import React from 'react';
import { Box, Tooltip, Typography } from '@mui/joy';
import AttachMoneyIcon from '@mui/icons-material/AttachMoney';
import ConstructionIcon from '@mui/icons-material/Construction';
import SpeedIcon from '@mui/icons-material/Speed';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import type { ModelInfo } from '@bike4mind/common';
// Named for tools, but this is the thinking glyph: ToolsSection renders it on the Thinking
// row and ToolIndicators uses it as tool-indicator-thinking.
import SupportsToolsIcon from '@client/app/components/svgs/SupportsToolsIcon';
import {
  ChipVariant,
  getModelSpeedTooltip,
  getModelSpeedVariant,
  getPriceTierTooltip,
} from '@client/app/utils/aiSettingsUtils';
import { green, orange, red } from '@client/app/utils/themes/colors';

// Shared by the model list cards and the per-model settings dialog, so the two surfaces
// cannot drift apart on glyph, colour or tooltip wording.

export type ModelSpeed = 'fast' | 'medium' | 'slow';

export const formatNumber = (num: number): string => num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * Compact form for scanning, e.g. "200K".
 *
 * Truncates rather than rounds, because these values are caps: rounding up told users they
 * had headroom they did not have (32,768 read as "33K", 65,535 as "66K"). Understating a
 * limit is safe, overstating it is not. Most catalog values are powers of two, so some
 * precision loss is unavoidable at this length - the exact figure lives in the tooltip.
 */
export const formatContextWindow = (size: number): string => {
  if (size >= 1000000) {
    // Truncate to one decimal: floor at 100k granularity, then shift.
    return `${(Math.floor(size / 100000) / 10).toFixed(1)}M`;
  } else if (size >= 1000) {
    return `${Math.floor(size / 1000)}K`;
  }
  return formatNumber(size);
};

// Cost and speed render as icon-only chips in a neutral frame, so the glyph says which
// dimension and its colour says the value. Reuses the existing tier/speed variants as the
// scale rather than a second set of thresholds.
export const metricIconColor = (variant: ChipVariant): string =>
  variant === 'green' ? green[800] : variant === 'yellow' ? orange[450] : red[400];

// Same purple the New chip used before it became a badge. No theme token exists for it;
// getChipStyles hardcodes the identical value for its `purple` variant.
export const NEW_BADGE_BG = '#A52ECD';

// Marks a model as AWS Bedrock-hosted. Deliberately separate from the provider logos, which
// are keyed by who authored the model - any provider's model can be Bedrock-hosted, so it is
// a different axis. Amazon Bedrock's own teal, so it reads as the platform rather than as
// another status colour.
export const BEDROCK_BADGE_BG = '#01A88D';

// Small label. Positioning lives at the call site so multiple badges line up; this only
// draws the pill.
export const CornerBadge = ({
  testId,
  label,
  tooltip,
  background,
}: {
  testId: string;
  label: string;
  tooltip: string;
  background: string;
}) => (
  <Tooltip title={tooltip} placement="top">
    <Box
      data-testid={testId}
      sx={{
        display: 'flex',
        alignItems: 'center',
        height: '20px',
        px: '6px',
        borderRadius: '4px',
        backgroundColor: background,
        color: '#FFFFFF',
        fontSize: '12px',
        fontWeight: 600,
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </Box>
  </Tooltip>
);

/** Frame diameter in px. The cards use the default; the settings dialog runs larger. */
const DEFAULT_INDICATOR_SIZE = 24;

// Glyphs scale with the frame so the fill ratio holds at any size. These factors reproduce
// the original 16px/18px glyphs inside a 24px frame exactly.
const glyphPx = (size: number) => `${Math.round((size * 2) / 3)}px`;
const thinkingGlyphPx = (size: number) => Math.round(size * 0.75);

// One frame definition behind both the round icons and the text pills, so a row mixing them
// reads as a single set rather than two visual grammars.
const frameSx = (size: number, filled: boolean) => ({
  display: 'inline-flex',
  alignItems: 'center',
  height: `${size}px`,
  flex: 'none',
  boxSizing: 'border-box' as const,
  border: 'var(--joy-palette-aiSettings-modelCard-border)',
  ...(filled && { backgroundColor: 'var(--joy-palette-aiSettings-modelCard-background)' }),
});

// Read-only indicator. The frame is what separates these from the star and settings icons
// sitting beside them on a card - without it, informational glyphs read as pressable.
export const MetricIcon = ({
  label,
  tooltip,
  size = DEFAULT_INDICATOR_SIZE,
  filled = false,
  children,
}: {
  label: string;
  tooltip: string;
  size?: number;
  /** Fills the frame with the model-card surface. Off on a card, where it would be invisible. */
  filled?: boolean;
  children: React.ReactNode;
}) => (
  <Tooltip title={tooltip} placement="top">
    <Box
      role="img"
      aria-label={label}
      sx={{
        ...frameSx(size, filled),
        justifyContent: 'center',
        width: `${size}px`,
        borderRadius: '50%',
      }}
    >
      {children}
    </Box>
  </Tooltip>
);

/**
 * A read-only spec as a pill: short inline label plus its value. Shares the icon frame's
 * height, border and fill, so specs and capabilities sit in one row as one set. The label is
 * abbreviated to fit inline - the tooltip carries the full phrasing.
 */
export const SpecPill: React.FC<{
  label: string;
  value: string;
  tooltip: string;
  size?: number;
  filled?: boolean;
}> = ({ label, value, tooltip, size = DEFAULT_INDICATOR_SIZE, filled = false }) => (
  <Tooltip title={tooltip} placement="top">
    <Box
      sx={{
        ...frameSx(size, filled),
        gap: '4px',
        px: '12px',
        borderRadius: `${size / 2}px`,
        whiteSpace: 'nowrap',
      }}
    >
      <Typography sx={{ color: 'text.primary50', fontSize: '12px', lineHeight: 1 }}>{label}</Typography>
      <Typography sx={{ color: 'text.primary', fontSize: '12px', fontWeight: 500, lineHeight: 1 }}>{value}</Typography>
    </Box>
  </Tooltip>
);

/** Cost and speed: always-present dimensions whose colour carries the value. */
export const MetricIndicators: React.FC<{
  priceTier: { tier: string; variant: ChipVariant };
  modelSpeed: ModelSpeed | null;
  statsLoading: boolean;
  size?: number;
  filled?: boolean;
}> = ({ priceTier, modelSpeed, statsLoading, size = DEFAULT_INDICATOR_SIZE, filled = false }) => (
  <>
    <MetricIcon
      label={`${priceTier.tier} cost`}
      tooltip={getPriceTierTooltip(priceTier.tier)}
      size={size}
      filled={filled}
    >
      <AttachMoneyIcon
        sx={{
          fontSize: glyphPx(size),
          color: metricIconColor(priceTier.variant),
          // The $ glyph is drawn 0.59 units left of centre inside its own 24-unit viewBox
          // (ink spans x 6.32..16.50), so centring the <svg> still leaves it visibly left in a
          // round frame. Divided by 24 in em so it tracks fontSize. Speed and the capability
          // glyphs measure centred and are deliberately left alone.
          transform: 'translateX(calc(0.59em / 24))',
        }}
      />
    </MetricIcon>

    {!statsLoading && modelSpeed && (
      <MetricIcon
        label={`${modelSpeed.charAt(0).toUpperCase() + modelSpeed.slice(1)} speed`}
        tooltip={getModelSpeedTooltip(modelSpeed)}
        size={size}
        filled={filled}
      >
        <SpeedIcon sx={{ fontSize: glyphPx(size), color: metricIconColor(getModelSpeedVariant(modelSpeed)) }} />
      </MetricIcon>
    )}
  </>
);

/**
 * Vision / thinking / tools. Present-or-absent, so they stay neutral: no colour to imply a
 * scale that doesn't exist. Absence of the icon is the "no" state.
 */
export const CapabilityIndicators: React.FC<{ model: ModelInfo; size?: number; filled?: boolean }> = ({
  model,
  size = DEFAULT_INDICATOR_SIZE,
  filled = false,
}) => (
  <>
    {model.supportsVision && (
      <MetricIcon label="Vision" tooltip="Able to understand images" size={size} filled={filled}>
        <VisibilityOutlinedIcon sx={{ fontSize: glyphPx(size), color: 'text.tertiary' }} />
      </MetricIcon>
    )}

    {model.can_think && (
      <MetricIcon label="Thinking" tooltip="Reasons step-by-step before responding" size={size} filled={filled}>
        {/* Runs larger than the MUI glyphs: this one carries far more detail, so it needs the
            extra couple of px to stay legible. */}
        <SupportsToolsIcon
          width={thinkingGlyphPx(size)}
          height={thinkingGlyphPx(size)}
          fill="var(--joy-palette-text-tertiary)"
        />
      </MetricIcon>
    )}

    {model.supportsTools && (
      <MetricIcon label="Tools" tooltip="Able to use a growing list of tools" size={size} filled={filled}>
        <ConstructionIcon sx={{ fontSize: glyphPx(size), color: 'text.tertiary' }} />
      </MetricIcon>
    )}
  </>
);
