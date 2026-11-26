import { useEffect, useRef, useState } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Checkbox from '@mui/joy/Checkbox';
import FormControl from '@mui/joy/FormControl';
import FormLabel from '@mui/joy/FormLabel';
import Input from '@mui/joy/Input';
import Stack from '@mui/joy/Stack';
import Textarea from '@mui/joy/Textarea';
import Typography from '@mui/joy/Typography';
import Alert from '@mui/joy/Alert';
import { AVAILABLE_TTS_VOICES, VOICE_VENDOR_SUPPORTED_FORMATS } from '@bike4mind/common';
import type { StudioDraft } from '@shared/studioIpc';
import type { StudioController, StudioCreationDraft } from './controller';
import { studioMicroLabelSx } from './design/studioTokens';

type Settings = StudioDraft['settings'];
export function defaultStudioSettings(kind: StudioDraft['kind'], controller: StudioController): Settings {
  const catalog = controller.catalog;
  if (!catalog) return {};
  if (kind === 'image') return { model: catalog.images[0]?.id, count: 1 };
  if (kind === 'music') return { model: catalog.music[0]?.id, instrumental: false };
  if (kind === 'speech') return { provider: catalog.speech[0], format: 'mp3' };
  if (kind === 'sound-effect') return { provider: 'elevenlabs' };
  const model = catalog.videos[0];
  return model
    ? {
        model: model.id,
        mode: 'text_to_video',
        durationSeconds: model.defaults.duration_seconds,
        aspectRatio: model.defaults.aspect_ratio,
        resolution: model.defaults.resolution,
      }
    : {};
}

export function StudioSettings({
  controller,
  draft,
  disabled,
  edit,
  part = 'all',
}: {
  controller: StudioController;
  draft: StudioCreationDraft;
  disabled: boolean;
  edit(draft: StudioCreationDraft): void;
  /** The model picker alone, everything but it, or both: the Studio place draws them in separate panels, as web does. */
  part?: 'all' | 'model' | 'options';
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const latest = useRef<{
    draft: StudioCreationDraft;
    disabled: boolean;
    edit: typeof edit;
    referenceMax: number;
  } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const catalog = controller.catalog;
  if (!catalog) {
    latest.current = null;
    return null;
  }
  const s = draft.settings;
  const update = (patch: Partial<Settings>) => edit({ ...draft, settings: { ...s, ...patch } });
  const select = (
    key: keyof Settings,
    label: string,
    options: readonly { value: string; label: string }[],
    fallback = ''
  ) => {
    const value = String(s[key] ?? fallback);
    const choices =
      options.some(option => option.value === value) || !value
        ? options
        : [...options, { value, label: `${value} (not supported)` }];
    return (
      <FormControl key={key} disabled={disabled}>
        <FormLabel>{label}</FormLabel>
        <Box
          component="select"
          value={value}
          disabled={disabled}
          data-testid={`studio-setting-${key}`}
          onChange={event =>
            update({ [key]: key === 'count' ? Number(event.target.value) : event.target.value || undefined })
          }
          sx={{
            minHeight: 36,
            px: 1.25,
            border: '1px solid',
            borderColor: 'neutral.outlinedBorder',
            borderRadius: 'sm',
            bgcolor: 'background.surface',
            color: 'text.primary',
            font: 'inherit',
            width: '100%',
          }}
        >
          {key !== 'count' && (
            <option value="">{key === 'model' || key === 'provider' ? 'Choose...' : 'Model default'}</option>
          )}
          {choices.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Box>
      </FormControl>
    );
  };
  const number = (key: keyof Settings, label: string, min: number, max: number, step = 1) => (
    <FormControl key={key} disabled={disabled}>
      <FormLabel>{label}</FormLabel>
      <Input
        type="number"
        value={s[key] === undefined ? '' : String(s[key])}
        onChange={event => update({ [key]: event.target.value === '' ? undefined : Number(event.target.value) })}
        slotProps={{ input: { min, max, step, 'data-testid': `studio-setting-${key}` } }}
      />
    </FormControl>
  );
  const text = (key: 'model' | 'voice' | 'languageCode' | 'format', label: string) => (
    <FormControl key={key} disabled={disabled}>
      <FormLabel>{label}</FormLabel>
      <Input
        value={s[key] ?? ''}
        onChange={event => update({ [key]: event.target.value || undefined })}
        slotProps={{ input: { 'data-testid': `studio-setting-${key}` } }}
      />
    </FormControl>
  );
  const choices = (values: readonly string[]) => values.map(value => ({ value, label: value }));
  const toggle = (key: 'instrumental' | 'audio', label: string) => (
    <Stack key={key} direction="row" alignItems="center" justifyContent="space-between" sx={{ py: 0.75 }}>
      <Checkbox
        checked={s[key] ?? false}
        disabled={disabled}
        label={label}
        onChange={event => update({ [key]: event.target.checked })}
        slotProps={{ input: { 'data-testid': `studio-setting-${key}` } }}
      />
      {s[key] !== undefined && (
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          disabled={disabled}
          onClick={() => update({ [key]: undefined })}
        >
          Reset
        </Button>
      )}
    </Stack>
  );
  const image = catalog.images.find(model => model.id === s.model);
  const video = catalog.videos.find(model => model.id === s.model);
  const music = catalog.music.find(model => model.id === s.model);
  const referenceMax = draft.kind === 'image' ? (image?.capabilities.modes.generate?.inputs.reference?.max ?? 0) : 1;
  latest.current = { draft, disabled, edit, referenceMax };
  const uploadReference = async () => {
    const started = latest.current;
    if (!started || !controller.uploadReference) return;
    setUploading(true);
    setError(null);
    try {
      const reference = await controller.uploadReference();
      if (!reference || !mounted.current) return;
      const current = latest.current;
      if (
        !current ||
        current.disabled ||
        current.draft.sessionId !== started.draft.sessionId ||
        current.draft.workspaceId !== started.draft.workspaceId ||
        current.draft.revision !== started.draft.revision ||
        current.draft.kind !== started.draft.kind ||
        current.draft.settings.model !== started.draft.settings.model ||
        current.draft.settings.mode !== started.draft.settings.mode ||
        (current.draft.settings.references?.length ?? 0) >= current.referenceMax
      ) {
        setError(
          'The reference was uploaded to Files. Settings changed while it uploaded; review them before adding it.'
        );
        return;
      }
      current.edit({
        ...current.draft,
        settings: { ...current.draft.settings, references: [...(current.draft.settings.references ?? []), reference] },
      });
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Upload failed.');
    } finally {
      if (mounted.current) setUploading(false);
    }
  };
  const references =
    (draft.kind === 'image' && (referenceMax > 0 || s.references?.length)) ||
    (draft.kind === 'video' && (s.mode === 'image_to_video' || s.references?.length));
  return (
    <Stack spacing={2} data-testid={part === 'model' ? 'studio-model-picker' : 'studio-model-settings'}>
      {part !== 'options' && (
        <>
          {draft.kind === 'image' &&
            select(
              'model',
              'Image model',
              catalog.images.map(model => ({ value: model.id, label: model.name }))
            )}
          {draft.kind === 'video' &&
            select(
              'model',
              'Video model',
              catalog.videos.map(model => ({ value: model.id, label: model.display_name }))
            )}
          {draft.kind === 'music' &&
            select(
              'model',
              'Music model',
              catalog.music.map(model => ({ value: model.id, label: model.display_name }))
            )}
          {draft.kind === 'speech' &&
            select(
              'provider',
              'Voice provider',
              catalog.speech.map(value => ({ value, label: value === 'openai' ? 'OpenAI' : 'ElevenLabs' }))
            )}
          {draft.kind === 'sound-effect' && (
            <Typography level="body-xs" textColor="text.tertiary">
              ElevenLabs Sound Effects
            </Typography>
          )}
        </>
      )}
      {part !== 'model' && (
        <>
          {draft.kind === 'image' && (
            <>
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 1.5 }}>
                {select(
                  'count',
                  'Images',
                  [1, 2, 3, 4].map(value => ({ value: String(value), label: String(value) })),
                  '1'
                )}
                {image &&
                  (() => {
                    const sizing = image.capabilities.sizing;
                    const sizes = 'presets' in sizing ? sizing.presets : [];
                    return (sizes.length > 0 || s.size) && select('size', 'Size', choices(sizes));
                  })()}
                {image &&
                  (image.capabilities.qualities.length > 0 || s.quality) &&
                  select('quality', 'Quality', choices(image.capabilities.qualities))}
                {image &&
                  (() => {
                    const ratios = image.capabilities.modes.generate?.aspectRatios;
                    return (
                      (ratios || s.aspectRatio) &&
                      select(
                        'aspectRatio',
                        'Aspect ratio',
                        choices(ratios?.kind === 'discrete' ? ratios.values : ['1:1', '4:3', '3:4', '16:9', '9:16'])
                      )
                    );
                  })()}
              </Box>
            </>
          )}
          {draft.kind === 'video' && (
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 1.5 }}>
              {select(
                'mode',
                'Mode',
                (video?.modes ?? ['text_to_video', 'image_to_video']).map(value => ({
                  value,
                  label: value === 'image_to_video' ? 'Image to video' : 'Text to video',
                })),
                'text_to_video'
              )}
              {number(
                'durationSeconds',
                'Duration (seconds)',
                video?.duration.kind === 'range' ? video.duration.min : Math.min(...(video?.duration.values ?? [1])),
                video?.duration.kind === 'range' ? video.duration.max : Math.max(...(video?.duration.values ?? [30]))
              )}
              {select('aspectRatio', 'Aspect ratio', choices(video?.aspect_ratios ?? []))}
              {select('resolution', 'Resolution', choices(video?.resolutions ?? []))}
              {(video?.audio === 'optional' || s.audio !== undefined) && toggle('audio', 'Include audio')}
              {video?.audio !== 'optional' && (
                <Typography level="body-xs">{video?.audio === 'always' ? 'Audio included' : 'Silent video'}</Typography>
              )}
            </Box>
          )}
          {draft.kind === 'music' && (
            <>
              {toggle('instrumental', 'Instrumental')}
              {music?.vocals === 'never' && (
                <Typography level="body-xs">This model supports instrumental music only.</Typography>
              )}
              <FormControl disabled={disabled}>
                <FormLabel>Lyrics</FormLabel>
                <Textarea
                  minRows={4}
                  placeholder="Optional lyrics"
                  value={s.lyrics ?? ''}
                  onChange={event => update({ lyrics: event.target.value || undefined })}
                  slotProps={{ textarea: { 'data-testid': 'studio-setting-lyrics' } }}
                />
              </FormControl>
              {number(
                'durationSeconds',
                music?.duration.control === 'approximate' ? 'Approximate duration (seconds)' : 'Duration (seconds)',
                music?.duration.control === 'fixed' ? music.duration.seconds : (music?.duration.min ?? 1),
                music?.duration.control === 'fixed' ? music.duration.seconds : (music?.duration.max ?? 600)
              )}
            </>
          )}
          {draft.kind === 'speech' && (
            <>
              {select(
                'voice',
                'Voice',
                s.provider === 'elevenlabs'
                  ? catalog.voices.map(voice => ({ value: voice.id, label: voice.name }))
                  : AVAILABLE_TTS_VOICES.map(voice => ({ value: voice.value, label: voice.label }))
              )}
              {select('format', 'Output format', choices(VOICE_VENDOR_SUPPORTED_FORMATS[s.provider ?? 'openai']))}
              <Box component="details">
                <Typography component="summary" level="body-sm" sx={{ cursor: 'pointer', mb: 1 }}>
                  Advanced voice settings
                </Typography>
                <Stack spacing={1.5}>
                  {text('model', 'Voice model (optional)')}
                  {text('languageCode', 'Language code (e.g. en)')}
                  {number('stability', 'Stability', 0, 1, 0.05)}
                  {number('similarityBoost', 'Similarity', 0, 1, 0.05)}
                </Stack>
              </Box>
            </>
          )}
          {draft.kind === 'sound-effect' && (
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 1.5 }}>
              {number('durationSeconds', 'Duration (seconds)', 0.5, 30, 0.5)}
              {number('promptInfluence', 'Prompt influence', 0, 1, 0.05)}
              {text('format', 'Output format (optional)')}
            </Box>
          )}
          {references && (
            <Stack spacing={1}>
              <Typography sx={studioMicroLabelSx}>
                {draft.kind === 'video' ? 'First frame' : 'Reference images'}
              </Typography>
              {s.references?.map(reference => (
                <Stack key={reference.fileId} direction="row" alignItems="center" justifyContent="space-between">
                  <Typography level="body-xs" noWrap>
                    {reference.name}
                  </Typography>
                  <Button
                    size="sm"
                    variant="outlined"
                    color="neutral"
                    disabled={disabled}
                    onClick={() =>
                      update({ references: s.references?.filter(item => item.fileId !== reference.fileId) })
                    }
                  >
                    Remove
                  </Button>
                </Stack>
              ))}
              <Button
                size="sm"
                variant="outlined"
                color="neutral"
                loading={uploading}
                disabled={disabled || !controller.uploadReference || (s.references?.length ?? 0) >= referenceMax}
                data-testid="studio-upload-reference-btn"
                onClick={() => {
                  void uploadReference();
                }}
              >
                Upload reference to Files
              </Button>
            </Stack>
          )}
          {error && (
            <Alert color="danger" size="sm">
              {error}
            </Alert>
          )}
        </>
      )}
    </Stack>
  );
}
