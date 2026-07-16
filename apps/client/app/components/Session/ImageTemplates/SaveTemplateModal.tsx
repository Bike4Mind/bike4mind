import { FC, useState } from 'react';
import { Button, FormControl, FormLabel, Input, Modal, ModalDialog, Stack, Textarea, Typography } from '@mui/joy';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import { useLLM } from '@client/app/contexts/LLMContext';
import {
  IMAGE_TEMPLATE_NAME_MAX,
  IMAGE_TEMPLATE_DESCRIPTION_MAX,
  type ImageGenerationTemplateInputType,
} from '@bike4mind/common';
import { useCreateImageTemplate } from '../../../hooks/data/imageTemplates';

interface SaveTemplateModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Captures the current image-mode settings as a new template bound to the active
 * model. The settings snapshot must stay in sync with ImageTemplateSettingsSchema.
 */
export const SaveTemplateModal: FC<SaveTemplateModalProps> = ({ open, onClose }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useCreateImageTemplate();

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

  const reset = () => {
    setName('');
    setDescription('');
  };

  // Clear the draft on any close (cancel/backdrop), not just a successful save,
  // so a discarded draft doesn't reappear on reopen.
  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await create.mutateAsync({
        name: trimmed,
        description: description.trim() || undefined,
        // The modal only renders for image models (parent-gated), so the active
        // model is a valid template model; the string->enum cast is safe here.
        model: model as ImageGenerationTemplateInputType['model'],
        settings: {
          size,
          quality,
          style,
          seed,
          n,
          width,
          height,
          aspect_ratio,
          output_format: output_format ?? undefined,
          safety_tolerance,
          prompt_upsampling,
        },
      });
      toast.success('Template saved');
      reset();
      onClose();
    } catch (err: unknown) {
      // Server enforces the per-user cap and validation; surface its message.
      const message = err instanceof Error ? err.message : 'Could not save template';
      toast.error(message);
    }
  };

  return (
    <Modal open={open} onClose={handleClose}>
      <ModalDialog data-testid="save-template-modal" sx={{ width: 'min(420px, 92vw)' }}>
        <Typography level="title-md">Save image template</Typography>
        <Typography level="body-sm" sx={{ mb: 1, opacity: 0.7 }}>
          Saves the current settings for <strong>{model}</strong>. It will only apply to this model.
        </Typography>
        <Stack spacing={1.5}>
          <FormControl required>
            <FormLabel>Name</FormLabel>
            <Input
              data-testid="save-template-name-input"
              autoFocus
              value={name}
              onChange={e => setName(e.target.value.slice(0, IMAGE_TEMPLATE_NAME_MAX))}
              placeholder="e.g. Cinematic portrait"
            />
          </FormControl>
          <FormControl>
            <FormLabel>Description (optional)</FormLabel>
            <Textarea
              data-testid="save-template-description-input"
              minRows={2}
              value={description}
              onChange={e => setDescription(e.target.value.slice(0, IMAGE_TEMPLATE_DESCRIPTION_MAX))}
            />
          </FormControl>
          <Stack direction="row" spacing={1} justifyContent="flex-end">
            <Button variant="plain" color="neutral" onClick={handleClose} data-testid="save-template-cancel-btn">
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              loading={create.isPending}
              disabled={!name.trim()}
              data-testid="save-template-save-btn"
            >
              Save
            </Button>
          </Stack>
        </Stack>
      </ModalDialog>
    </Modal>
  );
};
