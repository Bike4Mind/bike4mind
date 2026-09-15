import {
  supportedVoiceGenerationVendor,
  TTS_MAX_INPUT_CHARS,
  VOICE_VENDOR_SUPPORTED_FORMATS,
  VoiceGenerationVendor,
  VoiceOutputFormat,
} from '@bike4mind/common';
import { aiVoiceService, type VoiceSynthesisResult } from '@bike4mind/utils';
import { type Logger } from '@bike4mind/observability';
import { resolveTtsProvider, TtsProviderNotConfiguredError } from './resolveTtsProvider';

/**
 * HTTP status of an upstream provider failure. The OpenAI SDK exposes it as
 * `status`; axios (the ElevenLabs transport) puts it on `response.status`, so
 * both shapes have to be read or an ElevenLabs 4xx looks like a network error.
 */
export function upstreamStatus(error: unknown): number | undefined {
  const candidate = error as { status?: unknown; response?: { status?: unknown } } | null;
  const status = typeof candidate?.status === 'number' ? candidate.status : candidate?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * A provider rejecting our credentials is a property of the stored key, not of
 * the request, so another vendor may well succeed. Every other 4xx (bad voice,
 * bad model, rate limit) either belongs to the request or would recur, so those
 * are never retried elsewhere.
 */
export function isCredentialRejection(error: unknown): boolean {
  const status = upstreamStatus(error);
  return status === 401 || status === 403;
}

const isRecoverable = (error: unknown) =>
  error instanceof TtsProviderNotConfiguredError || isCredentialRejection(error);

// Alternates worth attempting after `primary` fails, in preference order. A
// vendor whose input ceiling is below this text is not a real alternate: it
// would only fail on length.
function alternatesFor(primary: VoiceGenerationVendor, text: string): VoiceGenerationVendor[] {
  return supportedVoiceGenerationVendor.options.filter(
    vendor => vendor !== primary && text.length <= TTS_MAX_INPUT_CHARS[vendor]
  );
}

// An alternate may not support the requested container; drop back to its own
// default (mp3) rather than turning a recovered request into a 422.
const formatFor = (vendor: VoiceGenerationVendor, format: VoiceOutputFormat | undefined) =>
  format && VOICE_VENDOR_SUPPORTED_FORMATS[vendor].includes(format) ? format : undefined;

export interface SynthesizeTtsArgs {
  provider: VoiceGenerationVendor;
  text: string;
  userId: string | undefined;
  requestedVoice?: string;
  preferredVoice?: string | null;
  model?: string;
  format?: VoiceOutputFormat;
  stability?: number;
  similarityBoost?: number;
  languageCode?: string;
  logger: Logger;
}

export interface SynthesizedTts {
  /** The vendor that actually produced the audio. */
  vendor: VoiceGenerationVendor;
  result: VoiceSynthesisResult;
  /** Set only when the requested vendor was unusable and `vendor` stood in for it. */
  fallbackFrom?: VoiceGenerationVendor;
}

/**
 * Synthesizes speech with the requested provider, degrading to another
 * configured provider when that one has no usable key or is rejected by the
 * upstream service. Mirrors the principle established for the embedding path:
 * an upstream credential failure should degrade rather than hard-fail.
 *
 * The substitution is never silent - callers must surface `fallbackFrom`, since
 * a different vendor means a different voice. If no candidate succeeds, the
 * requested provider's own error is thrown so the response still describes the
 * vendor the caller asked for.
 */
export async function synthesizeTts(args: SynthesizeTtsArgs): Promise<SynthesizedTts> {
  const { provider, text, logger } = args;
  const candidates: VoiceGenerationVendor[] = [provider, ...alternatesFor(provider, text)];
  let primaryError: unknown;

  for (const vendor of candidates) {
    const isAlternate = vendor !== provider;
    try {
      const resolved = await resolveTtsProvider({
        provider: vendor,
        userId: args.userId,
        // A requested voice belongs to the requested vendor's namespace (an
        // OpenAI voice name is not an ElevenLabs voiceId), so an alternate
        // resolves its own voice instead. preferredVoice is already scoped to
        // OpenAI inside resolveTtsProvider, so it passes through untouched.
        requestedVoice: isAlternate ? undefined : args.requestedVoice,
        preferredVoice: args.preferredVoice,
      });

      const result = await aiVoiceService(vendor, resolved.apiKey, logger).synthesize(text, {
        voice: resolved.voice,
        // model is vendor-specific too; let an alternate apply its default.
        model: isAlternate ? undefined : args.model,
        format: isAlternate ? formatFor(vendor, args.format) : args.format,
        stability: args.stability,
        similarityBoost: args.similarityBoost,
        language: args.languageCode,
      });

      return { vendor, result, ...(isAlternate ? { fallbackFrom: provider } : {}) };
    } catch (error) {
      if (!isRecoverable(error)) {
        // The requested vendor failed for a request-shaped reason: report it as
        // asked. An alternate failing this way still leaves the primary's
        // error as the one worth reporting.
        if (!isAlternate) throw error;
        logger.warn('TTS fallback provider failed', {
          vendor,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (!isAlternate) primaryError = error;
      logger.warn('TTS provider unusable', {
        vendor,
        willTryAlternate: !isAlternate && candidates.length > 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw primaryError;
}
