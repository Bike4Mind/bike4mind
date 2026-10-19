import {
  billedMusicSeconds,
  estimateMusicCostCredits,
  estimateMusicCostUsd,
  extensionFromMimeType,
  getMusicModelCapabilities,
  validateMusicRequest,
  type GenerationJobErrorCode,
  type MusicJobOutput,
  type MusicJobPayload,
  type MusicModelCapabilities,
  type ValidatedMusicRequest,
} from '@bike4mind/common';
import {
  mp3DurationSeconds,
  ProviderOutputTooLargeError,
  type MusicProvider,
  type ProviderContext,
  type ProviderTerminalResult,
} from '@bike4mind/utils/musicProviders';
import type { CreditLedgerEntry } from '../creditService/creditHold';
import { isUsableApiKey } from '../generationJobs/apiKey';
import { releaseJobHold, settleJobHold } from '../generationJobs/settlement';
import type { GenerationJobHandler, GenerationJobStepContext, StepResult } from '../generationJobs/types';
import type { MusicJob, MusicJobDeps } from './types';

const FEATURE_LABEL = 'music generation';
const MP3_CONTENT_TYPE = 'audio/mpeg';
const MAX_RAW_PROVIDER_BYTES = 16 * 1024;
// Fresh budget for the bucket fallback when the step signal already fired; must fit inside the engine's commit
// margin (STEP_COMMIT_MARGIN_MS), like its FAILURE_CANCEL_BUDGET_MS.
const FALLBACK_SAVE_BUDGET_MS = 10_000;

type MusicStepResult = StepResult<'music'>;
// The only shape the music job drives today. An async music provider would add a running state (poll + store,
// as the video handler does); until then one is refused at submit rather than half-supported.
type SyncMusicProvider = Extract<MusicProvider, { mode: 'sync' }>;
type SucceededResult = Extract<ProviderTerminalResult, { status: 'succeeded' }>;

const fail = (code: GenerationJobErrorCode, message: string, rawProviderError?: unknown): MusicStepResult => ({
  next: 'failed',
  error: { code, message },
  rawProviderError,
});

// The raw payload rides on the job document, and a provider can echo the request or an audio body into it.
const boundRawPayload = (raw: unknown): unknown => {
  let json: string | undefined;
  try {
    json = JSON.stringify(raw);
  } catch {
    return '[raw provider payload not serializable]';
  }
  if (json === undefined || json.length <= MAX_RAW_PROVIDER_BYTES) return raw;
  return `${json.slice(0, MAX_RAW_PROVIDER_BYTES)}...[truncated, ${json.length} chars total]`;
};

// Providers label MP3 as audio/mp3 or with parameters; the duration scan and the saved type key off one form.
const normalizeContentType = (contentType: string): string => {
  const base = contentType.split(';')[0].trim().toLowerCase();
  return base === 'audio/mp3' ? MP3_CONTENT_TYPE : base;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type PreparedSubmit = { provider: SyncMusicProvider; request: ValidatedMusicRequest; ctx: ProviderContext };

/**
 * The music kind on the generic GenerationJobEngine. A sync provider returns the finished song from one blocking
 * call, so submit generates, stores and succeeds in a single step: the provider's bytes never reach the job
 * document, and a song is never generated twice (an unknown outcome throws, which the engine fails as
 * orphaned_submit).
 */
export function createMusicJobHandler(deps: MusicJobDeps): GenerationJobHandler<'music'> {
  const prepareSubmit = async (
    job: MusicJob,
    { signal }: GenerationJobStepContext
  ): Promise<PreparedSubmit | MusicStepResult> => {
    const { providerId, request } = job.payload;
    const provider = deps.providers.get(providerId);
    if (!provider) throw new Error(`music provider '${providerId}' is not registered`);
    if (provider.mode !== 'sync') return fail('provider_error', `music provider '${providerId}' is not synchronous`);
    const apiKey = await deps.resolveApiKey(providerId, job.requestedBy);
    if (!isUsableApiKey(apiKey)) return fail('provider_error', `No API key configured for ${providerId}`);
    // Defensive: the catalog may have changed since the job was created, and a removed model is not retryable.
    const caps: MusicModelCapabilities | undefined = getMusicModelCapabilities(request.model);
    if (!caps) return fail('provider_error', `music model '${request.model}' is no longer in the catalog`);
    const validation = validateMusicRequest(request, caps);
    if (!validation.ok) return fail('provider_error', `stored request is no longer valid: ${validation.message}`);
    return {
      provider,
      request: validation.request,
      ctx: { apiKey, logger: deps.logger, now: () => deps.now(), signal },
    };
  };

  const durationOf = (result: SucceededResult, bytes: Buffer, contentType: string) => {
    if (result.reportedDurationSeconds !== undefined) return result.reportedDurationSeconds;
    // The frame scan would false-sync on non-MP3 audio, so only MP3 is measured.
    return contentType === MP3_CONTENT_TYPE ? mp3DurationSeconds(bytes) : undefined;
  };

  const saveOutput = async (
    job: MusicJob,
    params: { bytes: Buffer; contentType: string; durationSeconds: number; lyrics: string | undefined },
    { signal }: GenerationJobStepContext
  ): Promise<MusicJobOutput> => {
    const { payload } = job;
    const { bytes, contentType, durationSeconds, lyrics } = params;
    const common = { contentType, bytes: bytes.byteLength, durationSeconds, ...(lyrics !== undefined && { lyrics }) };
    try {
      const files = await deps.saveToFiles({
        userId: job.requestedBy,
        bytes,
        contentType,
        generation: {
          generator: 'music',
          provider: payload.providerId,
          modelId: payload.request.model,
          jobId: job.id,
          prompt: payload.request.prompt,
          ...(lyrics !== undefined && { lyrics }),
          durationSeconds,
        },
        ...(payload.sessionId !== undefined && { sessionId: payload.sessionId }),
        ...(job.questId !== undefined && { questId: job.questId }),
        signal,
      });
      if (files.saved) return { location: 'files', s3Key: files.s3Key, fileId: files.fileId, ...common };
      deps.logger.warn('music saved outside Files', { jobId: job.id, reason: files.reason });
    } catch (error) {
      deps.logger.warn('music save to Files threw; saving outside Files', { jobId: job.id, error });
    }
    // An aborted step signal rejects the fallback too, losing a song the provider already billed.
    const fallbackSignal = signal.aborted ? AbortSignal.timeout(FALLBACK_SAVE_BUDGET_MS) : signal;
    const key = `generated-audio/${job.ownerId}/${job.id}.${extensionFromMimeType(contentType) ?? 'bin'}`;
    try {
      const { s3Key } = await deps.saveToGeneratedBucket({ key, bytes, contentType, signal: fallbackSignal });
      return { location: 'generated', s3Key, ...common };
    } catch (error) {
      // The song was generated and billed but cannot be kept: the throw fails the job as orphaned_submit.
      deps.logger.error('music_job_output_unsaved', { jobId: job.id, bytes: bytes.byteLength, error });
      throw error;
    }
  };

  const store = async (
    job: MusicJob,
    { provider, request, ctx }: PreparedSubmit,
    result: SucceededResult,
    context: GenerationJobStepContext
  ): Promise<MusicStepResult> => {
    let bytes: Buffer;
    try {
      bytes = await provider.fetchOutput(result.output, ctx);
    } catch (error) {
      if (error instanceof ProviderOutputTooLargeError) return fail('output_too_large', error.message);
      throw error;
    }
    const contentType = normalizeContentType(result.output.contentType ?? MP3_CONTENT_TYPE);
    const measured = durationOf(result, bytes, contentType);
    const output = await saveOutput(
      job,
      { bytes, contentType, durationSeconds: measured ?? request.durationSeconds, lyrics: result.lyrics },
      context
    );
    const payload: MusicJobPayload = {
      ...job.payload,
      ...(measured !== undefined && { reportedDurationSeconds: measured }),
      output,
    };
    return { next: 'succeeded', payload };
  };

  // A pricing failure (a catalog change since the job was created) must not fail terminal handling: NaN keeps the
  // full hold (see settleJobHold).
  const estimate = (job: MusicJob) => {
    const { request } = job.payload;
    try {
      const caps = getMusicModelCapabilities(request.model);
      if (!caps) throw new Error(`Music model ${request.model} is no longer in the catalog`);
      // A billed block has no output to measure, so it is charged at the requested duration.
      const reported = job.state === 'succeeded' ? job.payload.reportedDurationSeconds : undefined;
      // Credits are capped at the hold; the usage event records what the provider actually delivered.
      const delivered = {
        durationSeconds: reported !== undefined && reported > 0 ? reported : request.durationSeconds,
      };
      const billed = { durationSeconds: billedMusicSeconds(request, reported) };
      return {
        seconds: delivered.durationSeconds,
        credits: estimateMusicCostCredits(caps, billed),
        usd: estimateMusicCostUsd(caps, delivered),
      };
    } catch (error) {
      deps.logger.error('music_job_estimate_failed', { jobId: job.id, model: request.model, error });
      return { seconds: request.durationSeconds, credits: Number.NaN, usd: null };
    }
  };

  const settle = async (job: MusicJob) => {
    const { seconds, credits, usd } = estimate(job);
    const entry: CreditLedgerEntry = {
      type: 'music_generation_usage',
      sessionId: job.payload.sessionId ?? job.questId ?? job.id,
      model: job.payload.request.model,
    };
    const charged = await settleJobHold(job, { credits, entry, featureLabel: FEATURE_LABEL }, deps);
    if (usd === null) return;
    // Usage is reporting only: the credits already moved, so a failure here must not hold up terminal handling.
    try {
      await deps.recordUsage({
        job,
        creditsCharged: charged,
        costUsd: usd,
        durationSeconds: seconds,
        status: job.state === 'blocked' ? 'refusal' : 'ok',
      });
    } catch (error) {
      deps.logger.error('music_job_record_usage_failed', { jobId: job.id, creditsCharged: charged, error });
    }
  };

  const unreachable = (job: MusicJob, step: string): MusicStepResult => {
    deps.logger.error('music_job_unexpected_step', { jobId: job.id, state: job.state, step });
    return fail('provider_error', `music jobs finish in submit; ${step} is never reached`);
  };

  return {
    kind: 'music',
    submitMode: 'sync',

    async submit(job, context) {
      let prepared: PreparedSubmit | MusicStepResult;
      try {
        prepared = await prepareSubmit(job, context);
      } catch (error) {
        // Nothing has reached the provider yet, so the outcome is known and resubmitting is safe.
        deps.logger.warn('music job failed before reaching the provider; retrying', {
          jobId: job.id,
          message: messageOf(error),
        });
        return { next: 'retry', reason: messageOf(error) };
      }
      if ('next' in prepared) return prepared;
      // Not caught: a throw is an unknown outcome (the song may exist and be billed), which the engine fails as
      // orphaned_submit instead of calling generate again. See SyncGenerationProvider.
      const result = await prepared.provider.generate(prepared.request, {}, prepared.ctx);
      switch (result.status) {
        case 'succeeded':
          return store(job, prepared, result, context);
        case 'blocked':
          return {
            next: 'blocked',
            error: { code: 'content_blocked', message: 'The provider declined this request under its content policy' },
            rawProviderError: boundRawPayload(result.raw),
            ...(result.billed && { payload: { ...job.payload, billedBlock: true } }),
          };
        case 'failed':
          // Retryable only when the provider definitively generated nothing (a 429).
          return result.retryable
            ? { next: 'retry', reason: result.message }
            : fail('provider_error', result.message, boundRawPayload(result.raw));
      }
    },

    async poll(job) {
      return unreachable(job, 'poll');
    },

    async store(job) {
      return unreachable(job, 'store');
    },

    // A sync job can only be cancelled before its provider call starts, so there is never a provider job to stop.
    async cancelAtProvider() {},

    // Reads only the committed job, so the sweep's recovery of an unhandled terminal job settles or releases alike.
    async onTerminal(job) {
      const charged = job.state === 'succeeded' || (job.state === 'blocked' && job.payload.billedBlock === true);
      if (charged) await settle(job);
      else await releaseJobHold(job, deps);
    },
  };
}
