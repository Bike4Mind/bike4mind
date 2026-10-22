import {
  GENERATED_ASSET_GENERATOR_TAG,
  GeneratedAssetMetadataSchema,
  supportedVoiceGenerationVendor,
  VOICE_VENDOR_SUPPORTED_FORMATS,
  voiceOutputFormatSchema,
  type GeneratedAssetGenerator,
  type GeneratedAssetMetadata,
  type IFabFileDocument,
} from '@bike4mind/common';
import type { AudioGenMode, AudioGenSettingValues } from '@client/app/stores/useAudioGenSettings';

export const AUDIO_MODE_GENERATOR: Record<AudioGenMode, GeneratedAssetGenerator> = {
  tts: 'speech',
  'sound-effects': 'sound_effect',
};

/** The tag saveGeneratedAsset puts on this mode's files, which the recent-generations list filters on. */
export const audioModeTag = (mode: AudioGenMode): string => GENERATED_ASSET_GENERATOR_TAG[AUDIO_MODE_GENERATOR[mode]];

/** The generation provenance stamped on a generated file, or undefined for a file that carries none or a malformed one. */
export function readGeneration(file: Pick<IFabFileDocument, 'sourceMetadata'>): GeneratedAssetMetadata | undefined {
  const parsed = GeneratedAssetMetadataSchema.safeParse(file.sourceMetadata?.generation);
  return parsed.success ? parsed.data : undefined;
}

function speechSettings(generation: GeneratedAssetMetadata): Partial<AudioGenSettingValues> {
  const provider = supportedVoiceGenerationVendor.safeParse(generation.provider);
  if (!provider.success) return {};
  const format = voiceOutputFormatSchema.safeParse(generation.format);
  return {
    ttsProvider: provider.data,
    // Files saved before the settings were recorded fall back to the defaults the form would pick anyway.
    voice: generation.voice ?? '',
    format: format.success && VOICE_VENDOR_SUPPORTED_FORMATS[provider.data].includes(format.data) ? format.data : 'mp3',
    languageCode: generation.languageCode ?? '',
  };
}

function soundEffectSettings(generation: GeneratedAssetMetadata): Partial<AudioGenSettingValues> {
  return {
    durationSeconds: generation.durationSeconds ?? null,
    ...(generation.promptInfluence !== undefined && { promptInfluence: generation.promptInfluence }),
  };
}

/** The form settings that reproduce a generation, for "use these settings again". */
export function settingsFromGeneration(generation: GeneratedAssetMetadata): Partial<AudioGenSettingValues> {
  switch (generation.generator) {
    case 'speech':
      return speechSettings(generation);
    case 'sound_effect':
      return soundEffectSettings(generation);
    default:
      return {};
  }
}
