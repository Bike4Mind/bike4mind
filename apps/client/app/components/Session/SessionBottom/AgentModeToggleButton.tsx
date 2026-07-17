import { FC } from 'react';
import { IconButton, Tooltip } from '@mui/joy';
import BoltIcon from '@mui/icons-material/Bolt';
import { useLLM } from '@client/app/contexts/LLMContext';

interface AgentModeToggleButtonProps {
  disabled?: boolean;
}

/**
 * Composer toggle for Agent mode.
 *
 * Rendered conditionally by `SessionToolbar` only when the Layer-1 gate
 * resolves true via `useFeatureEnabled('agentMode')` (admin `EnableAgentMode`
 * plus per-user pref / admin default). The button is the only client surface
 * that drives `agentMode.enabled` for non-classifier flows; its solid/primary
 * variant is the sole in-composer indicator of the active state.
 *
 * Styling mirrors `RephraseButton` / `VoiceRecordButton` for visual parity
 * across the composer row.
 */
export const AgentModeToggleButton: FC<AgentModeToggleButtonProps> = ({ disabled = false }) => {
  const agentMode = useLLM(s => s.agentMode);
  const setLLM = useLLM(s => s.setLLM);

  const handleToggle = () => {
    setLLM({
      agentMode: {
        enabled: !agentMode.enabled,
        // Provenance: distinguishes manual toggle from classifier-driven
        // routing. Always 'toggle' for this entry point.
        source: 'toggle',
      },
    });
  };

  const tooltip = agentMode.enabled
    ? 'Agent mode ON — multi-step reasoning + tools (higher token usage)'
    : 'Use multi-step reasoning + tools. Higher token usage.';

  return (
    <Tooltip title={tooltip} placement="top">
      <IconButton
        size="sm"
        variant={agentMode.enabled ? 'solid' : 'outlined'}
        color={agentMode.enabled ? 'primary' : 'neutral'}
        onClick={handleToggle}
        disabled={disabled}
        aria-pressed={agentMode.enabled}
        aria-label={agentMode.enabled ? 'Disable Agent mode' : 'Enable Agent mode'}
        data-testid="agent-mode-toggle-btn"
        sx={{
          width: '32px',
          height: '32px',
          borderRadius: '6px',
        }}
      >
        <BoltIcon sx={{ fontSize: 16 }} />
      </IconButton>
    </Tooltip>
  );
};

export default AgentModeToggleButton;
