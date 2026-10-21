import { FC, useMemo } from 'react';
import { Button, Tooltip } from '@mui/joy';
import ScienceIcon from '@mui/icons-material/ScienceOutlined';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useAdvancedAISettings } from './useAdvancedAISettingsStore';
import { isImageModel } from '@client/app/utils/commands';
import { orange } from '@client/app/utils/themes/colors';
import {
  STATUS_ITEM_HEIGHT,
  useStatusLineCompact,
} from '@client/app/components/Session/SessionBottom/ComposerStatusLine';

const ResearchModeIndicator: FC = () => {
  const researchMode = useLLM(state => state.researchMode);
  const model = useLLM(state => state.model);
  const openModal = useAdvancedAISettings(s => s.openModal);
  const compact = useStatusLineCompact();

  const enabledCount = useMemo(
    () => researchMode?.configurations?.filter(c => c.enabled).length ?? 0,
    [researchMode?.configurations]
  );

  if (!researchMode?.enabled || isImageModel(model)) return null;
  const noModels = (researchMode?.configurations?.length ?? 0) === 0;

  const tooltip = noModels
    ? 'No models to compare yet. Click to add them.'
    : `Comparing ${enabledCount} ${enabledCount === 1 ? 'model' : 'models'} in parallel. Click to change them.`;

  const label = noModels ? 'Research mode' : `Research mode (${enabledCount})`;
  // Out of room on the status line: the flask and the count (just the flask without models).
  const shown = compact ? (noModels ? null : String(enabledCount)) : label;

  return (
    <Tooltip title={compact ? `${label}. ${tooltip}` : tooltip} placement="top" variant="soft">
      {/* Quiet text on the composer's status line (ComposerStatusLine), matching the notebook files
          and the balance (NotebookFilesChip, CreditBalanceChip); warning-coloured while no model is
          set up to compare. */}
      <Button
        size="sm"
        variant="plain"
        color={noModels ? 'warning' : 'neutral'}
        data-testid="research-mode-status-btn"
        aria-label={compact ? label : undefined}
        onClick={() => openModal('research-mode')}
        startDecorator={<ScienceIcon sx={{ fontSize: 14, color: 'inherit' }} />}
        sx={{
          height: STATUS_ITEM_HEIGHT,
          minHeight: STATUS_ITEM_HEIGHT,
          // Icon-only when compact: at least square, so it is as easy to tap as it is tall.
          minWidth: STATUS_ITEM_HEIGHT,
          px: 0.75,
          gap: 0.25,
          borderRadius: '6px',
          whiteSpace: 'nowrap',
          fontSize: '12px',
          fontWeight: 400,
          ...(noModels
            ? {
                // The orange the model cost indicator uses (metricIconColor), not the paler
                // warning.plainColor.
                '--variant-plainColor': orange[450],
                '--variant-plainHoverColor': orange[450],
                // Hover and press on the same neutral wash as the other status-line items, not orange.
                '--variant-plainHoverBg': 'var(--joy-palette-neutral-plainHoverBg)',
                '--variant-plainActiveBg': 'var(--joy-palette-neutral-plainActiveBg)',
              }
            : {
                '--variant-plainColor': 'var(--joy-palette-text-tertiary)',
                '--variant-plainHoverColor': 'var(--joy-palette-text-secondary)',
              }),
        }}
      >
        {shown}
      </Button>
    </Tooltip>
  );
};

export default ResearchModeIndicator;
