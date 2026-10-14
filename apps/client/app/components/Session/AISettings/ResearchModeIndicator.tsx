import { FC, useMemo } from 'react';
import { Button, Tooltip } from '@mui/joy';
import ScienceIcon from '@mui/icons-material/ScienceOutlined';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useAdvancedAISettings } from './useAdvancedAISettingsStore';
import { isImageModel } from '@client/app/utils/commands';

const ResearchModeIndicator: FC = () => {
  const researchMode = useLLM(state => state.researchMode);
  const model = useLLM(state => state.model);
  const openModal = useAdvancedAISettings(s => s.openModal);

  const enabledCount = useMemo(
    () => researchMode?.configurations?.filter(c => c.enabled).length ?? 0,
    [researchMode?.configurations]
  );

  if (!researchMode?.enabled || isImageModel(model)) return null;
  const noModels = (researchMode?.configurations?.length ?? 0) === 0;

  const tooltip = noModels
    ? 'No models to compare yet. Click to add them.'
    : `Comparing ${enabledCount} ${enabledCount === 1 ? 'model' : 'models'} in parallel. Click to change them.`;

  return (
    <Tooltip title={tooltip} placement="top" variant="soft">
      {/* Quiet text on the composer's status line (ComposerStatusLine), matching the notebook files
          and the balance (NotebookFilesChip, CreditBalanceChip); warning-coloured while no model is
          set up to compare. */}
      <Button
        size="sm"
        variant="plain"
        color={noModels ? 'warning' : 'neutral'}
        data-testid="research-mode-status-btn"
        onClick={() => openModal('research-mode')}
        startDecorator={<ScienceIcon sx={{ fontSize: 14, color: 'inherit' }} />}
        sx={{
          height: '24px',
          minHeight: '24px',
          px: 0.75,
          gap: 0.25,
          borderRadius: '6px',
          whiteSpace: 'nowrap',
          fontSize: '12px',
          fontWeight: 400,
          ...(!noModels && {
            '--variant-plainColor': 'var(--joy-palette-text-tertiary)',
            '--variant-plainHoverColor': 'var(--joy-palette-text-secondary)',
          }),
        }}
      >
        {noModels ? 'Research mode' : `Research mode (${enabledCount})`}
      </Button>
    </Tooltip>
  );
};

export default ResearchModeIndicator;
