import { useMemo, useState } from 'react';
import {
  Button,
  FormControl,
  FormHelperText,
  FormLabel,
  Option,
  Select,
  Stack,
  Textarea,
  ToggleButtonGroup,
  Typography,
} from '@mui/joy';
import { IMAGE_JOB_PROMPT_MAX_CHARS, type ImageModels } from '@bike4mind/common';
import { STUDIO_IMAGE_COUNT_MAX, type CreateStudioImageJobsBody } from '@client/app/hooks/data/studioImageJobs';
import type { NonEmptyList } from '@client/app/components/Studio/useCapabilityFormState';
import {
  buildImageModelOptions,
  imageAspectRatioOptions,
  imageSizeOptions,
  pickDefaultImageModel,
  type ImageIntent,
} from './imageModelOptions';

const COUNTS = Array.from({ length: STUDIO_IMAGE_COUNT_MAX }, (_, index) => index + 1);
// The Select value for "leave it to the model".
const MODEL_DEFAULT = '';

type ImageStudioFormProps = {
  // The user's runnable image models, as /api/models lists them.
  models: NonEmptyList<{ id: string; name: string }>;
  isSubmitting: boolean;
  onSubmit: (body: CreateStudioImageJobsBody) => void;
};

/**
 * Create's image form. The prompt and "make N" lead; the model picker opens on a sensible default and lists every
 * model, with the ones that cannot make the current request disabled and the reason why. Size and aspect ratio list
 * the picked model's own choices, and a choice persists across models, which is what disables the others.
 */
const ImageStudioForm = ({ models, isSubmitting, onSubmit }: ImageStudioFormProps) => {
  const [prompt, setPrompt] = useState('');
  const [intent, setIntent] = useState<ImageIntent>({ count: 1 });
  const options = useMemo(() => buildImageModelOptions(models, intent), [models, intent]);
  // Picked once, against the opening intent; after that the user's pick stands.
  const [model, setModel] = useState<ImageModels | undefined>(() =>
    pickDefaultImageModel(buildImageModelOptions(models, { count: 1 }))
  );

  if (model === undefined) {
    return (
      <Typography level="body-sm" data-testid="image-studio-no-generate-model">
        None of your image models can generate from a prompt yet.
      </Typography>
    );
  }

  const selected = options.find(option => option.model === model);
  const sizes = imageSizeOptions(model);
  const aspectRatios = imageAspectRatioOptions(model);
  const trimmedPrompt = prompt.trim();
  const canSubmit = trimmedPrompt.length > 0 && selected?.disabledReason === null && !isSubmitting;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({
      count: intent.count,
      request: {
        model,
        mode: 'generate',
        prompt: trimmedPrompt,
        ...(intent.size && { size: intent.size }),
        ...(intent.aspectRatio && { aspectRatio: intent.aspectRatio }),
      },
    });
  };

  return (
    <Stack gap={2} data-testid="image-studio-form">
      <FormControl>
        <FormLabel>Prompt</FormLabel>
        <Textarea
          minRows={3}
          placeholder="Describe the image you want"
          value={prompt}
          onChange={event => setPrompt(event.target.value)}
          slotProps={{
            textarea: { maxLength: IMAGE_JOB_PROMPT_MAX_CHARS, 'data-testid': 'image-studio-prompt-input' },
          }}
        />
      </FormControl>

      <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} flexWrap="wrap">
        <FormControl sx={{ minWidth: 240, flex: 1 }}>
          <FormLabel>Model</FormLabel>
          <Select
            value={model}
            onChange={(_event, value) => {
              if (value) setModel(value);
            }}
            // The options carry a reason line; the closed picker shows the model name alone.
            renderValue={() => selected?.label ?? model}
            slotProps={{ button: { 'data-testid': 'image-studio-model-select' } }}
          >
            {options.map(option => (
              <Option
                key={option.model}
                value={option.model}
                disabled={option.disabledReason !== null}
                data-testid={`image-studio-model-option-${option.model}`}
              >
                <Stack>
                  <Typography level="body-sm" textColor="inherit">
                    {option.label}
                  </Typography>
                  {option.disabledReason && (
                    <Typography level="body-xs" data-testid={`image-studio-model-reason-${option.model}`}>
                      {option.disabledReason}
                    </Typography>
                  )}
                </Stack>
              </Option>
            ))}
          </Select>
        </FormControl>

        {sizes.length > 0 && (
          <FormControl sx={{ minWidth: 160 }}>
            <FormLabel>Size</FormLabel>
            <Select
              value={intent.size ?? MODEL_DEFAULT}
              onChange={(_event, value) => setIntent(current => ({ ...current, size: value || undefined }))}
              slotProps={{ button: { 'data-testid': 'image-studio-size-select' } }}
            >
              <Option value={MODEL_DEFAULT}>Default</Option>
              {sizes.map(size => (
                <Option key={size} value={size} data-testid={`image-studio-size-option-${size}`}>
                  {size}
                </Option>
              ))}
            </Select>
          </FormControl>
        )}

        {aspectRatios.length > 0 && (
          <FormControl sx={{ minWidth: 140 }}>
            <FormLabel>Aspect ratio</FormLabel>
            <Select
              value={intent.aspectRatio ?? MODEL_DEFAULT}
              onChange={(_event, value) => setIntent(current => ({ ...current, aspectRatio: value || undefined }))}
              slotProps={{ button: { 'data-testid': 'image-studio-aspect-select' } }}
            >
              <Option value={MODEL_DEFAULT}>Default</Option>
              {aspectRatios.map(aspectRatio => (
                <Option key={aspectRatio} value={aspectRatio} data-testid={`image-studio-aspect-option-${aspectRatio}`}>
                  {aspectRatio}
                </Option>
              ))}
            </Select>
          </FormControl>
        )}

        <FormControl>
          <FormLabel>Images</FormLabel>
          <ToggleButtonGroup
            value={String(intent.count)}
            onChange={(_event, value) => {
              if (value) setIntent(current => ({ ...current, count: Number(value) }));
            }}
            aria-label="Number of images"
          >
            {COUNTS.map(count => (
              <Button key={count} value={String(count)} data-testid={`image-studio-count-${count}`}>
                {count}
              </Button>
            ))}
          </ToggleButtonGroup>
        </FormControl>
      </Stack>

      {selected?.disabledReason && (
        <FormHelperText data-testid="image-studio-model-why-not">{selected.disabledReason}</FormHelperText>
      )}

      <Button
        onClick={submit}
        disabled={!canSubmit}
        loading={isSubmitting}
        sx={{ alignSelf: 'flex-start' }}
        data-testid="image-studio-generate-btn"
      >
        {intent.count === 1 ? 'Generate image' : `Generate ${intent.count} images`}
      </Button>
    </Stack>
  );
};

export default ImageStudioForm;
