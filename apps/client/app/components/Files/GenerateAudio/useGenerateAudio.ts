import { useCallback, useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import {
  VOICE_VENDOR_LABELS,
  type AudioSaveSkippedReason,
  type GeneratedAudioResponse,
  type TtsBase64Response,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { fabFileKeys } from '@client/app/hooks/data/fabFileKeys';
import { getErrorMessage } from '@client/app/utils/error';
import { toPlayableAudio } from '@client/app/utils/generatedAudio';
import { useAudioGenSettings } from '@client/app/stores/useAudioGenSettings';

export interface AudioGenerationResult {
  /** Playable URL: a blob: URL for inline audio, or a signed storage URL for audio too large to inline. */
  url: string;
  /** True when `url` is an object URL that must be revoked on cleanup. */
  isObjectUrl: boolean;
  saved: boolean;
  fabFileId?: string;
  contentType: string;
}

type AudioKind = 'Audio' | 'Sound effect';

const SAVE_SKIPPED_MESSAGES: Record<AudioSaveSkippedReason, (kind: AudioKind) => string> = {
  storage_limit: kind => `${kind} generated, but your storage is full so it was not saved to Files.`,
  file_too_large: kind => `${kind} generated, but it was too large to save to Files.`,
  error: kind => `${kind} generated, but saving to Files failed.`,
};

interface ParsedError {
  status?: number;
  message: string;
  /**
   * The message the SERVER sent, absent when the body carried none. `message`
   * above always has a value because it falls back to a synthesized "Error: 422",
   * which is useless in a toast - so a branch that wants to substitute its own
   * friendlier line has to read this instead.
   */
  bodyMessage?: string;
  errorCode?: string;
}

// Normalizes an axios failure into a status + message.
function parseError(error: unknown): ParsedError {
  if (!isAxiosError(error)) return { message: getErrorMessage(error) };

  const status = error.response?.status;
  const body = (error.response?.data ?? {}) as {
    error?: string;
    message?: string;
    errorCode?: string;
    additionalInfo?: { errorCode?: string };
  };

  const bodyMessage = body.error || body.message || undefined;

  return {
    status,
    message: bodyMessage ?? getErrorMessage(error),
    bodyMessage,
    errorCode: body.additionalInfo?.errorCode ?? body.errorCode,
  };
}

/**
 * Drives the in-app audio generator (#1055): calls the existing TTS /
 * sound-effects endpoints with the current useAudioGenSettings, exposes a
 * playable result, refreshes the File Browser when audio was persisted, and
 * surfaces the insufficient-credit / no-key / over-quota / too-large states.
 */
export function useGenerateAudio() {
  const queryClient = useQueryClient();
  const [isGenerating, setIsGenerating] = useState(false);
  const [result, setResult] = useState<AudioGenerationResult | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  useEffect(() => releaseObjectUrl, [releaseObjectUrl]);

  const clearResult = useCallback(() => {
    releaseObjectUrl();
    setResult(null);
  }, [releaseObjectUrl]);

  const refreshFiles = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: fabFileKeys.all });
  }, [queryClient]);

  const notifySaveOutcome = useCallback(
    (data: GeneratedAudioResponse, kind: AudioKind) => {
      if (data.saved === true) {
        refreshFiles();
        toast.success(`${kind} generated and saved to your Files.`);
      } else if (data.saved === false && data.saveSkippedReason) {
        toast.info(SAVE_SKIPPED_MESSAGES[data.saveSkippedReason](kind));
      } else {
        toast.success(`${kind} generated.`);
      }
    },
    [refreshFiles]
  );

  const generate = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        toast.error('Enter some text to generate audio.');
        return;
      }

      const { mode, ttsProvider, voice, format, languageCode, durationSeconds, promptInfluence } =
        useAudioGenSettings.getState();

      setIsGenerating(true);
      releaseObjectUrl();
      setResult(null);

      try {
        const request =
          mode === 'tts'
            ? {
                path: '/api/ai/tts',
                body: {
                  text: trimmed,
                  provider: ttsProvider,
                  voice: voice || undefined,
                  format,
                  languageCode: ttsProvider === 'elevenlabs' && languageCode ? languageCode : undefined,
                  encoding: 'base64',
                },
              }
            : {
                path: '/api/ai/sound-effects',
                body: {
                  text: trimmed,
                  durationSeconds: durationSeconds ?? undefined,
                  promptInfluence,
                  encoding: 'base64',
                },
              };

        const response = await api.post<TtsBase64Response | GeneratedAudioResponse>(request.path, request.body, {
          validateStatus: status => status === 200,
          skipAuthRefresh: true,
          timeout: 60000,
        });

        const data = response.data;
        const playable = toPlayableAudio(data);
        if (playable.isObjectUrl) objectUrlRef.current = playable.url;
        setResult({
          ...playable,
          saved: data.saved === true,
          fabFileId: data.fabFileId,
          contentType: data.contentType,
        });

        // The server substituted a provider, so the voice will not be the one
        // selected. Say so before the outcome toast rather than letting an
        // unexplained voice change look like a bug.
        if ('fallbackFrom' in data && data.fallbackFrom && data.provider) {
          toast.info(
            `${VOICE_VENDOR_LABELS[data.fallbackFrom]} was unavailable, so this audio was generated with ` +
              `${VOICE_VENDOR_LABELS[data.provider]}.`
          );
        }

        notifySaveOutcome(data, mode === 'tts' ? 'Audio' : 'Sound effect');
      } catch (error) {
        const parsed = parseError(error);

        if (parsed.status === 413) {
          // Oversized audio normally comes back as a URL; a 413 means storing it failed too.
          toast.error('The generated audio was too large to return. Try again, or use shorter text.');
        } else if (parsed.errorCode === 'provider_rejected') {
          // A key is configured but the provider refused it, and no other
          // provider could cover for it: switching providers is the one thing
          // the user can act on themselves.
          toast.error(`${parsed.message}. Try a different provider in the audio settings.`);
        } else if (parsed.status === 401) {
          toast.error('No provider API key is configured. Ask your administrator to set one up.');
        } else if (parsed.errorCode === 'insufficient_credits') {
          // Prefer the server's specific "you have X, need Y" message when it
          // carries the figures (sound-effects and music routes). `bodyMessage`, not
          // `message`: the latter would substitute a bare "Error: 422".
          toast.error(parsed.bodyMessage ?? 'You do not have enough credits to generate this audio.');
        } else {
          toast.error(parsed.message);
        }
      } finally {
        setIsGenerating(false);
      }
    },
    [notifySaveOutcome, releaseObjectUrl]
  );

  return { generate, isGenerating, result, clearResult };
}
