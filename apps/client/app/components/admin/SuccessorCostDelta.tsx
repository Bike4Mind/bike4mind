import React from 'react';
import { Box, Chip, Stack, Typography } from '@mui/joy';
import type { ColorPaletteProp } from '@mui/joy/styles';
import {
  formatPctChange,
  formatPerMTok,
  successorCostDelta,
  type PerMTokRate,
  type RateChange,
  type SuccessorCostVerdict,
} from '@bike4mind/common';

/**
 * What replacing `modelId` with `successorId` costs. A successor that raises a
 * bill needs a deliberate admin decision, and the number has to be on screen
 * for that decision to mean anything.
 */
export interface SuccessorCostProps {
  modelId: string;
  successorId?: string;
  rates: Readonly<Record<string, PerMTokRate>>;
}

const VERDICT_COLOR: Record<SuccessorCostVerdict, ColorPaletteProp> = {
  'cheaper-or-equal': 'success',
  'more-expensive': 'danger',
  // Unpriced is a work item, not a pass: the automation refuses this case too.
  unverifiable: 'warning',
};

const VERDICT_LABEL: Record<SuccessorCostVerdict, string> = {
  'cheaper-or-equal': 'no cost increase',
  'more-expensive': 'costs more',
  unverifiable: 'no price on file',
};

/**
 * The move the verdict is about: the steepest rise when the successor costs
 * more, the deepest saving when it does not. Taking the larger signed move in
 * both directions would headline a 67% input cut with a flat output as
 * 'no change', which is the ordinary shape of a provider's next model.
 */
const headlineChange = (input: RateChange, output: RateChange, verdict: SuccessorCostVerdict): RateChange => {
  const inputPct = input.pctChange ?? Infinity;
  const outputPct = output.pctChange ?? Infinity;
  return verdict === 'cheaper-or-equal'
    ? outputPct < inputPct
      ? output
      : input
    : outputPct > inputPct
      ? output
      : input;
};

/** Compact form for a table cell. */
export const SuccessorCostChip: React.FC<SuccessorCostProps> = ({ modelId, successorId, rates }) => {
  if (!successorId) return null;
  const delta = successorCostDelta(modelId, successorId, rates);
  const summary =
    delta.input && delta.output
      ? `${VERDICT_LABEL[delta.verdict]} ${formatPctChange(headlineChange(delta.input, delta.output, delta.verdict).pctChange)}`
      : VERDICT_LABEL[delta.verdict];

  return (
    <Chip size="sm" variant="soft" color={VERDICT_COLOR[delta.verdict]} data-testid={`successor-cost-chip-${modelId}`}>
      {summary}
    </Chip>
  );
};

const RateRow: React.FC<{ label: string; change: RateChange }> = ({ label, change }) => (
  <Stack direction="row" spacing={1} justifyContent="space-between">
    <Typography level="body-xs">{label}</Typography>
    <Typography level="body-xs">
      {formatPerMTok(change.from)} to {formatPerMTok(change.to)} / MTok ({formatPctChange(change.pctChange)})
    </Typography>
  </Stack>
);

/** Full form for the accept modal: both rates, both percentages, and the verdict. */
export const SuccessorCostPanel: React.FC<SuccessorCostProps> = ({ modelId, successorId, rates }) => {
  if (!successorId) return null;
  const delta = successorCostDelta(modelId, successorId, rates);

  return (
    <Box sx={{ mt: 1, p: 1, borderRadius: 'sm', bgcolor: 'background.level1' }} data-testid="successor-cost-panel">
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <Chip size="sm" variant="soft" color={VERDICT_COLOR[delta.verdict]}>
          {VERDICT_LABEL[delta.verdict]}
        </Chip>
        <Typography level="body-xs" color="neutral">
          {modelId} to {successorId}
        </Typography>
      </Stack>
      {delta.input && delta.output ? (
        <Stack spacing={0.25}>
          <RateRow label="Input" change={delta.input} />
          <RateRow label="Output" change={delta.output} />
        </Stack>
      ) : (
        <Typography level="body-xs" color="neutral">
          One of the two models has no price row in force, so the cost effect of this mapping cannot be checked.
        </Typography>
      )}
    </Box>
  );
};
