import {
  computeTtsUsd,
  TTS_DEFAULT_MODEL,
  usdToCreditsStochastic,
  VOICE_VENDOR_SUPPORTED_FORMATS,
  type SpeechJobPayload,
  type VoiceGenerationVendor,
  type VoiceOutputFormat,
} from '@bike4mind/common';
import { isCredentialRejectionResult, type SpeechProviderRequest } from '@bike4mind/utils/audioProviders';
import type { ProviderContext, ProviderTerminalResult } from '@bike4mind/utils/generationProviders';
import { isUsableApiKey } from '../generationJobs/apiKey';
import { releaseJobHold, settleJobHold } from '../generationJobs/settlement';
import type { GenerationJobHandler, GenerationJobStepContext, StepResult } from '../generationJobs/types';
import {
  boundRawPayload,
  contentBlocked,
  failStep,
  fetchAudio,
  messageOf,
  storeAudioOutput,
  unreachableStep,
} from './shared';
import type { SpeechJob, SpeechJobDeps, SpeechJobProvider } from './types';

const FEATURE_LABEL = 'text-to-speech';

type SpeechStepResult = StepResult<'speech'>;
type SucceededResult = Extract<ProviderTerminalResult, { status: 'succeeded' }>;

/** One vendor ready to call, or why it was passed over (nothing reached the provider). */
type Attempt =
  | {
      ready: true;
      vendor: VoiceGenerationVendor;
      provider: SpeechJobProvider;
      request: SpeechProviderRequest;
      ctx: ProviderContext;
    }
  | { ready: false; reason: string };

// An alternate may not support the requested container; it drops back to its own default (mp3) rather than failing.
const formatFor = (vendor: VoiceGenerationVendor, format: VoiceOutputFormat | undefined) =>
  format && VOICE_VENDOR_SUPPORTED_FORMATS[vendor].includes(format) ? format : undefined;

/** The model a vendor bills the call on: the requested one for the requested vendor, else the vendor default. */
const billedModel = (payload: SpeechJobPayload, vendor: VoiceGenerationVendor): string =>
  vendor === payload.request.provider
    ? (payload.request.model ?? TTS_DEFAULT_MODEL[vendor])
    : TTS_DEFAULT_MODEL[vendor];

/**
 * The speech kind on the generic GenerationJobEngine. Synthesis returns the finished clip from one blocking call, so
 * submit synthesizes, stores and succeeds in a single step, as for music. The requested vendor is tried first; a
 * later candidate stands in only when an earlier one has no usable key or rejects it, so nothing was generated.
 */
export function createSpeechJobHandler(deps: SpeechJobDeps): GenerationJobHandler<'speech'> {
  const prepare = async (
    job: SpeechJob,
    vendor: VoiceGenerationVendor,
    { signal }: GenerationJobStepContext
  ): Promise<Attempt> => {
    const { request, preferredVoice } = job.payload;
    const provider = deps.providers[vendor];
    if (!provider) return { ready: false, reason: `speech provider '${vendor}' is not registered` };
    const apiKey = await deps.resolveApiKey(vendor, job.requestedBy);
    if (!isUsableApiKey(apiKey)) return { ready: false, reason: `No API key configured for ${vendor}` };
    const isRequested = vendor === request.provider;
    // A requested voice or model belongs to the requested vendor's namespace, so an alternate uses its own.
    const voice = await deps.resolveVoice({
      vendor,
      userId: job.requestedBy,
      ...(isRequested && request.voice !== undefined && { requestedVoice: request.voice }),
      ...(preferredVoice !== undefined && { preferredVoice }),
    });
    return {
      ready: true,
      vendor,
      provider,
      request: {
        text: request.text,
        voice,
        model: isRequested ? request.model : undefined,
        format: isRequested ? request.format : formatFor(vendor, request.format),
        stability: request.stability,
        similarityBoost: request.similarityBoost,
        languageCode: request.languageCode,
      },
      ctx: { apiKey, logger: deps.logger, now: () => deps.now(), signal },
    };
  };

  const store = async (
    job: SpeechJob,
    attempt: Extract<Attempt, { ready: true }>,
    result: SucceededResult,
    context: GenerationJobStepContext
  ): Promise<SpeechStepResult> => {
    const { provider, ctx, vendor } = attempt;
    const fetched = await fetchAudio(() => provider.fetchOutput(result.output, ctx), result.output);
    if ('tooLarge' in fetched) return failStep('output_too_large', fetched.tooLarge);
    const { request } = job.payload;
    const fallback = vendor !== request.provider;
    const model = billedModel(job.payload, vendor);
    const output = await storeAudioOutput(
      job,
      {
        ...fetched,
        generation: {
          generator: 'speech',
          provider: vendor,
          modelId: model,
          jobId: job.id,
          prompt: request.text,
          ...(attempt.request.format !== undefined && { format: attempt.request.format }),
          // A voice names a voice of the requested provider, so it is meaningless once another stood in.
          ...(request.voice !== undefined && !fallback && { voice: request.voice }),
          ...(request.languageCode !== undefined && { languageCode: request.languageCode }),
          request,
        },
      },
      context,
      deps
    );
    return { next: 'succeeded', payload: { ...job.payload, producedBy: { provider: vendor, model }, output } };
  };

  const settle = async (job: SpeechJob) => {
    const producedBy = job.payload.producedBy;
    const characters = job.payload.request.text.length;
    // A success always records its vendor; without one, NaN keeps the full hold (see settleJobHold).
    const usd = producedBy ? computeTtsUsd(producedBy.provider, producedBy.model, characters) : Number.NaN;
    const charged = await settleJobHold(
      job,
      {
        credits: Number.isFinite(usd) ? usdToCreditsStochastic(usd) : Number.NaN,
        entry: {
          type: 'text_to_speech_usage',
          sessionId: job.payload.sessionId ?? job.questId ?? job.id,
          model: producedBy?.model ?? billedModel(job.payload, job.payload.request.provider),
        },
        featureLabel: FEATURE_LABEL,
      },
      deps
    );
    if (!producedBy) return;
    // Usage is reporting only: the credits already moved, so a failure here must not hold up terminal handling.
    try {
      await deps.recordUsage({ job, ...producedBy, characters, creditsCharged: charged, costUsd: usd });
    } catch (error) {
      deps.logger.error('speech_job_record_usage_failed', { jobId: job.id, creditsCharged: charged, error });
    }
  };

  return {
    kind: 'speech',
    submitMode: 'sync',

    async submit(job, context) {
      let lastFailure: { message: string; raw?: unknown } | undefined;
      for (const vendor of job.payload.candidates) {
        let attempt: Attempt;
        try {
          attempt = await prepare(job, vendor, context);
        } catch (error) {
          // Nothing has reached a provider on this attempt, so resubmitting is safe.
          deps.logger.warn('speech job failed before reaching the provider; retrying', {
            jobId: job.id,
            vendor,
            message: messageOf(error),
          });
          return { next: 'retry', reason: messageOf(error) };
        }
        if (!attempt.ready) {
          deps.logger.warn('speech provider unusable', { jobId: job.id, vendor, reason: attempt.reason });
          lastFailure ??= { message: attempt.reason };
          continue;
        }
        // Not caught: a throw is an unknown outcome (the clip may exist and be billed), which the engine fails as
        // orphaned_submit instead of calling another vendor. See SyncGenerationProvider.
        const result = await attempt.provider.generate(attempt.request, {}, attempt.ctx);
        if (result.status === 'succeeded') return store(job, attempt, result, context);
        if (result.status === 'blocked') return contentBlocked(result.raw);
        if (isCredentialRejectionResult(result)) {
          deps.logger.warn('speech provider rejected its key', { jobId: job.id, vendor });
          lastFailure ??= { message: result.message, raw: result.raw };
          continue;
        }
        // Retryable only when the provider definitively generated nothing (a 429).
        if (result.retryable) return { next: 'retry', reason: result.message };
        return failStep('provider_error', result.message, boundRawPayload(result.raw));
      }
      return failStep(
        'provider_error',
        lastFailure?.message ?? 'No text-to-speech provider is available',
        boundRawPayload(lastFailure?.raw)
      );
    },

    async poll(job) {
      return unreachableStep(job, 'poll', deps);
    },

    async store(job) {
      return unreachableStep(job, 'store', deps);
    },

    // A sync job can only be cancelled before its provider call starts, so there is never a provider job to stop.
    async cancelAtProvider() {},

    // A blocked clip is not billed by these providers, so only a success settles.
    async onTerminal(job) {
      if (job.state === 'succeeded') await settle(job);
      else await releaseJobHold(job, deps);
    },
  };
}
