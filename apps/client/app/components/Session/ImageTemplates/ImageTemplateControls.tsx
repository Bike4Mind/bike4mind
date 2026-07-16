import { FC, useState } from 'react';
import { Box, Chip, ChipDelete, Dropdown, ListDivider, Menu, MenuButton, MenuItem, Typography } from '@mui/joy';
import { Bookmarks as TemplateIcon } from '@mui/icons-material';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import type { IImageGenerationTemplateDocument } from '@bike4mind/common';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useImageTemplates, useApplyImageTemplate } from '../../../hooks/data/imageTemplates';
import { CostPreviewChip } from './CostPreviewChip';
import { SaveTemplateModal } from './SaveTemplateModal';
import { ManageTemplatesModal } from './ManageTemplatesModal';

const fixedHeight = { height: '32px !important', minHeight: '32px !important' };

/**
 * Image-mode template controls for the composer settings bar: an exact-model
 * picker (only templates bound to the active model are offered), the applied-
 * template chip, and the live cost-preview chip. Hosts the Save/Manage modals.
 * Rendered by the parent only when an image model is active and the feature flag
 * is on.
 */
export const ImageTemplateControls: FC = () => {
  const [model, currentTemplateId, applyImageTemplate, setLLM] = useLLM(
    useShallow(s => [s.model, s.currentTemplateId, s.applyImageTemplate, s.setLLM])
  );
  const { data: templates = [] } = useImageTemplates();
  const applyMutation = useApplyImageTemplate();

  const [saveOpen, setSaveOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  // Exact-model: only offer templates bound to the active model. This also
  // guards a coupling: AdvancedAISettings has a [model]-gated effect that force-
  // resets quality/style on model change. Because apply never changes the model
  // (the template's model === the active model), that effect can't fire and
  // clobber the template's quality/style. If this filter is ever loosened to
  // allow cross-model apply, that reset must be reconciled.
  const matching = templates.filter(t => t.model === model);
  const applied = currentTemplateId ? templates.find(t => t.id === currentTemplateId) : undefined;

  const handleApply = async (template: IImageGenerationTemplateDocument) => {
    try {
      // Server bumps usageCount and returns the authoritative copy (422s on a
      // model mismatch as a backstop); load that into LLMContext.
      const fresh = await applyMutation.mutateAsync({ id: template.id, model });
      applyImageTemplate(fresh);
    } catch {
      toast.error('Could not apply template');
    }
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <Dropdown>
        <MenuButton
          data-testid="image-templates-toggle"
          variant="outlined"
          size="sm"
          sx={{ display: 'flex', gap: '6px', borderRadius: '6px', px: 1, ...fixedHeight }}
        >
          <TemplateIcon sx={{ color: 'text.primary', width: '14px', height: '14px' }} />
          <Typography level="body-sm" sx={{ color: 'text.primary', fontSize: '14px' }}>
            Templates
          </Typography>
        </MenuButton>
        <Menu placement="top" sx={{ minWidth: 220, maxHeight: '50vh', overflowY: 'auto' }}>
          {matching.length === 0 ? (
            <MenuItem disabled data-testid="image-templates-empty">
              No templates for this model
            </MenuItem>
          ) : (
            matching.map(t => (
              <MenuItem key={t.id} data-testid="image-template-apply-item" onClick={() => handleApply(t)}>
                {t.name}
              </MenuItem>
            ))
          )}
          <ListDivider />
          <MenuItem data-testid="image-template-save-item" onClick={() => setSaveOpen(true)}>
            Save current settings...
          </MenuItem>
          <MenuItem data-testid="image-template-manage-item" onClick={() => setManageOpen(true)}>
            Manage templates...
          </MenuItem>
        </Menu>
      </Dropdown>

      {applied && (
        <Chip
          size="sm"
          variant="soft"
          color="primary"
          data-testid="applied-template-chip"
          endDecorator={
            <ChipDelete data-testid="applied-template-clear" onClick={() => setLLM({ currentTemplateId: null })} />
          }
        >
          {applied.name}
        </Chip>
      )}

      <CostPreviewChip />

      <SaveTemplateModal open={saveOpen} onClose={() => setSaveOpen(false)} />
      <ManageTemplatesModal open={manageOpen} onClose={() => setManageOpen(false)} />
    </Box>
  );
};
