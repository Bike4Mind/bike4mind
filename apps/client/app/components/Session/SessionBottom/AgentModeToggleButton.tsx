import { FC } from 'react';
import { IconButton, Tooltip } from '@mui/joy';
import BoltIcon from '@mui/icons-material/Bolt';
import { useLLM } from '@client/app/contexts/LLMContext';
import { green, greenAlpha } from '@client/app/utils/themes/colors';

interface AgentModeToggleButtonProps {
  disabled?: boolean;
}

/**
 * Composer toggle for Agent mode.
 *
 * Rendered conditionally by `SessionToolbar` only when the Layer-1 gate
 * resolves true via `useFeatureEnabled('agentMode')` (admin `EnableAgentMode`
 * plus per-user pref / admin default). The button is the only client surface
 * that drives `agentMode.enabled` for non-classifier flows; the active state is
 * the sole in-composer indicator, shown as a green frame (green border + 10%
 * green fill) matching the tools-count badge (see `CountBadge`) rather than the
 * blue `primary` reserved for the Send button.
 *
 * Base styling (size, radius) mirrors `RephraseButton` / `VoiceRecordButton`
 * for visual parity across the composer row.
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
    ? 'Agent Mode ON - multi-step reasoning and tools (higher token usage)'
    : 'Enable Agent Mode - multi-step reasoning and tools (higher token usage)';

  return (
    <Tooltip title={tooltip} placement="top">
      <IconButton
        size="sm"
        variant="outlined"
        color="neutral"
        onClick={handleToggle}
        disabled={disabled}
        aria-pressed={agentMode.enabled}
        aria-label={agentMode.enabled ? 'Disable Agent mode' : 'Enable Agent mode'}
        data-testid="agent-mode-toggle-btn"
        sx={{
          width: '32px',
          height: '32px',
          borderRadius: '6px',
          // Active state: green frame matching the tools-count badge (CountBadge),
          // keeping blue reserved for Send. Joy drives the outlined
          // background/border through --variant-* CSS vars, so a plain
          // backgroundColor in sx is ignored - set the vars directly (this is
          // what makes the fill actually turn green instead of keeping the
          // neutral gray that read as a stuck hover). Fill uses the documented
          // Joy drives the outlined fill/border through --variant-* CSS vars, so
          // a plain backgroundColor in sx is ignored - set the vars directly.
          // Fill is greenAlpha[800] 10% to match the tools-count badge; hover and
          // active are pinned to the same value so the state stays stable (and
          // does not fall back to the neutral gray hover fill).
          ...(agentMode.enabled && {
            '--variant-outlinedColor': green[800],
            '--variant-outlinedBorder': `${green[800]}BF`, // BF = 75%
            '--variant-outlinedHoverBorder': `${green[800]}BF`,
            '--variant-outlinedBg': greenAlpha[800][10],
            '--variant-outlinedHoverBg': greenAlpha[800][10],
            '--variant-outlinedActiveBg': greenAlpha[800][10],
          }),
        }}
      >
        <BoltIcon sx={{ fontSize: 16 }} />
      </IconButton>
    </Tooltip>
  );
};

export default AgentModeToggleButton;
