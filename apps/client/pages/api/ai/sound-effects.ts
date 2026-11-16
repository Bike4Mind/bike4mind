import {
  generateSoundEffectContract,
  REQUEST_TIMEOUT_ERROR_CODE,
  shouldPersistGeneratedAudio,
  UnauthorizedError,
  UnprocessableEntityError,
  type GenerationJobSource,
} from '@bike4mind/common';
import { ProviderBusyError } from '@bike4mind/services';
import { createSoundEffectJob, inlineMinStepMs } from '@bike4mind/services/audioJobs';
import { getCreateSoundEffectJobDeps, readAudioJobOutput } from '@bike4mind/server-utils/generationJobs/audioJobWiring';
import { adminRoleWithheldFor } from '@bike4mind/server-utils/auth/apiKeyAdminScope';
import { assertAiAccessAllowed } from '@bike4mind/server-utils/auth/assertAiAccessAllowed';
import { resolveAudioBillingOrgId } from '@server/billing/resolveAudioBillingOrgId';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import {
  awaitInlineAudioJob,
  createAudioJobKeepingAudioOnFullQuota,
  dailyLimitError,
  GENERATION_JOB_ID_HEADER,
  isRateLimitedFailure,
  prefersRespondAsync,
  retryAfterSecondsOf,
  savedCopyOf,
  STILL_GENERATING_MESSAGE,
} from '@server/generations/syncAudioJob';
import { providerBusyHttpError } from '@server/utils/providerBusyHttpError';
import { deliverGeneratedAudio } from '@server/utils/generatedAudioDelivery';
import { resolveRequestUsageSource } from '@bike4mind/server-utils/utils/resolveRequestUsageSource';
import { mapperDeps } from '@server/generations/routeDeps';
import { SOUND_EFFECT_GENERATION_PROJECTION, toPublicGenerationJob } from '@server/generations/toPublicGenerationJob';

const GENERATION_FAILED = { error: 'Sound generation failed' };

// Provider-agnostic sound-effects generation, run as a sound-effect job (createSoundEffectJob) stepped in this
// request: the job holds the duration-driven cost, settles it on success and returns it otherwise, records usage and
// keeps the saved copy. Bills the organization's shared pool for org-billed API keys and for org-seat members;
// otherwise the user. Scope-gated (AI_GENERATE) so an under-scoped API key can't drive paid provider generation.
// A clip that outlasts the request and is saving to Files lands there when done: a caller that sent
// `Prefer: respond-async` is answered 202 with the sound-effect job resource (and `Preference-Applied`), any other
// caller 504 naming the job, which keeps running. One not saving to Files could never be picked up, so its job is
// cancelled and the request answered 504.
//
// Auth mode, required scopes, and request validation all come from generateSoundEffectContract (the same source of
// truth that drives the OpenAPI spec); `req.validated` is the parsed, typed body.
const handler = nextRouteForContract(generateSoundEffectContract).post(async (req, res) => {
  assertAiAccessAllowed(req.user);
  const user = req.user;
  if (!user) throw new UnauthorizedError('User not found');
  const { provider, text, durationSeconds, promptInfluence, format, encoding, preview, organization_id } =
    req.validated;

  // Omitted keeps the home-org default. A key bills its own account (resolveAudioBillingOrgId 403s any other
  // target), so only the JWT caller's value changes the payer. Undefined is a user-billed key, which bills the user.
  const billingOrganizationId = await resolveAudioBillingOrgId(req, organization_id, 'home-org');
  // As the v1 media routes: 'studio' is any first-party session.
  const source: GenerationJobSource = req.apiKeyInfo ? 'api' : 'studio';
  const created = await createAudioJobKeepingAudioOnFullQuota(
    saveToFiles =>
      createSoundEffectJob(
        {
          user: {
            id: user.id,
            organizationId: billingOrganizationId ?? null,
            adminRoleWithheld: adminRoleWithheldFor(req.apiKeyInfo),
          },
          request: { provider, text, durationSeconds, promptInfluence, format },
          source,
          apiKeyId: req.apiKeyInfo?.keyId,
          saveToFiles,
          usageSource: resolveRequestUsageSource(req),
        },
        getCreateSoundEffectJobDeps()
      ),
    shouldPersistGeneratedAudio({ userId: user.id, preview })
  );
  const { result } = created;

  if (!result.ok) {
    switch (result.code) {
      case 'insufficient_credits':
        throw new UnprocessableEntityError(result.message, { errorCode: 'insufficient_credits' });
      case 'model_unavailable':
        // 503, not 401: the caller IS authenticated - the provider key is a server-side capability gap. A 401 would
        // tell an API-key caller to re-authenticate, which never fixes a missing ElevenLabs key.
        return res.status(503).json({ error: result.message });
      case 'daily_limit_reached':
        throw dailyLimitError(result);
      default:
        throw new UnprocessableEntityError(result.message);
    }
  }

  const waited = await awaitInlineAudioJob(result.job.id, 'sound_effect', {
    receivedAt: req.receivedAt,
    minStepMs: inlineMinStepMs('sound_effect'),
  });
  switch (waited.status) {
    case 'gone':
      req.logger.error('Sound-effects job vanished during the inline wait', { jobId: result.job.id, provider });
      return res.status(502).json(GENERATION_FAILED);
    case 'outlasting':
      req.logger.warn('Sound-effects job did not finish in time; it continues in the background', {
        jobId: waited.job.id,
        provider,
      });
      if (!prefersRespondAsync(req)) {
        res.setHeader(GENERATION_JOB_ID_HEADER, waited.job.id);
        return res.status(504).json({
          error: STILL_GENERATING_MESSAGE,
          errorCode: REQUEST_TIMEOUT_ERROR_CODE,
          jobId: waited.job.id,
        });
      }
      res.setHeader('Preference-Applied', 'respond-async');
      return res
        .status(202)
        .json(await toPublicGenerationJob(waited.job, mapperDeps, SOUND_EFFECT_GENERATION_PROJECTION));
    case 'unretrievable':
      req.logger.warn('Sound-effects job did not finish in time and is not saved to Files; cancel requested', {
        jobId: waited.job.id,
        cancel: waited.cancel,
        provider,
      });
      return res.status(504).json({ error: 'Sound generation took too long', errorCode: REQUEST_TIMEOUT_ERROR_CODE });
    case 'ended':
      break;
  }
  const { job } = waited;

  if (job.state !== 'succeeded') {
    if (isRateLimitedFailure(job)) {
      req.logger.warn('Sound-effects generation deferred: provider at capacity', { jobId: job.id, provider });
      throw providerBusyHttpError(new ProviderBusyError(provider, 'upstream_rate_limited', retryAfterSecondsOf(job)));
    }
    req.logger.error('Sound-effects generation failed', { jobId: job.id, state: job.state, error: job.error });
    return res.status(502).json(GENERATION_FAILED);
  }

  const { output } = job.payload;
  if (!output) {
    req.logger.error('Sound-effects job succeeded without an output', { jobId: job.id });
    return res.status(502).json(GENERATION_FAILED);
  }
  let audio: Buffer;
  try {
    audio = await readAudioJobOutput(output);
  } catch (error) {
    // The clip exists and is billed; it stays in the caller's Files when it was saved there.
    req.logger.error('Sound-effects job output could not be read back', { jobId: job.id, error });
    return res.status(502).json(GENERATION_FAILED);
  }

  return deliverGeneratedAudio(res, {
    audio,
    contentType: output.contentType,
    encoding: encoding ?? 'binary',
    save: created.quotaSkip ?? (await savedCopyOf(output, created.saveToFiles)),
    logger: req.logger,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
