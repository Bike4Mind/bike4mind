import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import {
  synthesizeSpeechContract,
  TTS_MAX_INPUT_CHARS,
  VOICE_VENDOR_SUPPORTED_FORMATS,
  UnprocessableEntityError,
  DEFAULT_TTS_PROVIDER,
  shouldPersistGeneratedAudio,
  type ApiErrorCode,
} from '@bike4mind/common';
import { TtsProviderNotConfiguredError } from '@server/utils/resolveTtsProvider';
import { synthesizeTts, upstreamStatus, isCredentialRejection } from '@server/utils/synthesizeTts';
import { deductTtsCredits } from '@server/utils/deductTtsCredits';
import { estimateTtsHoldCredits } from '@server/utils/ttsCandidates';
import {
  holdPreflightCredits,
  InsufficientCreditsPreflightError,
  type PreflightCreditHold,
} from '@server/utils/creditPreflight';
import { saveGeneratedAssetToFiles } from '@server/utils/saveGeneratedAssetToFiles';
import { deliverGeneratedAudio } from '@server/utils/generatedAudioDelivery';

/**
 * Unified, multi-provider Text-to-Speech endpoint (#724).
 *
 * Body: { text, provider?, model?, voice?, format?, encoding?, stability?, similarityBoost?, languageCode? }
 * - provider defaults to openai; model/voice/format fall back to per-provider defaults.
 * - the response (encoding, oversized-audio URL, save headers) is written by the
 *   shared deliverGeneratedAudio, like every generated-audio route.
 * - when the chosen provider has no usable key or rejects our credentials, another
 *   configured provider stands in (see synthesizeTts) and the response reports the
 *   substitution via { provider, fallbackFrom } / the X-B4M-Tts-Provider* headers.
 *
 * Mirrors the multi-vendor image API (aiImageService).
 *
 * Auth mode and request validation come from synthesizeSpeechContract (the same
 * source of truth that drives the OpenAPI spec), so `req.validated` is the parsed,
 * typed body.
 */
const handler = nextRouteForContract(synthesizeSpeechContract).post(async (req, res) => {
  const { text, provider, model, voice, format, encoding, stability, similarityBoost, languageCode, preview } =
    req.validated;

  const vendor = provider ?? DEFAULT_TTS_PROVIDER;

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

  // Hold the estimate before incurring provider cost, so concurrent calls cannot overdraw the balance.
  const userId = req.user?.id;
  let hold: PreflightCreditHold | undefined;
  if (userId) {
    try {
      hold = await holdPreflightCredits({
        userId,
        estimatedCredits: estimateTtsHoldCredits(vendor, model, text.length),
        featureLabel: 'text-to-speech',
        logger: req.logger,
      });
    } catch (error) {
      if (error instanceof InsufficientCreditsPreflightError) {
        // 422 + the `insufficient_credits` classifier, same as every other
        // credit-metered endpoint: one handler covers "out of credits" across the
        // surface. The classifier is what separates this from a validation 422,
        // which shares the status but carries no errorCode.
        return res.status(422).json({
          error: error.message,
          provider: vendor,
          errorCode: 'insufficient_credits' satisfies ApiErrorCode,
        });
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

    // Charge for the successful synthesis before delivery: the provider cost is
    // already incurred however the bytes end up being returned.
    if (hold) {
      const settling = hold;
      hold = undefined;
      await deductTtsCredits({
        hold: settling,
        userId,
        vendor: usedVendor,
        model: result.model,
        characters: result.characters,
        logger: req.logger,
      });
    }

    // Best-effort browsable copy, skipped only for a throwaway `preview` call: a
    // save failure never blocks returning audio the caller was already charged for.
    const save =
      userId && shouldPersistGeneratedAudio({ userId, preview })
        ? await saveGeneratedAssetToFiles(
            {
              userId,
              bytes: result.audio,
              contentType: result.contentType,
              generation: {
                generator: 'speech',
                provider: usedVendor,
                modelId: result.model,
                prompt: text,
                format: result.format,
                // A voice names a voice of the requested provider, so it is meaningless once another stood in.
                ...(voice && !fallbackFrom && { voice }),
                ...(languageCode && { languageCode }),
              },
            },
            req.logger
          )
        : undefined;

    return await deliverGeneratedAudio(res, {
      audio: result.audio,
      contentType: result.contentType,
      encoding: encoding ?? 'binary',
      save,
      fields: { format: result.format, ...providerInfo },
      tooLargeFields: { provider: usedVendor },
      logger: req.logger,
    });
  } catch (error) {
    // Still set only when synthesis failed before settlement: no provider cost was incurred.
    await hold?.release();

    // No provider is usable (the requested one and every alternate lack a key).
    // errorCode lets the client separate this from a configured-but-rejected
    // key, which needs different advice.
    if (error instanceof TtsProviderNotConfiguredError) {
      return res
        .status(401)
        .json({ error: error.message, errorCode: 'provider_not_configured' satisfies ApiErrorCode });
    }

    // Client-actionable upstream errors get a generic body so the provider's raw
    // error text never leaks; treat everything else as an upstream (502) failure.
    const status = upstreamStatus(error);
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return res.status(documentedStatusForUpstream4xx(error, status)).json({
        error: `TTS request rejected by the ${vendor} provider`,
        provider: vendor,
        // Reaching here on a credential rejection means no alternate could
        // cover for it either, so the actionable next step is a different
        // provider (or a fixed key), not a different request.
        ...(isCredentialRejection(error) ? { errorCode: 'provider_rejected' satisfies ApiErrorCode } : {}),
      });
    }
    req.logger.error('TTS synthesis failed', { error, provider: vendor });
    return res.status(502).json({ error: 'Failed to generate speech', provider: vendor });
  }
});

/**
 * Folds a provider 4xx onto a status tts.contract.ts documents, so a generated
 * client has a case for every response: a credential rejection (401 or 403) is a
 * 401, a provider rate limit stays a 429, and any other rejection of the request
 * (bad voice, bad parameter, oversized input) is a 422.
 */
function documentedStatusForUpstream4xx(error: unknown, status: number): 401 | 422 | 429 {
  if (isCredentialRejection(error)) return 401;
  if (status === 429) return 429;
  return 422;
}

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
