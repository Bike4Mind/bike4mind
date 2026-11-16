import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import {
  synthesizeSpeechContract,
  VOICE_VENDOR_SUPPORTED_FORMATS,
  UnauthorizedError,
  UnprocessableEntityError,
  DEFAULT_TTS_PROVIDER,
  REQUEST_TIMEOUT_ERROR_CODE,
  shouldPersistGeneratedAudio,
  type ApiErrorCode,
  type GenerationJobSource,
  type IGenerationJobDocumentOf,
  type VoiceGenerationVendor,
  type VoiceOutputFormat,
} from '@bike4mind/common';
import { createSpeechJob, inlineMinStepMs } from '@bike4mind/services/audioJobs';
import { getCreateSpeechJobDeps, readAudioJobOutput } from '@bike4mind/server-utils/generationJobs/audioJobWiring';
import { adminRoleWithheldFor } from '@bike4mind/server-utils/auth/apiKeyAdminScope';
import { resolveAudioBillingOrgId } from '@server/billing/resolveAudioBillingOrgId';
import {
  awaitInlineAudioJob,
  createAudioJobKeepingAudioOnFullQuota,
  dailyLimitError,
  GENERATION_JOB_ID_HEADER,
  isRateLimitedFailure,
  prefersRespondAsync,
  providerStatusOf,
  retryAfterSecondsOf,
  savedCopyOf,
  STILL_GENERATING_MESSAGE,
} from '@server/generations/syncAudioJob';
import { mapperDeps } from '@server/generations/routeDeps';
import { SPEECH_GENERATION_PROJECTION, toPublicGenerationJob } from '@server/generations/toPublicGenerationJob';
import { deliverGeneratedAudio } from '@server/utils/generatedAudioDelivery';
import { assertAiAccessAllowed } from '@bike4mind/server-utils/auth/assertAiAccessAllowed';

/**
 * Unified, multi-provider Text-to-Speech endpoint (#724).
 *
 * Body: { text, provider?, model?, voice?, format?, encoding?, stability?, similarityBoost?, languageCode? }
 * - provider defaults to openai; model/voice/format fall back to per-provider defaults.
 * - generation, billing and the saved copy run as a speech job (createSpeechJob), stepped in this request; the
 *   response (encoding, oversized-audio URL, save headers) is written by the shared deliverGeneratedAudio. A clip
 *   that outlasts the request and is saving to Files lands there when done: a caller that sent
 *   `Prefer: respond-async` is answered 202 with the speech job resource (and `Preference-Applied`), any other
 *   caller 504 naming the job, which keeps running. One not saving to Files could never be picked up, so its
 *   job is cancelled and the request answered 504.
 * - when the chosen provider has no usable key or rejects our credentials, another configured provider stands in
 *   and the response reports the substitution via { provider, fallbackFrom } / the X-B4M-Tts-Provider* headers.
 *
 * Auth mode and request validation come from synthesizeSpeechContract (the same source of truth that drives the
 * OpenAPI spec), so `req.validated` is the parsed, typed body.
 */
const handler = nextRouteForContract(synthesizeSpeechContract).post(async (req, res) => {
  assertAiAccessAllowed(req.user);
  const user = req.user;
  if (!user) throw new UnauthorizedError('User not found');
  const {
    text,
    provider,
    model,
    voice,
    format,
    encoding,
    stability,
    similarityBoost,
    languageCode,
    preview,
    organization_id,
  } = req.validated;
  const vendor = provider ?? DEFAULT_TTS_PROVIDER;

  // Omitted keeps the historical personal default; a key bills its own account (resolveAudioBillingOrgId 403s any
  // other target). Undefined is a user-billed key, which bills the user.
  const billingOrganizationId = await resolveAudioBillingOrgId(req, organization_id, 'user');
  // As the v1 media routes: 'studio' is any first-party session.
  const source: GenerationJobSource = req.apiKeyInfo ? 'api' : 'studio';
  const created = await createAudioJobKeepingAudioOnFullQuota(
    saveToFiles =>
      createSpeechJob(
        {
          user: {
            id: user.id,
            organizationId: billingOrganizationId ?? null,
            adminRoleWithheld: adminRoleWithheldFor(req.apiKeyInfo),
          },
          request: { text, provider: vendor, model, voice, format, stability, similarityBoost, languageCode },
          source,
          apiKeyId: req.apiKeyInfo?.keyId,
          saveToFiles,
          preferredVoice: user.preferredVoice,
        },
        getCreateSpeechJobDeps()
      ),
    shouldPersistGeneratedAudio({ userId: user.id, preview })
  );
  const { result } = created;

  if (!result.ok) {
    switch (result.code) {
      case 'insufficient_credits':
        // 422 + the `insufficient_credits` classifier, same as every other credit-metered endpoint. The classifier
        // is what separates this from a validation 422, which shares the status but carries no errorCode.
        return res.status(422).json({
          error: result.message,
          provider: vendor,
          errorCode: 'insufficient_credits' satisfies ApiErrorCode,
        });
      case 'model_unavailable':
        // No provider is usable (the requested one and every alternate lack a key). errorCode separates this from
        // a configured-but-rejected key, which needs different advice.
        return res
          .status(401)
          .json({ error: result.message, errorCode: 'provider_not_configured' satisfies ApiErrorCode });
      case 'daily_limit_reached':
        throw dailyLimitError(result);
      default:
        throw new UnprocessableEntityError(result.message);
    }
  }

  const waited = await awaitInlineAudioJob(result.job.id, 'speech', {
    receivedAt: req.receivedAt,
    minStepMs: inlineMinStepMs('speech'),
  });
  switch (waited.status) {
    case 'gone':
      req.logger.error('TTS job vanished during the inline wait', { jobId: result.job.id, provider: vendor });
      return res.status(502).json({ error: 'Failed to generate speech', provider: vendor });
    case 'outlasting':
      req.logger.warn('TTS job did not finish in time; it continues in the background', {
        jobId: waited.job.id,
        provider: vendor,
      });
      if (!prefersRespondAsync(req)) {
        res.setHeader(GENERATION_JOB_ID_HEADER, waited.job.id);
        return res.status(504).json({
          error: STILL_GENERATING_MESSAGE,
          provider: vendor,
          errorCode: REQUEST_TIMEOUT_ERROR_CODE,
          jobId: waited.job.id,
        });
      }
      res.setHeader('Preference-Applied', 'respond-async');
      return res.status(202).json(await toPublicGenerationJob(waited.job, mapperDeps, SPEECH_GENERATION_PROJECTION));
    case 'unretrievable':
      req.logger.warn('TTS job did not finish in time and is not saved to Files; cancel requested', {
        jobId: waited.job.id,
        cancel: waited.cancel,
        provider: vendor,
      });
      return res.status(504).json({
        error: 'Speech generation took too long',
        provider: vendor,
        errorCode: REQUEST_TIMEOUT_ERROR_CODE,
      });
    case 'ended':
      break;
  }
  const { job } = waited;

  switch (job.state) {
    case 'succeeded':
      break;
    case 'blocked':
      return res.status(422).json({ error: `TTS request rejected by the ${vendor} provider`, provider: vendor });
    case 'failed': {
      const failure = failedResponse(job, vendor);
      if (failure.status === 502) {
        req.logger.error('TTS synthesis failed', { jobId: job.id, error: job.error, provider: vendor });
      }
      if (failure.status === 429) res.setHeader('Retry-After', String(retryAfterSecondsOf(job)));
      return res.status(failure.status).json(failure.body);
    }
    default:
      req.logger.error('TTS job ended without audio', { jobId: job.id, state: job.state, provider: vendor });
      return res.status(502).json({ error: 'Failed to generate speech', provider: vendor });
  }

  const { output, producedBy } = job.payload;
  if (!output) {
    req.logger.error('TTS job succeeded without an output', { jobId: job.id, provider: vendor });
    return res.status(502).json({ error: 'Failed to generate speech', provider: vendor });
  }
  let audio: Buffer;
  try {
    audio = await readAudioJobOutput(output);
  } catch (error) {
    // The clip exists and is billed; it stays in the caller's Files when it was saved there.
    req.logger.error('TTS job output could not be read back', { jobId: job.id, error, provider: vendor });
    return res.status(502).json({ error: 'Failed to generate speech', provider: vendor });
  }
  const usedVendor = producedBy?.provider ?? vendor;
  const fallbackFrom = usedVendor !== vendor ? vendor : undefined;

  // A substituted provider means a different voice, so the caller is always told. Header form too, for the binary
  // encoding, which has no JSON body.
  if (fallbackFrom) {
    res.setHeader('X-B4M-Tts-Provider', usedVendor);
    res.setHeader('X-B4M-Tts-Provider-Fallback-From', fallbackFrom);
  }

  return deliverGeneratedAudio(res, {
    audio,
    contentType: output.contentType,
    encoding: encoding ?? 'binary',
    save: created.quotaSkip ?? (await savedCopyOf(output, created.saveToFiles)),
    fields: {
      format: formatUsed(usedVendor, format, Boolean(fallbackFrom)),
      ...(fallbackFrom && { provider: usedVendor, fallbackFrom }),
    },
    tooLargeFields: { provider: usedVendor },
    logger: req.logger,
  });
});

// Every vendor's default container.
const DEFAULT_TTS_FORMAT: VoiceOutputFormat = 'mp3';

/** The container the clip was made in: an alternate drops a format it cannot produce for its default (see speechJobHandler). */
function formatUsed(
  vendor: VoiceGenerationVendor,
  requested: VoiceOutputFormat | undefined,
  isFallback: boolean
): VoiceOutputFormat {
  if (!requested) return DEFAULT_TTS_FORMAT;
  if (isFallback && !VOICE_VENDOR_SUPPORTED_FORMATS[vendor].includes(requested)) return DEFAULT_TTS_FORMAT;
  return requested;
}

/**
 * Folds a failed job onto a status tts.contract.ts documents, with a generic body so the provider's raw error text
 * never leaks: a credential rejection (401 or 403) is a 401, a provider rate limit stays a 429, any other rejection
 * of the request (bad voice, bad parameter) is a 422, and anything else is an upstream 502.
 */
function failedResponse(
  job: IGenerationJobDocumentOf<'speech'>,
  vendor: VoiceGenerationVendor
): { status: 401 | 422 | 429 | 502; body: Record<string, unknown> } {
  const rejected = { error: `TTS request rejected by the ${vendor} provider`, provider: vendor };
  const status = providerStatusOf(job);
  if (isRateLimitedFailure(job)) return { status: 429, body: rejected };
  // Reaching here on a credential rejection means no alternate could cover for it either, so the actionable next
  // step is a different provider (or a fixed key), not a different request.
  if (status === 401 || status === 403) {
    return { status: 401, body: { ...rejected, errorCode: 'provider_rejected' satisfies ApiErrorCode } };
  }
  if (status !== undefined && status >= 400 && status < 500) return { status: 422, body: rejected };
  return { status: 502, body: { error: 'Failed to generate speech', provider: vendor } };
}

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
