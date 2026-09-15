import { FC, useMemo, useState } from 'react';
import { Autocomplete, Box, Button, Chip, Modal, ModalClose, ModalDialog, Sheet, Typography } from '@mui/joy';
import { toast } from 'sonner';
import { AutoAwesome as SuggestIcon } from '@mui/icons-material';
import { useChatInput } from '@client/app/hooks/useChatInput';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useAdvancedAISettings } from '../AISettings/useAdvancedAISettingsStore';
import { recommendOrientation } from './recommendations';
import {
  assemblePrompt,
  EMPTY_SELECTIONS,
  PROMPT_BUILDER_CATEGORIES,
  PROMPT_SUGGESTIONS,
  type PromptCategoryKey,
  type PromptSelections,
} from './taxonomy';

/**
 * Guided prompt builder: pick prose chips (subject/scene/style/mood/lighting) +
 * free text, see a live natural-language assembly, and apply it to the composer.
 * Opened from the composer settings-bar icon (generation image models only).
 */
export const PromptBuilderModal: FC = () => {
  const open = useAdvancedAISettings(s => s.promptBuilderOpen);
  const setOpen = useAdvancedAISettings(s => s.setPromptBuilderOpen);
  const setChatInputValue = useChatInput(s => s.setChatInputValue);
  const model = useLLM(s => s.model);
  const aspectRatio = useLLM(s => s.aspect_ratio);
  const size = useLLM(s => s.size);
  const setLLM = useLLM(s => s.setLLM);

  const [selections, setSelections] = useState<PromptSelections>(EMPTY_SELECTIONS);
  const [extras, setExtras] = useState<string[]>([]);

  const preview = useMemo(() => assemblePrompt(selections, extras.join(', ')), [selections, extras]);

  // M3: recommend an orientation setting from prompt keywords, model-aware
  // (aspect_ratio for most models, size for GPT-Image). Show only when the
  // recommended value differs from the model's current relevant setting.
  const recommendation = useMemo(() => recommendOrientation(preview, model), [preview, model]);
  const currentValue = recommendation?.settingKey === 'size' ? size : aspectRatio;
  const showRecommendation = recommendation && recommendation.value !== currentValue;

  const toggleChip = (key: PromptCategoryKey, value: string) =>
    setSelections(prev => {
      const current = prev[key];
      const next = current.includes(value) ? current.filter(v => v !== value) : [...current, value];
      return { ...prev, [key]: next };
    });

  const reset = () => {
    setSelections(EMPTY_SELECTIONS);
    setExtras([]);
  };

  const handleApply = () => {
    if (!preview) return;
    setChatInputValue(preview);
    toast.success('Prompt added to the composer');
    setOpen(false);
  };

  return (
    <Modal open={open} onClose={() => setOpen(false)}>
      <ModalDialog
        data-testid="prompt-builder-modal"
        sx={{ width: 'min(680px, 94vw)', maxHeight: '88vh', overflowY: 'auto', gap: 1.5 }}
      >
        <ModalClose data-testid="prompt-builder-close-btn" />
        <Box>
          <Typography level="title-lg">Prompt Builder</Typography>
          <Typography level="body-sm" sx={{ opacity: 0.7 }}>
            Pick building blocks to assemble a natural-language image prompt, then add it to the composer.
          </Typography>
        </Box>

        {PROMPT_BUILDER_CATEGORIES.map(cat => (
          <Box key={cat.key} data-testid={`prompt-builder-group-${cat.key}`}>
            <Typography level="title-sm">{cat.label}</Typography>
            <Typography level="body-xs" sx={{ opacity: 0.6, mb: 0.5 }}>
              {cat.hint}
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
              {cat.chips.map(chip => {
                const selected = selections[cat.key].includes(chip);
                return (
                  <Chip
                    key={chip}
                    size="sm"
                    variant={selected ? 'solid' : 'outlined'}
                    color={selected ? 'primary' : 'neutral'}
                    onClick={() => toggleChip(cat.key, chip)}
                    slotProps={{ action: { 'data-testid': `pb-chip-${chip}` } }}
                  >
                    {chip}
                  </Chip>
                );
              })}
            </Box>
          </Box>
        ))}

        <Box>
          <Typography level="title-sm">Extra details</Typography>
          <Typography level="body-xs" sx={{ opacity: 0.6, mb: 0.5 }}>
            Type your own, or pick from suggestions
          </Typography>
          <Autocomplete
            multiple
            freeSolo
            size="sm"
            options={PROMPT_SUGGESTIONS}
            value={extras}
            onChange={(_, value) => setExtras(value as string[])}
            placeholder="e.g. shallow depth of field"
            data-testid="prompt-builder-extras"
          />
        </Box>

        <Sheet variant="soft" sx={{ borderRadius: 'sm', p: 1.5 }}>
          <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', mb: 0.5 }}>
            <Typography level="title-sm">Preview</Typography>
            <Typography level="body-xs" sx={{ opacity: 0.6 }} data-testid="prompt-builder-charcount">
              {preview.length} chars
            </Typography>
          </Box>
          <Typography level="body-sm" data-testid="prompt-builder-preview" sx={{ opacity: preview ? 1 : 0.5 }}>
            {preview || 'Select building blocks or type to build a prompt.'}
          </Typography>
        </Sheet>

        {showRecommendation && (
          <Sheet
            variant="soft"
            color="primary"
            data-testid="prompt-builder-recommendation"
            sx={{ borderRadius: 'sm', p: 1, display: 'flex', alignItems: 'center', gap: 1 }}
          >
            <SuggestIcon sx={{ fontSize: 16 }} />
            <Typography level="body-xs" sx={{ flex: 1 }}>
              This looks like a {recommendation.label} image. Set the{' '}
              {recommendation.settingKey === 'size' ? 'size' : 'aspect ratio'} to {recommendation.value}?
            </Typography>
            <Button
              size="sm"
              variant="solid"
              color="primary"
              data-testid="prompt-builder-apply-recommendation-btn"
              onClick={() => setLLM({ [recommendation.settingKey]: recommendation.value })}
            >
              Use {recommendation.value}
            </Button>
          </Sheet>
        )}

        <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
          <Button variant="plain" color="neutral" onClick={reset} data-testid="prompt-builder-clear-btn">
            Clear
          </Button>
          <Button onClick={handleApply} disabled={!preview} data-testid="prompt-builder-apply-btn">
            Add to prompt
          </Button>
        </Box>
      </ModalDialog>
    </Modal>
  );
};
