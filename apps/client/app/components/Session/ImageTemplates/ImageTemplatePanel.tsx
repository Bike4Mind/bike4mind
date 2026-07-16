import { FC, useMemo, useState } from 'react';
import { Box, Button, Card, Chip, CircularProgress, IconButton, Input, Sheet, Tooltip, Typography } from '@mui/joy';
import { Delete as DeleteIcon, InfoOutlined as InfoIcon } from '@mui/icons-material';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import { IMAGE_TEMPLATE_NAME_MAX, type ImageGenerationTemplateInputType } from '@bike4mind/common';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { getErrorMessage } from '@client/app/utils/error';
import { useImageTemplates, useCreateImageTemplate, useDeleteImageTemplate } from '../../../hooks/data/imageTemplates';
import { findMatchingTemplate, imageTemplateSettingsSnapshot } from './settingsSnapshot';

/**
 * The single home for image templates (feature B): lives as a column in the
 * image tab of AdvancedAIModal. Save the current settings, apply a saved
 * template (settings update live in the same modal), and delete. Self-gated on
 * the feature flag - renders nothing when off. Scoped to the active model
 * (exact-model), which follows whatever model is selected in the modal.
 */
export const ImageTemplatePanel: FC = () => {
  const { isAdminFeatureEnabled } = useFeatureEnabled();
  const enabled = isAdminFeatureEnabled('EnableImageTemplates');

  const [
    model,
    applyImageTemplate,
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
      s.applyImageTemplate,
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

  const { data: templates = [], isLoading } = useImageTemplates(enabled);
  const create = useCreateImageTemplate();
  const del = useDeleteImageTemplate();

  const [name, setName] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const snapshot = useMemo(
    () =>
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
      }),
    [size, quality, style, seed, n, width, height, aspect_ratio, output_format, safety_tolerance, prompt_upsampling]
  );

  const matching = useMemo(() => templates.filter(t => t.model === model), [templates, model]);
  const applied = useMemo(() => findMatchingTemplate(matching, model, snapshot), [matching, model, snapshot]);

  if (!enabled) return null;

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await create.mutateAsync({
        name: trimmed,
        // Panel only renders in the image tab, so `model` is a valid template model.
        model: model as ImageGenerationTemplateInputType['model'],
        settings: snapshot,
      });
      toast.success('Image settings template saved');
      setName('');
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await del.mutateAsync(id);
      toast.success('Image settings template deleted');
    } catch {
      toast.error('Could not delete the template');
    } finally {
      setConfirmingId(null);
    }
  };

  return (
    <Sheet
      data-testid="image-template-panel"
      variant="soft"
      sx={{
        width: '100%',
        mt: 1,
        borderRadius: 'sm',
        p: 1.5,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Typography level="title-sm">Image Settings Templates</Typography>
        <Tooltip
          placement="top"
          title="An image settings template saves the current image settings for this model: size, quality, style, seed, number of images, width/height, aspect ratio, output format, and (Flux only) safety tolerance & prompt upsampling. Your prompt and non-image settings (e.g. temperature, the AI toggle) are not saved."
        >
          <InfoIcon data-testid="templates-info-icon" sx={{ fontSize: 15, opacity: 0.6, cursor: 'help' }} />
        </Tooltip>
      </Box>

      {/* Inline save of the current settings. */}
      <Box sx={{ display: 'flex', gap: 0.5 }}>
        <Input
          size="sm"
          placeholder="Name current settings"
          value={name}
          onChange={e => setName(e.target.value.slice(0, IMAGE_TEMPLATE_NAME_MAX))}
          slotProps={{ input: { 'data-testid': 'panel-save-name-input' } }}
          sx={{ flex: 1 }}
        />
        <Button
          size="sm"
          onClick={handleSave}
          loading={create.isPending}
          disabled={!name.trim()}
          data-testid="panel-save-btn"
        >
          Save
        </Button>
      </Box>

      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
          <CircularProgress size="sm" />
        </Box>
      ) : matching.length === 0 ? (
        <Typography level="body-xs" sx={{ opacity: 0.7, py: 1 }} data-testid="panel-empty">
          No image settings templates for this model yet. Save the current settings to create one.
        </Typography>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' },
            gap: 0.75,
            maxHeight: 260,
            overflowY: 'auto',
          }}
        >
          {matching.map(t => {
            const isApplied = applied?.id === t.id;
            return (
              <Card
                key={t.id}
                variant={isApplied ? 'solid' : 'outlined'}
                color={isApplied ? 'primary' : 'neutral'}
                data-testid="panel-template-card"
                onClick={() => applyImageTemplate(t)}
                sx={{ p: 1, gap: 0.25, cursor: 'pointer' }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                  <Typography level="body-sm" noWrap sx={{ color: isApplied ? 'inherit' : 'text.primary' }}>
                    {t.name}
                  </Typography>
                  {isApplied && (
                    <Chip size="sm" variant="soft" data-testid="panel-applied-chip">
                      Applied
                    </Chip>
                  )}
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Typography level="body-xs" sx={{ opacity: 0.7 }}>
                    {typeof t.usageCount === 'number' ? `used ${t.usageCount}x` : ''}
                  </Typography>
                  {confirmingId === t.id ? (
                    <Box sx={{ display: 'flex', gap: 0.5 }} onClick={e => e.stopPropagation()}>
                      <Button
                        size="sm"
                        variant="solid"
                        color="danger"
                        loading={del.isPending}
                        data-testid="panel-confirm-delete-btn"
                        onClick={() => handleDelete(t.id)}
                      >
                        Delete
                      </Button>
                      <Button
                        size="sm"
                        variant="plain"
                        color="neutral"
                        data-testid="panel-cancel-delete-btn"
                        onClick={() => setConfirmingId(null)}
                      >
                        Cancel
                      </Button>
                    </Box>
                  ) : (
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="danger"
                      data-testid="panel-delete-btn"
                      onClick={e => {
                        e.stopPropagation();
                        setConfirmingId(t.id);
                      }}
                    >
                      <DeleteIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  )}
                </Box>
              </Card>
            );
          })}
        </Box>
      )}
    </Sheet>
  );
};
