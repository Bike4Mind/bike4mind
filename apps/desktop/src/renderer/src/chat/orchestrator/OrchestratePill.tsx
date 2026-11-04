import Button from '@mui/joy/Button';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import { AgentsIcon } from '../icons';

/**
 * The session's Orchestrate behaviour: while on, the system prompt tells the assistant to split new
 * work across agents. Lives in the composer beside the approval mode because, like it, the choice
 * shapes the next turn; which surface the header shows is a separate, view-only switch.
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
      title={on ? 'Orchestrate is on: new work is split across agents' : 'Split work across agents and coordinate them'}
      size="sm"
      variant="soft"
      placement="top"
    >
      <Button
        size="sm"
        aria-pressed={on}
        variant={on ? 'soft' : 'plain'}
        color={on ? 'primary' : 'neutral'}
        disabled={disabled}
        startDecorator={<AgentsIcon />}
        onClick={() => onChange(!on)}
        data-testid="composer-orchestrate-toggle"
        // One short word, so it keeps its width while the model and effort labels ellipsize instead.
        sx={{ fontWeight: 'normal', flexShrink: 0, borderRadius: 'xl', gap: 0.75 }}
      >
        <Typography level="body-xs" noWrap textColor="inherit">
          Orchestrate
        </Typography>
      </Button>
    </Tooltip>
  );
}
