import { FC } from 'react';
import { Chip, Tooltip } from '@mui/joy';
import { Compare as CompareIcon } from '@mui/icons-material';
import { useLLM } from '@client/app/contexts/LLMContext';

export const ResearchModeIndicator: FC = () => {
  const researchMode = useLLM(state => state.researchMode);

  if (!researchMode.enabled) {
    return null;
  }

  return (
    <Tooltip
      title={`Research Mode: Comparing ${researchMode.configurations.length} model${researchMode.configurations.length > 1 ? 's' : ''}`}
      placement="bottom"
    >
      <Chip
        variant="soft"
        color="primary"
        size="sm"
        startDecorator={<CompareIcon sx={{ fontSize: '16px' }} />}
        sx={{
          borderRadius: '16px',
          px: 1.5,
          py: 0.5,
          fontSize: '13px',
          fontWeight: 500,
        }}
      >
        Research Mode ({researchMode.configurations.length})
      </Chip>
    </Tooltip>
  );
};
