import { baseApi } from '@server/middlewares/baseApi';
import {
  ttsRequestSchema,
  TTS_MAX_INPUT_CHARS,
  VOICE_VENDOR_SUPPORTED_FORMATS,
  UnprocessableEntityError,
  VoiceGenerationVendor,
} from '@bike4mind/common';
import { TtsProviderNotConfiguredError } from '@server/utils/resolveTtsProvider';
import { synthesizeTts, upstreamStatus, isCredentialRejection } from '@server/utils/synthesizeTts';
import { exceedsTtsResponseLimit, TTS_RESPONSE_TOO_LARGE_MESSAGE } from '@server/utils/ttsResponseLimit';
import {
  assertTtsCreditsAvailable,
  deductTtsCredits,
  InsufficientTtsCreditsError,
} from '@server/utils/deductTtsCredits';
import { persistGeneratedAudio } from '@server/utils/persistGeneratedAudio';

const DEFAULT_PROVIDER: VoiceGenerationVendor = 'openai';

/**
 * Unified, multi-provider Text-to-Speech endpoint (#724).
 *
 * Body: { text, provider?, model?, voice?, format?, encoding?, stability?, similarityBoost?, languageCode? }
 * - provider defaults to openai; model/voice/format fall back to per-provider defaults.
 * - encoding 'binary' (default) streams raw audio bytes with an audio/* Content-Type;
 *   'base64' returns JSON { audio, format, contentType }.
 * - when the chosen provider has no usable key or rejects our credentials, another
 *   configured provider stands in (see synthesizeTts) and the response reports the
 *   substitution via { provider, fallbackFrom } / the X-B4M-Tts-Provider* headers.
 *
 * Mirrors the multi-vendor image API (aiImageService). The legacy
 * /api/ai/text-to-speech and /api/elabs/text-to-speech routes remain as thin
 * adapters over the same aiVoiceService abstraction.
 */
const handler = baseApi().post(async (req, res) => {
  const { text, provider, model, voice, format, encoding, stability, similarityBoost, languageCode, preview } =
    ttsRequestSchema.parse(req.body);

  const vendor = provider ?? DEFAULT_PROVIDER;

  const maxChars = TTS_MAX_INPUT_CHARS[vendor];
  if (text.length > maxChars) {
    throw new UnprocessableEntityError(
      `Input exceeds the ${vendor} limit of ${maxChars} characters (got ${text.length})`
    );
  }

  // Reject an unsupported (vendor, format) pair up front: without this the
  // vendor service throws mid-synthesis and the catch below maps it to a
  // generic 502, hiding the fact that the caller's format choice is the
  // problem. Validating here fails fast with an actionable 422 and before any
  // provider cost is incurred. (Undefined format falls back to each vendor's
  // mp3 default, which every provider supports.)
  if (format && !VOICE_VENDOR_SUPPORTED_FORMATS[vendor].includes(format)) {
    throw new UnprocessableEntityError(
      `The ${vendor} provider does not support the '${format}' output format ` +
        `(supported: ${VOICE_VENDOR_SUPPORTED_FORMATS[vendor].join(', ')})`
    );
  }

  // Pre-flight credit gate: reject before incurring provider cost.
  const userId = req.user?.id;
  if (userId) {
    try {
      await assertTtsCreditsAvailable(userId);
    } catch (error) {
      if (error instanceof InsufficientTtsCreditsError) {
        return res.status(402).json({ error: error.message, provider: vendor });
      }
      throw error;
    }
  }

  try {
    const synthesized = await synthesizeTts({
      provider: vendor,
      text,
      userId,
      requestedVoice: voice,
      preferredVoice: req.user?.preferredVoice,
      model,
      format,
      stability,
      similarityBoost,
      languageCode,
      logger: req.logger,
    });
    // usedVendor is the provider that actually produced the audio: synthesizeTts
    // may stand in another one, and billing/reporting must follow the vendor
    // that did the work.
    const { result, fallbackFrom, vendor: usedVendor } = synthesized;

    // A substituted provider means a different voice, so the caller is always
    // told. Header form too, for the binary encoding, which has no JSON body.
    const providerInfo = fallbackFrom ? { provider: usedVendor, fallbackFrom } : undefined;
    if (fallbackFrom) {
      res.setHeader('X-B4M-Tts-Provider', usedVendor);
      res.setHeader('X-B4M-Tts-Provider-Fallback-From', fallbackFrom);
    }

    // Charge for the successful synthesis. Done before the size guard below
    // because the provider cost is already incurred regardless of whether we
    // can return the bytes over this endpoint.
    if (userId) {
      await deductTtsCredits({
        userId,
        vendor: usedVendor,
        model: result.model,
        characters: result.characters,
        logger: req.logger,
      });
    }

    // Persist a browsable copy of the audio. On by default; a user can opt out
    // via the saveGeneratedAudio preference, and the Settings voice-audition
    // player passes preview:true to skip throwaway previews. Best-effort: a save
    // failure (e.g. over quota) never blocks returning the audio already paid for.
    const shouldSave = !preview && !!userId && (req.user?.preferences?.saveGeneratedAudio ?? true);
    const save = shouldSave
      ? await persistGeneratedAudio({
          userId: userId!,
          audio: result.audio,
          contentType: result.contentType,
          format: result.format,
          source: 'tts',
          text,
          logger: req.logger,
        })
      : undefined;

    const saveInfo = save
      ? save.saved
        ? ({ saved: true, fabFileId: save.fabFileId, fileUrl: save.fileUrl } as const)
        : ({ saved: false, saveSkippedReason: save.reason } as const)
      : undefined;

    if (saveInfo) {
      res.setHeader('X-B4M-Audio-Saved', String(saveInfo.saved));
      if (saveInfo.saved) res.setHeader('X-B4M-Audio-Fab-File-Id', saveInfo.fabFileId);
    }

    // Serverless response-size guard: a buffered audio body over ~4MB exceeds the
    // Lambda/API Gateway payload cap and would fail as an opaque CloudFront 502.
    // If a browsable copy was saved, the caller can still retrieve the audio from
    // its FabFile url instead of hitting a dead end (partially addresses #745).
    if (exceedsTtsResponseLimit(result.audio.length)) {
      return res.status(413).json({
        error: TTS_RESPONSE_TOO_LARGE_MESSAGE,
        provider: usedVendor,
        ...(saveInfo?.saved ? { saved: true, fabFileId: saveInfo.fabFileId, fileUrl: saveInfo.fileUrl } : {}),
      });
    }

    if (encoding === 'base64') {
      return res.json({
        audio: result.audio.toString('base64'),
        format: result.format,
        contentType: result.contentType,
        ...(saveInfo ?? {}),
        ...(providerInfo ?? {}),
      });
    }

    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Length', result.audio.length);
    return res.send(result.audio);
  } catch (error) {
    // No provider is usable (the requested one and every alternate lack a key).
    // errorCode lets the client separate this from a configured-but-rejected
    // key, which needs different advice.
    if (error instanceof TtsProviderNotConfiguredError) {
      return res.status(401).json({ error: error.message, errorCode: 'provider_not_configured' });
    }

    // Pass through client-actionable upstream errors (bad voice/param, invalid
    // key, rate limit) with a generic body so the provider's raw error text
    // never leaks; treat everything else as an upstream (502) failure.
    const status = upstreamStatus(error);
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return res.status(status).json({
        error: `TTS request rejected by the ${vendor} provider`,
        provider: vendor,
        // Reaching here on a credential rejection means no alternate could
        // cover for it either, so the actionable next step is a different
        // provider (or a fixed key), not a different request.
        ...(isCredentialRejection(error) ? { errorCode: 'provider_rejected' } : {}),
      });
    }
    req.logger.error('TTS synthesis failed', { error, provider: vendor });
    return res.status(502).json({ error: 'Failed to generate speech', provider: vendor });
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
