import { useCallback, useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { VOICE_VENDOR_LABELS, type VoiceGenerationVendor } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { getErrorMessage } from '@client/app/utils/error';
import { useAudioGenSettings } from '@client/app/stores/useAudioGenSettings';

export interface AudioGenerationResult {
  /** Playable URL: a blob: URL for generated audio, or a presigned file URL for large saved audio. */
  url: string;
  /** True when `url` is an object URL that must be revoked on cleanup. */
  isObjectUrl: boolean;
  saved: boolean;
  fabFileId?: string;
  contentType: string;
}

interface TtsBase64Response {
  audio: string;
  format: string;
  contentType: string;
  saved?: boolean;
  fabFileId?: string;
  fileUrl?: string;
  saveSkippedReason?: 'storage_limit' | 'file_too_large' | 'error';
  /** Present only when the selected provider was unusable and another stood in. */
  provider?: VoiceGenerationVendor;
  fallbackFrom?: VoiceGenerationVendor;
}

const SAVE_SKIPPED_MESSAGES: Record<NonNullable<TtsBase64Response['saveSkippedReason']>, string> = {
  storage_limit: 'Audio generated, but your storage is full so it was not saved to Files.',
  file_too_large: 'Audio generated, but it was too large to save to Files.',
  error: 'Audio generated, but saving to Files failed.',
};

interface ParsedError {
  status?: number;
  message: string;
  errorCode?: string;
  saved?: boolean;
  fabFileId?: string;
  fileUrl?: string;
}

// Normalizes an axios failure into a status + message, transparently parsing a
// JSON error body delivered as a Blob (the sound-effects route responds with
// responseType 'blob', so its error bodies arrive as blobs too).
async function parseError(error: unknown): Promise<ParsedError> {
  if (!isAxiosError(error)) return { message: getErrorMessage(error) };

  const status = error.response?.status;
  let payload: unknown = error.response?.data;
  if (payload instanceof Blob) {
    try {
      payload = JSON.parse(await payload.text());
    } catch {
      payload = undefined;
    }
  }

  const body = (payload ?? {}) as {
    error?: string;
    message?: string;
    errorCode?: string;
    additionalInfo?: { errorCode?: string };
    saved?: boolean;
    fabFileId?: string;
    fileUrl?: string;
  };

  return {
    status,
    message: body.error || body.message || getErrorMessage(error),
    errorCode: body.additionalInfo?.errorCode ?? body.errorCode,
    saved: body.saved,
    fabFileId: body.fabFileId,
    fileUrl: body.fileUrl,
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
    queryClient.invalidateQueries({ queryKey: ['fabFiles'] });
  }, [queryClient]);

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
        if (mode === 'tts') {
          const response = await api.post<TtsBase64Response>(
            '/api/ai/tts',
            {
              text: trimmed,
              provider: ttsProvider,
              voice: voice || undefined,
              format,
              languageCode: ttsProvider === 'elevenlabs' && languageCode ? languageCode : undefined,
              encoding: 'base64',
            },
            { validateStatus: status => status === 200, skipAuthRefresh: true, timeout: 60000 }
          );

          const data = response.data;
          // Play from a blob: URL, not a data: URL: the app CSP allows
          // `media-src blob:` but not `data:`, so a data: source renders in the
          // <audio> element but is blocked from actually playing. Mirrors the
          // sound-effects path, and objectUrlRef handles revocation.
          const bytes = Uint8Array.from(atob(data.audio), c => c.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], { type: data.contentType }));
          objectUrlRef.current = url;
          setResult({
            url,
            isObjectUrl: true,
            saved: data.saved === true,
            fabFileId: data.fabFileId,
            contentType: data.contentType,
          });

          // The server substituted a provider, so the voice will not be the one
          // selected. Say so before the outcome toast rather than letting an
          // unexplained voice change look like a bug.
          if (data.fallbackFrom && data.provider) {
            toast.info(
              `${VOICE_VENDOR_LABELS[data.fallbackFrom]} was unavailable, so this audio was generated with ` +
                `${VOICE_VENDOR_LABELS[data.provider]}.`
            );
          }

          if (data.saved === true) {
            refreshFiles();
            toast.success('Audio generated and saved to your Files.');
          } else if (data.saved === false && data.saveSkippedReason) {
            toast.info(SAVE_SKIPPED_MESSAGES[data.saveSkippedReason]);
          } else {
            toast.success('Audio generated.');
          }
        } else {
          const response = await api.post(
            '/api/ai/sound-effects',
            {
              text: trimmed,
              durationSeconds: durationSeconds ?? undefined,
              promptInfluence,
            },
            { responseType: 'blob', validateStatus: status => status === 200, skipAuthRefresh: true, timeout: 60000 }
          );

          const blob = response.data as Blob;
          const url = URL.createObjectURL(blob);
          objectUrlRef.current = url;

          const saved = response.headers['x-b4m-audio-saved'] === 'true';
          setResult({
            url,
            isObjectUrl: true,
            saved,
            fabFileId: response.headers['x-b4m-audio-fab-file-id'],
            contentType: blob.type || 'audio/mpeg',
          });

          if (saved) {
            refreshFiles();
            toast.success('Sound effect generated and saved to your Files.');
          } else {
            toast.success('Sound effect generated.');
          }
        }
      } catch (error) {
        const parsed = await parseError(error);

        // A too-large TTS body still persisted a browsable copy: surface the
        // saved file rather than a dead end (see #745 / ttsResponseLimit).
        if (parsed.status === 413 && parsed.saved && parsed.fileUrl) {
          setResult({
            url: parsed.fileUrl,
            isObjectUrl: false,
            saved: true,
            fabFileId: parsed.fabFileId,
            contentType: 'audio/mpeg',
          });
          refreshFiles();
          toast.info('Audio was too large to preview here, but it was saved to your Files.');
          return;
        }

        if (parsed.status === 413) {
          toast.error('The generated audio is too large to return. Try shorter text.');
        } else if (parsed.errorCode === 'provider_rejected') {
          // A key is configured but the provider refused it, and no other
          // provider could cover for it: switching providers is the one thing
          // the user can act on themselves.
          toast.error(`${parsed.message}. Try a different provider in the audio settings.`);
        } else if (parsed.status === 401) {
          toast.error('No provider API key is configured. Ask your administrator to set one up.');
        } else if (parsed.status === 402 || parsed.errorCode === 'insufficient_credits') {
          // Prefer the server's specific "you have X, need Y" message when it
          // carries the figures (sound-effects route); the plain 402 TTS body
          // has no such detail, so fall back to the generic line.
          toast.error(
            parsed.errorCode === 'insufficient_credits' && parsed.message
              ? parsed.message
              : 'You do not have enough credits to generate this audio.'
          );
        } else {
          toast.error(parsed.message);
        }
      } finally {
        setIsGenerating(false);
      }
    },
    [refreshFiles, releaseObjectUrl]
  );

  return { generate, isGenerating, result, clearResult };
}
