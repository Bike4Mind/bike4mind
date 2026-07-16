import { FC, useMemo } from 'react';
import { Box, Chip } from '@mui/joy';
import { Bookmarks as TemplateIcon } from '@mui/icons-material';
import { useShallow } from 'zustand/react/shallow';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useImageTemplates } from '../../../hooks/data/imageTemplates';
import { useAdvancedAISettings } from '../AISettings/useAdvancedAISettingsStore';
import { CostPreviewChip } from './CostPreviewChip';
import { findMatchingTemplate, imageTemplateSettingsSnapshot } from './settingsSnapshot';

/**
 * Compact image-template affordance for the composer settings bar: the derived
 * applied-template indicator (clickable - opens the settings modal where the
 * template panel lives) and the live cost-preview chip. All saving/managing
 * happens in the modal panel; the bar only reflects state.
 */
export const ImageTemplateControls: FC = () => {
  const setModelDetailsOpen = useAdvancedAISettings(s => s.setModelDetailsOpen);

  const [
    model,
    size,
    quality,
    style,
    seed,
    n,
    width,
    height,
    aspect_ratio,
    output_format,
    safety_tolerance,
    prompt_upsampling,
  ] = useLLM(
    useShallow(s => [
      s.model,
      s.size,
      s.quality,
      s.style,
      s.seed,
      s.n,
      s.width,
      s.height,
      s.aspect_ratio,
      s.output_format,
      s.safety_tolerance,
      s.prompt_upsampling,
    ])
  );
  const { data: templates = [] } = useImageTemplates();

  // Derived indicator: the template whose settings equal the live config (dedup
  // guarantees at most one match per model).
  const applied = useMemo(
    () =>
      findMatchingTemplate(
        templates,
        model,
        imageTemplateSettingsSnapshot({
          size,
          quality,
          style,
          seed,
          n,
          width,
          height,
          aspect_ratio,
          output_format,
          safety_tolerance,
          prompt_upsampling,
        })
      ),
    [
      templates,
      model,
      size,
      quality,
      style,
      seed,
      n,
      width,
      height,
      aspect_ratio,
      output_format,
      safety_tolerance,
      prompt_upsampling,
    ]
  );

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
