import {
  ImageJobRequestSchema,
  validateImageRequest,
  VOICE_VENDOR_SUPPORTED_FORMATS,
  TTS_MAX_INPUT_CHARS,
  estimateSoundCreditCost,
  type ImageModels,
  estimateTtsCreditCost,
  TTS_DEFAULT_MODEL,
} from '@bike4mind/common';
import { estimateImageUsd, resolveBilledImageQuality } from '@bike4mind/services/imageCost';
import { usdToCredits } from '@bike4mind/common';
import type { StudioCatalog, StudioDraft } from '@shared/studioIpc';
import { planVideoRequest } from '../media/videoModels';
import { planMusicRequest } from '../media/musicModels';
import { studioGenerationRequestSchema, type StudioGenerationRequest } from './generation/StudioGenerationService';

export function planStudioCreation(
  draft: StudioDraft,
  prompt: string,
  catalog: StudioCatalog
): { request: StudioGenerationRequest; estimatedCredits: number | null } {
  const s = draft.settings;
  const allowed = {
    image: ['model', 'count', 'size', 'aspectRatio', 'quality', 'references'],
    video: ['model', 'mode', 'durationSeconds', 'aspectRatio', 'resolution', 'audio', 'references'],
    music: ['model', 'durationSeconds', 'instrumental', 'lyrics'],
    speech: ['provider', 'model', 'voice', 'format', 'languageCode', 'stability', 'similarityBoost'],
    'sound-effect': ['provider', 'durationSeconds', 'promptInfluence', 'format'],
  }[draft.kind];
  const unsupported = Object.entries(s).filter(([key, value]) => value !== undefined && !allowed.includes(key));
  if (unsupported.length) throw new Error(`Reset unsupported settings: ${unsupported.map(([key]) => key).join(', ')}.`);
  if (draft.kind === 'image') {
    const model = catalog.images.find(model => model.id === s.model);
    if (!model) throw new Error('Choose an available image model.');
    const body = ImageJobRequestSchema.parse({
      model: model.id,
      mode: 'generate',
      prompt,
      size: s.size || undefined,
      aspectRatio: s.aspectRatio || undefined,
      quality: s.quality,
      inputs: s.references?.map(reference => ({ role: 'reference', fileId: reference.fileId })),
    });
    const checked = validateImageRequest({ ...body, count: 1 }, model.capabilities);
    if (!checked.ok) throw new Error(checked.failures.map(failure => failure.reason).join(' '));
    const count = s.count ?? 1;
    let estimatedCredits: number | null = null;
    try {
      const input = {
        model: model.id,
        quality: resolveBilledImageQuality(model.id as ImageModels, s.quality),
        size: s.size,
        inputImageCount: s.references?.length ?? 0,
      } as Parameters<typeof estimateImageUsd>[2];
      estimatedCredits = usdToCredits(estimateImageUsd(model.id as ImageModels, 1, input)) * count;
    } catch {
      /* A model without a price stays explicitly unknown. */
    }
    return { request: { kind: 'image', body, count }, estimatedCredits };
  }
  if (draft.kind === 'video') {
    const model = catalog.videos.find(model => model.id === s.model);
    if (!model) throw new Error('Choose an available video model.');
    const mode = s.mode ?? 'text_to_video';
    if (!model.modes.includes(mode)) throw new Error('This model does not support the selected mode.');
    if (mode === 'image_to_video' && s.references?.length !== 1) throw new Error('Choose one first-frame image.');
    if (mode === 'text_to_video' && s.references?.length)
      throw new Error('Remove the first frame or select image-to-video.');
    if (s.audio !== undefined && model.audio !== 'optional')
      throw new Error('Reset the audio setting; this model controls its own audio.');
    const plan = planVideoRequest(model, { prompt, withImage: mode === 'image_to_video', ...s });
    return {
      request: studioGenerationRequestSchema.parse({
        kind: 'video',
        body: {
          model: model.id,
          prompt,
          mode,
          duration_seconds: plan.request.durationSeconds,
          aspect_ratio: plan.request.aspectRatio,
          resolution: plan.request.resolution,
          audio: s.audio,
          input_image_file_id: mode === 'image_to_video' ? s.references?.[0].fileId : undefined,
        },
      }),
      estimatedCredits: plan.estimatedCredits,
    };
  }
  if (draft.kind === 'music') {
    const model = catalog.music.find(model => model.id === s.model);
    if (!model) throw new Error('Choose an available music model.');
    if (s.lyrics && (s.instrumental || model.vocals === 'never' || !model.lyrics))
      throw new Error('These lyrics require a vocal model with Instrumental turned off.');
    if (
      s.lyrics &&
      model.lyrics &&
      (s.lyrics.length > model.lyrics.max_chars ||
        (model.lyrics.max_line_chars &&
          s.lyrics.split(/\r?\n/).some(line => line.length > model.lyrics!.max_line_chars!)))
    )
      throw new Error("Lyrics exceed this model's supported length.");
    const plan = planMusicRequest(model, s);
    return {
      request: studioGenerationRequestSchema.parse({
        kind: 'music',
        body: {
          model: model.id,
          prompt,
          lyrics: s.lyrics || undefined,
          duration_seconds: plan.effectiveSeconds,
          instrumental: s.instrumental,
        },
      }),
      estimatedCredits: plan.estimatedCredits,
    };
  }
  const provider = s.provider ?? (draft.kind === 'speech' ? catalog.speech[0] : catalog.soundEffects[0]);
  if (!provider) throw new Error('No audio provider is available.');
  if (draft.kind === 'speech') {
    if (!catalog.speech.includes(provider)) throw new Error('Choose an available speech provider.');
    if (s.format && !VOICE_VENDOR_SUPPORTED_FORMATS[provider].includes(s.format as never))
      throw new Error('The selected provider does not support this format.');
    if (prompt.length > TTS_MAX_INPUT_CHARS[provider])
      throw new Error("The script exceeds this provider's character limit.");
    if (provider !== 'elevenlabs' && (s.stability !== undefined || s.similarityBoost !== undefined || s.languageCode))
      throw new Error('Reset ElevenLabs-only voice settings before using this provider.');
    return {
      request: studioGenerationRequestSchema.parse({
        kind: 'speech',
        body: {
          text: prompt,
          provider,
          model: s.model,
          voice: s.voice,
          format: s.format,
          stability: s.stability,
          similarityBoost: s.similarityBoost,
          languageCode: s.languageCode,
        },
      }),
      estimatedCredits: estimateTtsCreditCost(provider, s.model ?? TTS_DEFAULT_MODEL[provider], prompt.length),
    };
  }
  if (provider !== 'elevenlabs' || !catalog.soundEffects.includes(provider))
    throw new Error('Choose an available sound-effects provider.');
  return {
    request: studioGenerationRequestSchema.parse({
      kind: 'sound-effect',
      body: {
        text: prompt,
        provider,
        durationSeconds: s.durationSeconds,
        promptInfluence: s.promptInfluence,
        format: s.format,
      },
    }),
    estimatedCredits: estimateSoundCreditCost(provider, s),
  };
}
