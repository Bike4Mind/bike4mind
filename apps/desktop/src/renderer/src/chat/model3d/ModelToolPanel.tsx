import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Slider from '@mui/joy/Slider';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { KeyboardEvent } from 'react';
import type * as THREE from 'three';
import { CloseIcon } from '../icons';
import type { ModelTool } from './inspection';
import { formatLength, measureResult } from './measure';
import { flipped, SECTION_AXES, withAxis, withOffset, type SectionState } from './section';

type Props = {
  tool: ModelTool;
  section: SectionState;
  onSectionChange: (section: SectionState) => void;
  /** The measure tool's picked points, none to two. */
  measurePoints: readonly THREE.Vector3[];
  units: string;
  onClose: () => void;
};

/** What the measure tool says now: what to click next, or the distance and its run on each axis. */
export function measureReadout(points: readonly THREE.Vector3[], units: string): string {
  const result = measureResult(points);
  if (!result) return points.length ? 'Click a second point' : 'Click a point on the model';
  const [dx, dy, dz] = result.delta.map(formatLength);
  return `${formatLength(result.distance)} ${units} (x ${dx}, y ${dy}, z ${dz})`;
}

/** The measure or section tool's controls, over the bottom right of the 3D view, above its size caption. */
export function ModelToolPanel({ tool, section, onSectionChange, measurePoints, units, onClose }: Props) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1}
      role="group"
      aria-label={tool === 'measure' ? 'Measure' : 'Section'}
      onKeyDown={onKeyDown}
      data-testid={`model-pane-${tool}-panel`}
      sx={{
        position: 'absolute',
        right: 8,
        bottom: 40,
        maxWidth: 'calc(100% - 16px)',
        pl: 1.25,
        pr: 0.375,
        py: 0.375,
        borderRadius: 'md',
        bgcolor: 'color-mix(in srgb, var(--joy-palette-background-surface) 88%, transparent)',
        backdropFilter: 'blur(10px) saturate(1.4)',
        boxShadow: 'sm',
        border: '1px solid',
        borderColor: 'divider',
      }}
    >
      {tool === 'measure' ? (
        <Typography
          level="body-sm"
          aria-live="polite"
          sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
          data-testid="model-pane-measure-readout"
        >
          {measureReadout(measurePoints, units)}
        </Typography>
      ) : (
        <>
          <Stack direction="row" spacing={0.25} role="radiogroup" aria-label="Section axis">
            {SECTION_AXES.map(axis => (
              <Button
                key={axis}
                size="sm"
                role="radio"
                aria-checked={section.axis === axis}
                variant={section.axis === axis ? 'solid' : 'plain'}
                color={section.axis === axis ? 'primary' : 'neutral'}
                onClick={() => onSectionChange(withAxis(section, axis))}
                sx={{ minWidth: 30, px: 1 }}
                data-testid={`model-pane-section-axis-${axis}`}
              >
                {axis.toUpperCase()}
              </Button>
            ))}
          </Stack>
          <Slider
            size="sm"
            min={0}
            max={100}
            step={1}
            value={Math.round(section.offset * 100)}
            onChange={(_event, value) => onSectionChange(withOffset(section, (value as number) / 100))}
            aria-label="Section offset"
            sx={{ width: 120, mx: 0.5 }}
            slotProps={{ input: { 'data-testid': 'model-pane-section-offset' } as Record<string, string> }}
          />
          <Button
            size="sm"
            variant={section.flipped ? 'soft' : 'plain'}
            color="neutral"
            aria-pressed={section.flipped}
            onClick={() => onSectionChange(flipped(section))}
            data-testid="model-pane-section-flip"
          >
            Flip
          </Button>
        </>
      )}
      <Tooltip title="Done (Esc)" size="sm" placement="top" variant="solid">
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label={tool === 'measure' ? 'Stop measuring' : 'Remove section'}
          onClick={onClose}
          data-testid="model-pane-tool-close"
        >
          <CloseIcon />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}
