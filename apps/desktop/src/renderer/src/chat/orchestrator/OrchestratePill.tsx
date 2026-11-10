import Box from '@mui/joy/Box';
import IconButton from '@mui/joy/IconButton';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import { useMemo } from 'react';
import type { ChatModelOption } from '@shared/chat';
import type { RootPolicy } from '@shared/orchestration';
import { AgentsIcon } from '../icons';
import { OrchestrationSummary, hasUnavailableModel } from '../OrchestrationSummary';

const ON_LABEL = 'Orchestrate on: new work is split across agents';

/**
 * The session's Orchestrate behaviour: while on, the system prompt tells the assistant to split new
 * work across agents. Lives in the composer beside the approval mode because, like it, the choice
 * shapes the next turn; which surface the header shows is a separate, view-only switch.
 * Icon-only so the footer stays one quiet row; the tint alone carries the state, and the tooltip
 * carries the run policy (planner and worker models) once one exists.
 */
export function OrchestratePill({
  on,
  disabled,
  policy,
  planner,
  models,
  onChange,
}: {
  on: boolean;
  disabled?: boolean;
  policy?: RootPolicy;
  planner?: string;
  models?: readonly ChatModelOption[];
  onChange(on: boolean): void;
}) {
  const shown = on && policy && planner !== undefined && models ? { root: policy, planner, models } : null;
  // The summary is off screen until hovered, so an unavailable model needs a mark on the icon itself.
  const unavailable = useMemo(
    () =>
      on && policy && planner !== undefined && models ? hasUnavailableModel({ root: policy, planner, models }) : false,
    [on, policy, planner, models]
  );

  const title = !on ? (
    'Orchestrate: split work across agents'
  ) : shown ? (
    <Box sx={{ maxWidth: 320, py: 0.25 }}>
      <Typography level="body-sm" sx={{ fontWeight: 'md', color: 'text.primary', mb: 0.5 }}>
        {ON_LABEL}
      </Typography>
      <OrchestrationSummary {...shown} />
    </Box>
  ) : (
    ON_LABEL
  );

  return (
    <Tooltip title={title} size="sm" variant="soft" placement="top">
      <IconButton
        size="sm"
        aria-label={unavailable ? 'Orchestrate, a run policy model is unavailable' : 'Orchestrate'}
        aria-pressed={on}
        variant={on ? 'soft' : 'plain'}
        color={on ? 'primary' : 'neutral'}
        disabled={disabled}
        onClick={() => onChange(!on)}
        data-testid="composer-orchestrate-toggle"
        sx={{ flexShrink: 0, borderRadius: 'xl', position: 'relative', ...(!on && { color: 'text.tertiary' }) }}
      >
        <AgentsIcon />
        {unavailable && (
          <Box
            aria-hidden
            data-testid="composer-orchestrate-unavailable"
            sx={{
              position: 'absolute',
              top: 3,
              right: 3,
              width: 7,
              height: 7,
              borderRadius: '50%',
              bgcolor: 'warning.solidBg',
              boxShadow: '0 0 0 1.5px var(--joy-palette-background-surface)',
            }}
          />
        )}
      </IconButton>
    </Tooltip>
  );
}
