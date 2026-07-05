/**
 * IterationStep - renders one step of the ReAct loop.
 *
 * Step types: `thought`, `action`, `observation`, `final_answer`.
 * Each gets a label + icon and an indented content block. Long tool
 * observations are truncated to 2KB on the server, so we don't repeat
 * truncation here.
 */

import { FC, ReactNode, useMemo, useState } from 'react';
import { Box, Chip, Link, Typography } from '@mui/joy';
import PsychologyOutlinedIcon from '@mui/icons-material/PsychologyOutlined';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import type { IAgentStep } from '@bike4mind/common';

interface IterationStepProps {
  step: IAgentStep;
}

const STEP_META: Record<
  IAgentStep['type'],
  { label: string; color: 'neutral' | 'primary' | 'success'; icon: ReactNode }
> = {
  thought: { label: 'Thought', color: 'neutral', icon: <PsychologyOutlinedIcon fontSize="small" /> },
  action: { label: 'Action', color: 'primary', icon: <BuildOutlinedIcon fontSize="small" /> },
  observation: { label: 'Observation', color: 'neutral', icon: <VisibilityOutlinedIcon fontSize="small" /> },
  final_answer: { label: 'Final Answer', color: 'success', icon: <CheckCircleOutlineIcon fontSize="small" /> },
};

// Observations from research subagents / web search / etc. can easily exceed
// a screen. Showing the full result by default pushes the chat input below
// the fold mid-run. Preview to the first few lines and let the user expand
// inline if they want the full text. Threshold chosen so a 2-3 sentence
// observation (the common case) renders untouched.
const OBSERVATION_PREVIEW_LINES = 6;

const IterationStep: FC<IterationStepProps> = ({ step }) => {
  const meta = STEP_META[step.type];
  const toolName = step.metadata?.toolName;

  // Only observations get truncated - thought/action are typically short
  // and truncating a final_answer would defeat the point of showing it.
  const truncatable = step.type === 'observation';
  const lines = useMemo(() => (truncatable ? step.content.split('\n') : null), [truncatable, step.content]);
  const overflow = lines !== null && lines.length > OBSERVATION_PREVIEW_LINES;
  const [showFull, setShowFull] = useState(false);
  const displayed = overflow && !showFull ? lines!.slice(0, OBSERVATION_PREVIEW_LINES).join('\n') : step.content;
  const hiddenLineCount = overflow ? lines!.length - OBSERVATION_PREVIEW_LINES : 0;

  return (
    <Box
      data-testid={`iteration-step-${step.type}`}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        pl: 2,
        py: 0.75,
        borderLeft: theme => `2px solid ${theme.palette.neutral.outlinedBorder}`,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Chip size="sm" color={meta.color} startDecorator={meta.icon}>
          {meta.label}
        </Chip>
        {toolName ? (
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            {toolName}
          </Typography>
        ) : null}
      </Box>
      <Typography
        level="body-sm"
        sx={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: 'text.secondary',
        }}
      >
        {displayed}
      </Typography>
      {overflow ? (
        <Link
          component="button"
          level="body-xs"
          underline="hover"
          onClick={() => setShowFull(s => !s)}
          sx={{ alignSelf: 'flex-start', color: 'text.tertiary' }}
          data-testid={`iteration-step-${step.type}-toggle`}
        >
          {showFull
            ? 'Show less'
            : `Show full result (${hiddenLineCount} more line${hiddenLineCount === 1 ? '' : 's'})`}
        </Link>
      ) : null}
    </Box>
  );
};

export default IterationStep;
