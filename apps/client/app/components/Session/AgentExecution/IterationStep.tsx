/**
 * IterationStep - renders one step of the ReAct loop.
 *
 * Step types: `thought`, `action`, `observation`, `final_answer`.
 * Each gets a label + icon and an indented content block. Long tool
 * observations are truncated to 2KB on the server, so we don't repeat
 * truncation here.
 *
 * Tool-error observations get a distinct treatment (see ErrorObservation):
 * when the run recovered from the error (retried and continued), the error is
 * shown softly and collapsed so a successful run doesn't read as broken; when
 * the run actually failed, it stays expanded and danger-toned.
 */

import { FC, ReactNode, useMemo, useState } from 'react';
import { Box, Chip, Link, Typography } from '@mui/joy';
import PsychologyOutlinedIcon from '@mui/icons-material/PsychologyOutlined';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ReplayOutlinedIcon from '@mui/icons-material/ReplayOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import type { IAgentStep } from '@bike4mind/common';

interface IterationStepProps {
  step: IAgentStep;
  /**
   * Whether the run recovered from an error at this step. Only meaningful for a
   * tool-error observation: `true` (default) presents it as a soft, collapsed
   * "retried" note; `false` (the run failed on it) keeps it expanded and
   * danger-toned. Passed down from the stream, which knows the run's status.
   */
  recovered?: boolean;
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

// A failed tool call surfaces as an observation whose content the server
// prefixes with "Error: " (ReActAgent.observationForResult). Aborts/cancels
// use a different placeholder, so this only matches genuine tool errors.
export function isErrorObservation(step: IAgentStep): boolean {
  return step.type === 'observation' && /^\s*Error:/.test(step.content);
}

const IterationStep: FC<IterationStepProps> = ({ step, recovered = true }) => {
  const toolName = step.metadata?.toolName;

  // Tool errors the agent recovered from (or that the run ultimately survived)
  // shouldn't read as a broken run. Give them their own softened render.
  // Branch here (no hooks in this dispatcher) so each render path keeps a
  // stable, unconditional hook order.
  if (isErrorObservation(step)) {
    return <ErrorObservation step={step} toolName={toolName} recovered={recovered} />;
  }
  return <StandardStep step={step} toolName={toolName} />;
};

const StandardStep: FC<{ step: IAgentStep; toolName?: string }> = ({ step, toolName }) => {
  const meta = STEP_META[step.type];

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
        gap: 1.5, // 12px between icon and text
        alignItems: 'flex-start',
        pl: 2,
        py: 0.75,
        borderLeft: theme => `2px solid ${theme.palette.neutral.outlinedBorder}`,
      }}
    >
      {/* Icon on the left, colored by step type. */}
      <Box sx={{ display: 'flex', flexShrink: 0, mt: '12px', color: `${meta.color}.500` }}>{meta.icon}</Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, minWidth: 0, flex: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Typography level="body-sm" sx={{ fontWeight: 600, color: 'text.primary' }}>
            {meta.label}
          </Typography>
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
            color: 'text.tertiary',
          }}
        >
          {displayed}
        </Typography>
        {overflow ? (
          <Link
            component="button"
            level="body-xs"
            underline="always"
            onClick={() => setShowFull(s => !s)}
            // Match the primary (Send) button blue at rest and its darker hover
            // blue on hover, not Joy's lighter plainColor.
            sx={{
              alignSelf: 'flex-start',
              mt: 2,
              fontSize: '14px',
              transition: 'color 0.15s ease',
              '--variant-plainColor': 'var(--joy-palette-primary-solidBg)',
              '&:hover': { '--variant-plainColor': 'var(--joy-palette-primary-solidHoverBg)' },
            }}
            data-testid={`iteration-step-${step.type}-toggle`}
          >
            {showFull
              ? 'Show less'
              : `Show full result (${hiddenLineCount} more line${hiddenLineCount === 1 ? '' : 's'})`}
          </Link>
        ) : null}
      </Box>
    </Box>
  );
};

/**
 * A tool-error observation. Recovered errors (the run retried/continued) read as
 * a calm, collapsed "retried" note in warning tone - honest but not alarming,
 * so a completed run doesn't look broken. A fatal error (the run failed on it)
 * stays expanded in danger tone.
 */
const ErrorObservation: FC<{ step: IAgentStep; toolName?: string; recovered: boolean }> = ({
  step,
  toolName,
  recovered,
}) => {
  // Recovered errors start collapsed (detail on demand); fatal errors start open.
  const [open, setOpen] = useState(!recovered);
  const tone = recovered ? 'warning' : 'danger';

  return (
    <Box
      data-testid="iteration-step-observation"
      data-error-tone={recovered ? 'recovered' : 'fatal'}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        pl: 2,
        py: 0.75,
        borderLeft: theme => `2px solid ${theme.palette[tone].outlinedBorder}`,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Chip
          size="sm"
          color={tone}
          variant="soft"
          startDecorator={recovered ? <ReplayOutlinedIcon fontSize="small" /> : <ErrorOutlineIcon fontSize="small" />}
        >
          {recovered ? 'Retried' : 'Tool error'}
        </Chip>
        {toolName ? (
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            {toolName}
          </Typography>
        ) : null}
      </Box>

      {recovered && !open ? (
        <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
          The agent hit a tool error here and retried.{' '}
          <Link
            component="button"
            level="body-sm"
            underline="hover"
            onClick={() => setOpen(true)}
            data-testid="iteration-step-observation-toggle"
          >
            Show detail
          </Link>
        </Typography>
      ) : (
        <>
          <Typography
            level="body-sm"
            sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: `${tone}.plainColor` }}
          >
            {step.content}
          </Typography>
          {recovered ? (
            <Link
              component="button"
              level="body-xs"
              underline="hover"
              onClick={() => setOpen(false)}
              sx={{ alignSelf: 'flex-start', color: 'text.tertiary' }}
              data-testid="iteration-step-observation-toggle"
            >
              Hide detail
            </Link>
          ) : null}
        </>
      )}
    </Box>
  );
};

export default IterationStep;
