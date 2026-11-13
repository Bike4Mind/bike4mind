import { ModelBackend } from './models';
import { IMAGE_MODEL_CATALOG } from './image/catalog';
import type { ImageProviderId } from './image/types';
import { VIDEO_MODEL_CATALOG } from './video/catalog';
import type { VideoProviderId } from './video/types';
import { ttsVendorOfModel } from './voicePricing';
import type { VoiceGenerationVendor } from './voiceGeneration';

const IMAGE_PROVIDER_BACKEND: Record<ImageProviderId, ModelBackend> = {
  openai: ModelBackend.OpenAI,
  bfl: ModelBackend.BFL,
  xai: ModelBackend.XAI,
  gemini: ModelBackend.Gemini,
};

// null marks a vendor with no ModelBackend member (as are ElevenLabs music and sound), so an org
// provider allowlist cannot name it and refuses its models.
const VIDEO_PROVIDER_BACKEND: Record<VideoProviderId, ModelBackend | null> = {
  test: null,
  'gemini-omni': ModelBackend.Gemini,
  xai: ModelBackend.XAI,
  veo: ModelBackend.Gemini,
  bfl: ModelBackend.BFL,
};

const TTS_VENDOR_BACKEND: Record<VoiceGenerationVendor, ModelBackend | null> = {
  openai: ModelBackend.OpenAI,
  elevenlabs: null,
};

/**
 * The backend serving a media (image, video, TTS, music, sound) model, for callers that have no catalog
 * entry for it. Undefined when the model is not a known media model or its vendor is not a ModelBackend.
 */
export function resolveMediaModelBackend(modelId: string): ModelBackend | undefined {
  if (Object.hasOwn(IMAGE_MODEL_CATALOG, modelId)) {
    return IMAGE_PROVIDER_BACKEND[IMAGE_MODEL_CATALOG[modelId as keyof typeof IMAGE_MODEL_CATALOG].provider];
  }
  if (Object.hasOwn(VIDEO_MODEL_CATALOG, modelId)) {
    return (
      VIDEO_PROVIDER_BACKEND[VIDEO_MODEL_CATALOG[modelId as keyof typeof VIDEO_MODEL_CATALOG].provider] ?? undefined
    );
  }
  const ttsVendor = ttsVendorOfModel(modelId);
  if (ttsVendor) return TTS_VENDOR_BACKEND[ttsVendor] ?? undefined;
  return undefined;
}
