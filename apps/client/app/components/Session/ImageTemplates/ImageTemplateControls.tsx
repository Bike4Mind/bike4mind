import { FC, useMemo } from 'react';
import { Box, Chip } from '@mui/joy';
import { Bookmarks as TemplateIcon } from '@mui/icons-material';
import { useImageTemplates } from '../../../hooks/data/imageTemplates';
import { useAdvancedAISettings } from '../AISettings/useAdvancedAISettingsStore';
import { CostPreviewChip } from './CostPreviewChip';
import { findMatchingTemplate } from './settingsSnapshot';
import { useImageSettingsSnapshot } from './useImageSettingsSnapshot';

/**
 * Compact image-template affordance for the composer settings bar: the derived
 * applied-template indicator (clickable - opens the settings modal where the
 * template panel lives) and the live cost-preview chip. All saving/managing
 * happens in the modal panel; the bar only reflects state.
 */
export const ImageTemplateControls: FC = () => {
  const setModelDetailsOpen = useAdvancedAISettings(s => s.setModelDetailsOpen);
  const { model, snapshot } = useImageSettingsSnapshot();
  const { data: templates = [] } = useImageTemplates();

  // Derived indicator: the template whose settings equal the live config (dedup
  // guarantees at most one match per model).
  const applied = useMemo(() => findMatchingTemplate(templates, model, snapshot), [templates, model, snapshot]);

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      {applied && (
        <Chip
          size="sm"
          variant="soft"
          color="primary"
          data-testid="applied-template-chip"
          onClick={() => setModelDetailsOpen(true)}
          slotProps={{ action: { 'data-testid': 'applied-template-open' } }}
          startDecorator={<TemplateIcon sx={{ fontSize: 14 }} />}
        >
          {applied.name}
        </Chip>
      )}

      <CostPreviewChip />
    </Box>
  );
};
