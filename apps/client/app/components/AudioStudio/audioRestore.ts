import { z } from 'zod';
import {
  soundEffectsRequestSchema,
  supportedVoiceGenerationVendor,
  ttsLanguageCodeSchema,
  TTS_DEFAULT_MODEL,
  VOICE_VENDOR_LABELS,
  VOICE_VENDOR_SUPPORTED_FORMATS,
  voiceOutputFormatSchema,
  type VoiceGenerationVendor,
} from '@bike4mind/common';
import {
  readStoredField,
  type Restored,
  type StudioRestoreRequest,
} from '@client/app/components/Studio/restore/studioRestore';
import type { AudioGenMode, AudioGenSettingValues } from '@client/app/stores/useAudioGenSettings';

export type RestoredAudioForm = {
  text: string;
  settings: Partial<AudioGenSettingValues>;
};

const sfxShape = soundEffectsRequestSchema.shape;

function restoreSpeech(
  request: Record<string, unknown>,
  usableProviders: readonly VoiceGenerationVendor[],
  notices: string[]
): Partial<AudioGenSettingValues> {
  const provider = readStoredField(
    supportedVoiceGenerationVendor.optional(),
    request.provider,
    undefined,
    'provider',
    notices
  );
  if (provider === undefined) return {};
  if (!usableProviders.includes(provider)) {
    // A voice and format belong to their provider, so none of them carry over to another one.
    notices.push(
      `${VOICE_VENDOR_LABELS[provider]} is no longer available to you, so the voice settings were left as they are.`
    );
    return {};
  }
  if (typeof request.model === 'string' && request.model !== TTS_DEFAULT_MODEL[provider]) {
    notices.push(`Studio speaks with ${TTS_DEFAULT_MODEL[provider]}; the take used ${request.model}.`);
  }
  if (request.stability !== undefined || request.similarityBoost !== undefined) {
    notices.push("Studio does not set stability or similarity, so the provider's defaults are used.");
  }
  const format = readStoredField(voiceOutputFormatSchema.optional(), request.format, undefined, 'format', notices);
  const formatSupported = format === undefined || VOICE_VENDOR_SUPPORTED_FORMATS[provider].includes(format);
  if (!formatSupported) notices.push(`${VOICE_VENDOR_LABELS[provider]} no longer produces ${format}, so mp3 is used.`);
  return {
    ttsProvider: provider,
    voice: readStoredField(z.string(), request.voice, '', 'voice', notices),
    format: format !== undefined && formatSupported ? format : 'mp3',
    languageCode: readStoredField(ttsLanguageCodeSchema, request.languageCode, '', 'language', notices) ?? '',
  };
}

function restoreSoundEffect(request: Record<string, unknown>, notices: string[]): Partial<AudioGenSettingValues> {
  if (request.format !== undefined) {
    notices.push("Studio does not set a sound effect's format, so the default is used.");
  }
  const promptInfluence = readStoredField(
    sfxShape.promptInfluence,
    request.promptInfluence,
    undefined,
    'prompt influence',
    notices
  );
  return {
    durationSeconds:
      readStoredField(sfxShape.durationSeconds, request.durationSeconds, undefined, 'duration', notices) ?? null,
    ...(promptInfluence !== undefined && { promptInfluence }),
  };
}

/** The speech or sound-effect form for a stored request: its text, and the settings the audio tabs keep. */
export function restoreAudioForm(
  { request }: StudioRestoreRequest,
  mode: AudioGenMode,
  usableProviders: readonly VoiceGenerationVendor[]
): Restored<RestoredAudioForm> {
  const notices: string[] = [];
  const text = readStoredField(z.string(), request.text, '', 'text', notices);
  const settings =
    mode === 'tts' ? restoreSpeech(request, usableProviders, notices) : restoreSoundEffect(request, notices);
  return { value: { text, settings }, notices };
}
