import { usdToCreditsStochastic, type SoundGenerationVendor } from '@bike4mind/common';
import { ProviderRateLimitError } from '@bike4mind/utils';
import type { ProviderContext, ProviderTerminalResult } from '@bike4mind/utils/generationProviders';
import { isUsableApiKey } from '../generationJobs/apiKey';
import { releaseJobHold, settleJobHold } from '../generationJobs/settlement';
import type { GenerationJobHandler } from '../generationJobs/types';
import { ProviderBusyError } from '../providerCapacity/runWithProviderCapacity';
import { estimateSoundCredits } from '../soundCost';
import {
  contentBlocked,
  failStep,
  fetchAudio,
  messageOf,
  providerFailedStep,
  rateLimitedStep,
  storeAudioOutput,
  unreachableStep,
} from './shared';
import type { SoundEffectJob, SoundEffectJobDeps } from './types';

type GenerateAttempt = (ctx: ProviderContext) => Promise<ProviderTerminalResult>;

const FEATURE_LABEL = 'sound generation';

/**
 * The sound_effect kind on the generic GenerationJobEngine: one blocking provider call, stored and succeeded in the
 * submit step, as for music. The cost is duration-driven, so the settlement is known from the request.
 */
export function createSoundEffectJobHandler(deps: SoundEffectJobDeps): GenerationJobHandler<'sound_effect'> {
  // A pricing failure must not fail terminal handling: NaN keeps the full hold (see settleJobHold).
  const estimate = (job: SoundEffectJob) => {
    const { request } = job.payload;
    try {
      const { usdCost, billedSeconds } = estimateSoundCredits(job.payload.providerId, {
        durationSeconds: request.durationSeconds,
      });
      return { credits: usdToCreditsStochastic(usdCost), usd: usdCost, billedSeconds };
    } catch (error) {
      deps.logger.error('sound_effect_job_estimate_failed', { jobId: job.id, error });
      return { credits: Number.NaN, usd: null, billedSeconds: 0 };
    }
  };

  const settle = async (job: SoundEffectJob) => {
    const { credits, usd, billedSeconds } = estimate(job);
    const charged = await settleJobHold(
      job,
      {
        credits,
        entry: {
          type: 'sound_effects_usage',
          sessionId: job.payload.sessionId ?? job.questId ?? job.id,
          model: job.payload.providerId,
        },
        featureLabel: FEATURE_LABEL,
      },
      deps
    );
    if (usd === null) return;
    try {
      await deps.recordUsage({ job, billedSeconds, creditsCharged: charged, costUsd: usd });
    } catch (error) {
      deps.logger.error('sound_effect_job_record_usage_failed', { jobId: job.id, creditsCharged: charged, error });
    }
  };

  /**
   * One provider call, in the shared-key slots when the host wires them. A 429 is thrown inside the slot so the
   * wrapper retries it within its budget, and each attempt is cut off when that budget runs out.
   */
  const runInCapacity = async (
    vendor: SoundGenerationVendor,
    apiKey: string,
    ctx: ProviderContext,
    generate: GenerateAttempt
  ): Promise<ProviderTerminalResult> => {
    if (!deps.runWithCapacity) return generate(ctx);
    return deps.runWithCapacity(apiKey, async ({ timeoutMs }) => {
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
      const result = await generate({ ...ctx, signal });
      if (result.status === 'failed' && result.retryable) {
        throw new ProviderRateLimitError(vendor, result.message);
      }
      return result;
    });
  };

  return {
    kind: 'sound_effect',
    submitMode: 'sync',

    async submit(job, context) {
      const { providerId, request } = job.payload;
      const provider = deps.providers[providerId];
      if (!provider) return failStep('provider_error', `sound-effect provider '${providerId}' is not registered`);
      let apiKey: string | null;
      try {
        apiKey = await deps.resolveApiKey(providerId, job.requestedBy);
      } catch (error) {
        // Nothing has reached the provider yet, so the outcome is known and resubmitting is safe.
        deps.logger.warn('sound effect job failed before reaching the provider; retrying', {
          jobId: job.id,
          message: messageOf(error),
        });
        return { next: 'retry', reason: messageOf(error) };
      }
      if (!isUsableApiKey(apiKey)) return failStep('provider_error', `No API key configured for ${providerId}`);

      const ctx: ProviderContext = { apiKey, logger: deps.logger, now: () => deps.now(), signal: context.signal };
      const generate: GenerateAttempt = attemptCtx =>
        provider.generate(
          {
            text: request.text,
            durationSeconds: request.durationSeconds,
            promptInfluence: request.promptInfluence,
            format: request.format,
          },
          {},
          attemptCtx
        );
      let result: ProviderTerminalResult;
      try {
        result = await runInCapacity(providerId, apiKey, ctx, generate);
      } catch (error) {
        // Any other throw is an unknown outcome, which the engine fails as orphaned_submit.
        if (!(error instanceof ProviderBusyError)) throw error;
        deps.logger.warn('sound effect job gave up: provider at capacity', { jobId: job.id, reason: error.reason });
        return rateLimitedStep(error.message, error.retryAfterSeconds);
      }
      switch (result.status) {
        case 'succeeded': {
          const fetched = await fetchAudio(() => provider.fetchOutput(result.output, ctx), result.output);
          if ('tooLarge' in fetched) return failStep('output_too_large', fetched.tooLarge);
          const output = await storeAudioOutput(
            job,
            {
              ...fetched,
              generation: {
                generator: 'sound_effect',
                provider: providerId,
                jobId: job.id,
                prompt: request.text,
                ...(request.durationSeconds !== undefined && { durationSeconds: request.durationSeconds }),
                ...(request.promptInfluence !== undefined && { promptInfluence: request.promptInfluence }),
                request,
              },
            },
            context,
            deps
          );
          return { next: 'succeeded', payload: { ...job.payload, output } };
        }
        case 'blocked':
          return contentBlocked(result.raw);
        case 'failed':
          return providerFailedStep(result);
      }
    },

    async poll(job) {
      return unreachableStep(job, 'poll', deps);
    },

    async store(job) {
      return unreachableStep(job, 'store', deps);
    },

    async cancelAtProvider() {},

    async onTerminal(job) {
      if (job.state === 'succeeded') await settle(job);
      else await releaseJobHold(job, deps);
    },
  };
}
