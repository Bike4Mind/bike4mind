import { FC } from 'react';
import { Chip, Tooltip } from '@mui/joy';
import BoltIcon from '@mui/icons-material/Bolt';
import { useLLM } from '@client/app/contexts/LLMContext';

/**
 * Status chip rendered next to the send button when `agentMode.enabled` is
 * true. Mirrors the visual treatment of `ResearchModeIndicator` so
 * the composer's "this send will behave differently" cue is consistent across
 * features. Renders nothing when agent mode is off.
 */
export const AgentModeChip: FC = () => {
  const agentMode = useLLM(s => s.agentMode);

  if (!agentMode.enabled) return null;

  return (
    <Tooltip title="Agent mode active — multi-step reasoning + tools (higher token usage)" placement="top">
      <Chip
        variant="soft"
        color="primary"
        size="sm"
        startDecorator={<BoltIcon sx={{ fontSize: '16px' }} />}
        data-testid="agent-mode-chip"
        sx={{
          borderRadius: '16px',
          px: 1.5,
          py: 0.5,
          fontSize: '13px',
          fontWeight: 500,
        }}
      >
        Agent mode
      </Chip>
    </Tooltip>
  );
};

export default AgentModeChip;
