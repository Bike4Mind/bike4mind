import IconButton from '@mui/joy/IconButton';
import Tooltip from '@mui/joy/Tooltip';
import { AgentsIcon } from '../icons';

/**
 * The session's Orchestrate behaviour: while on, the system prompt tells the assistant to split new
 * work across agents. Lives in the composer beside the approval mode because, like it, the choice
 * shapes the next turn; which surface the header shows is a separate, view-only switch.
 * Icon-only so the footer stays one quiet row; the tint alone carries the state.
 */
export function OrchestratePill({
  on,
  disabled,
  onChange,
}: {
  on: boolean;
  disabled?: boolean;
  onChange(on: boolean): void;
}) {
  return (
    <Tooltip
      title={on ? 'Orchestrate on: new work is split across agents' : 'Orchestrate: split work across agents'}
      size="sm"
      variant="soft"
      placement="top"
    >
      <IconButton
        size="sm"
        aria-label="Orchestrate"
        aria-pressed={on}
        variant={on ? 'soft' : 'plain'}
        color={on ? 'primary' : 'neutral'}
        disabled={disabled}
        onClick={() => onChange(!on)}
        data-testid="composer-orchestrate-toggle"
        sx={{ flexShrink: 0, borderRadius: 'xl', ...(!on && { color: 'text.tertiary' }) }}
      >
        <AgentsIcon />
      </IconButton>
    </Tooltip>
  );
}
