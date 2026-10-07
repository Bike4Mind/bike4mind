import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  FormControl,
  FormLabel,
  Option,
  Select,
  Slider,
  Stack,
  Switch,
  Textarea,
  ToggleButtonGroup,
  Typography,
} from '@mui/joy';
import type { CreateVideoGenerationBody, VideoModel } from '@bike4mind/common';
import ImageBrowserModal from '@client/app/components/Agent/ImageBrowserModal';
import { useImageBrowser } from '@client/app/hooks/agent/useImageBrowser';
import { formatCredits } from '@client/app/utils/formatUsd';
import {
  canSubmit,
  clampToModel,
  estimateCredits,
  initialFormFor,
  MODE_LABELS,
  toCreateBody,
  VIDEO_PROMPT_MAX_LENGTH,
  type VideoFormState,
} from './videoForm';

type VideoStudioFormProps = {
  models: VideoModel[];
  isSubmitting: boolean;
  onSubmit: (body: CreateVideoGenerationBody) => void;
};

const VideoStudioForm = ({ models, isSubmitting, onSubmit }: VideoStudioFormProps) => {
  const [form, setForm] = useState<VideoFormState>(() => initialFormFor(models[0]));
  const [changes, setChanges] = useState<string[]>([]);
  const imageBrowser = useImageBrowser();
  const model = models.find(candidate => candidate.id === form.modelId);

  // The model list can change under the form (an admin disables a model, a key goes away). Move to a model that is
  // still offered and say so, rather than submit one the server will refuse with model_disabled.
  useEffect(() => {
    if (model || models.length === 0) return;
    const fallback = models[0];
    const clamped = clampToModel(form, fallback);
    setForm(clamped.state);
    setChanges([
      `The selected model is no longer available; switched to ${fallback.display_name}.`,
      ...clamped.changes,
    ]);
  }, [form, model, models]);

  if (!model) return null;

  const update = (patch: Partial<VideoFormState>) => setForm(previous => ({ ...previous, ...patch }));

  const selectModel = (modelId: string | null) => {
    const next = models.find(candidate => candidate.id === modelId);
    if (!next || next.id === form.modelId) return;
    const clamped = clampToModel(form, next);
    setForm(clamped.state);
    setChanges(clamped.changes);
  };

  const estimate = estimateCredits(form);
  const promptLength = form.prompt.trim().length;

  return (
    <Stack gap={2} data-testid="video-form">
      <FormControl>
        <FormLabel>Model</FormLabel>
        <Select
          value={form.modelId}
          onChange={(_event, value) => selectModel(value)}
          slotProps={{ button: { 'data-testid': 'video-form-model-select' } }}
        >
          {models.map(candidate => (
            <Option key={candidate.id} value={candidate.id}>
              {candidate.display_name}
            </Option>
          ))}
        </Select>
      </FormControl>

      {changes.length > 0 && (
        <Alert color="warning" variant="soft" data-testid="video-form-changes">
          <Stack>
            {changes.map(change => (
              <Typography key={change} level="body-sm">
                {change}
              </Typography>
            ))}
          </Stack>
        </Alert>
      )}

      <FormControl>
        <FormLabel>Mode</FormLabel>
        <ToggleButtonGroup
          size="sm"
          value={form.mode}
          onChange={(_event, value) => {
            const mode = model.modes.find(candidate => candidate === value);
            if (mode) update({ mode, inputImage: mode === 'image_to_video' ? form.inputImage : null });
          }}
          data-testid="video-form-mode-toggle"
        >
          {model.modes.map(mode => (
            <Button key={mode} value={mode}>
              {MODE_LABELS[mode]}
            </Button>
          ))}
        </ToggleButtonGroup>
      </FormControl>

      <FormControl>
        <FormLabel>Prompt</FormLabel>
        <Textarea
          minRows={3}
          value={form.prompt}
          placeholder="Describe the video you want"
          onChange={event => update({ prompt: event.target.value })}
          slotProps={{ textarea: { 'data-testid': 'video-form-prompt-input', maxLength: VIDEO_PROMPT_MAX_LENGTH } }}
        />
        <Typography level="body-xs" sx={{ alignSelf: 'flex-end' }}>
          {promptLength}/{VIDEO_PROMPT_MAX_LENGTH}
        </Typography>
      </FormControl>

      {form.mode === 'image_to_video' && (
        <FormControl>
          <FormLabel>Image</FormLabel>
          <Stack direction="row" gap={1} alignItems="center">
            <Button
              size="sm"
              variant="outlined"
              onClick={() => imageBrowser.openImageBrowser()}
              data-testid="video-form-image-pick-btn"
            >
              {form.inputImage ? 'Change image' : 'Choose image'}
            </Button>
            {form.inputImage && (
              <Typography level="body-sm" data-testid="video-form-image-name">
                {form.inputImage.fileName}
              </Typography>
            )}
          </Stack>
        </FormControl>
      )}

      <FormControl>
        <FormLabel>Duration: {form.durationSeconds}s</FormLabel>
        {model.duration.kind === 'range' ? (
          <Slider
            min={model.duration.min}
            max={model.duration.max}
            step={model.duration.step}
            value={form.durationSeconds}
            valueLabelDisplay="auto"
            onChange={(_event, value) => {
              if (typeof value === 'number') update({ durationSeconds: value });
            }}
            slotProps={{ input: { 'data-testid': 'video-form-duration-slider' } }}
          />
        ) : (
          <ToggleButtonGroup
            size="sm"
            value={String(form.durationSeconds)}
            onChange={(_event, value) => {
              const seconds = Number(value);
              if (model.duration.kind === 'discrete' && model.duration.values.includes(seconds)) {
                update({ durationSeconds: seconds });
              }
            }}
          >
            {model.duration.values.map(seconds => (
              <Button key={seconds} value={String(seconds)} data-testid={`video-form-duration-option-${seconds}`}>
                {seconds}s
              </Button>
            ))}
          </ToggleButtonGroup>
        )}
      </FormControl>

      <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
        <FormControl sx={{ flex: 1 }}>
          <FormLabel>Aspect ratio</FormLabel>
          <Select
            value={form.aspectRatio}
            onChange={(_event, value) => {
              const aspectRatio = model.aspect_ratios.find(candidate => candidate === value);
              if (aspectRatio) update({ aspectRatio });
            }}
            slotProps={{ button: { 'data-testid': 'video-form-aspect-select' } }}
          >
            {model.aspect_ratios.map(ratio => (
              <Option key={ratio} value={ratio}>
                {ratio}
              </Option>
            ))}
          </Select>
        </FormControl>
        <FormControl sx={{ flex: 1 }}>
          <FormLabel>Resolution</FormLabel>
          <Select
            value={form.resolution}
            onChange={(_event, value) => {
              const resolution = model.resolutions.find(candidate => candidate === value);
              if (resolution) update({ resolution });
            }}
            slotProps={{ button: { 'data-testid': 'video-form-resolution-select' } }}
          >
            {model.resolutions.map(resolution => (
              <Option key={resolution} value={resolution}>
                {resolution}
              </Option>
            ))}
          </Select>
        </FormControl>
      </Stack>

      {model.audio === 'optional' && form.audio !== null ? (
        <Switch
          checked={form.audio}
          onChange={event => update({ audio: event.target.checked })}
          endDecorator="Audio"
          slotProps={{ input: { 'data-testid': 'video-form-audio-switch' } }}
        />
      ) : (
        <Typography level="body-sm" data-testid="video-form-audio-note">
          {model.audio === 'always' ? 'Audio is included.' : 'This model generates video without audio.'}
        </Typography>
      )}

      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={2}>
        <Typography level="body-sm" data-testid="video-form-estimate">
          {estimate === null ? 'Cost estimate unavailable' : `Estimated cost: ${formatCredits(estimate)} credits`}
        </Typography>
        <Button
          loading={isSubmitting}
          disabled={!canSubmit(form)}
          onClick={() => onSubmit(toCreateBody(form))}
          data-testid="video-form-submit-btn"
        >
          Generate video
        </Button>
      </Stack>

      <ImageBrowserModal
        isOpen={imageBrowser.isImageBrowserOpen}
        onClose={imageBrowser.closeImageBrowser}
        imageSearch={imageBrowser.imageSearch}
        onImageSearchChange={imageBrowser.setImageSearch}
        isLoadingImages={imageBrowser.isLoadingImages}
        imageFiles={imageBrowser.imageFiles}
        selectedImage={imageBrowser.selectedImage}
        onSelectImage={imageBrowser.selectImage}
        onApplyImage={file => {
          update({ inputImage: { fileId: file.id, fileName: file.fileName } });
          imageBrowser.closeImageBrowser();
        }}
        onSearch={() => void imageBrowser.fetchImageFiles(imageBrowser.imageSearch)}
        title="Choose an image to animate"
        emptyHint="No images yet. Upload one in Files, then choose it here."
      />
    </Stack>
  );
};

export default VideoStudioForm;
