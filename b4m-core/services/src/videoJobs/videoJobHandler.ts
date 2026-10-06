import {
  billedVideoRequest,
  estimateVideoCostCredits,
  estimateVideoCostUsd,
  getVideoModelCapabilities,
  MAX_INLINE_PROVIDER_OUTPUT_BYTES,
  validateAgainstCapabilities,
  videoFileExtension,
  type GenerationJobErrorCode,
  type IGenerationJobDocument,
  type ValidatedVideoRequest,
  type VideoJobOutput,
  type VideoJobPayload,
} from '@bike4mind/common';
import {
  ProviderSubmitError,
  ProviderOutputUnavailableError,
  VideoOutputTooLargeError,
  type ProviderJobHandle,
  type ProviderOutput,
  type ResolvedInputs,
  type VideoProvider,
  type VideoProviderContext,
} from '@bike4mind/utils/videoProviders';
import { releaseCreditHold, settleCreditHold, type CreditLedgerEntry } from '../creditService/creditHold';
import type { GenerationJobHandler, GenerationJobStepContext, StepResult } from '../generationJobs/types';
import { isUsableApiKey, type VideoJobDeps } from './types';

const FEATURE_LABEL = 'video generation';

const fail = (code: GenerationJobErrorCode, message: string, rawProviderError?: unknown): StepResult => ({
  next: 'failed',
  error: { code, message },
  rawProviderError,
});

const noApiKey = (job: IGenerationJobDocument) =>
  fail('provider_error', `No API key configured for ${job.payload.providerId}`);

// Decoded size from the base64 length; padding makes this overestimate by at most two bytes.
const inlineBytes = (output: ProviderOutput) =>
  output.kind === 'inline' ? Math.floor((output.base64.length * 3) / 4) : 0;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// The provider reports progress as 0..1; a misbehaving adapter must not push a nonsense value to the client.
const clampProgress = (progress: number | undefined): { progress?: number } =>
  progress !== undefined && Number.isFinite(progress) ? { progress: Math.min(1, Math.max(0, progress)) } : {};

const extensionFor = (contentType: string): string => videoFileExtension(contentType) ?? 'bin';

type PreparedSubmit = {
  provider: VideoProvider;
  request: ValidatedVideoRequest;
  inputs: ResolvedInputs;
  ctx: VideoProviderContext;
};

// Inline output can be large base64, so it must not outlive the store step on the job document.
const withoutProviderOutput = ({ providerOutput: _dropped, ...payload }: VideoJobPayload): VideoJobPayload => payload;

/** The video kind on the generic GenerationJobEngine: provider calls, output storage and credit settlement. */
export function createVideoJobHandler(deps: VideoJobDeps): GenerationJobHandler {
  const providerFor = (job: IGenerationJobDocument): VideoProvider => {
    const provider = deps.providers.get(job.payload.providerId);
    if (!provider) throw new Error(`video provider '${job.payload.providerId}' is not registered`);
    return provider;
  };

  // Every provider call goes through here, so this is the last boundary before an unusable key reaches a provider.
  const contextFor = async (
    job: IGenerationJobDocument,
    { signal }: GenerationJobStepContext
  ): Promise<VideoProviderContext | null> => {
    const apiKey = await deps.resolveApiKey(job.payload.providerId, job.requestedBy);
    if (!isUsableApiKey(apiKey)) return null;
    return { apiKey, logger: deps.logger, now: () => deps.now(), signal };
  };

  const handleOf = (job: IGenerationJobDocument): ProviderJobHandle | null => job.payload.providerHandle ?? null;

  // A pricing failure (a catalog change since the job was created, including a removed model) must not fail
  // terminal handling: NaN makes settleCreditHold keep the full reservation and log it at error level.
  const estimate = (job: IGenerationJobDocument) => {
    const { request } = job.payload;
    try {
      const caps = getVideoModelCapabilities(request.model);
      if (!caps) throw new Error(`Video model ${request.model} is no longer in the catalog`);
      // A billed block has no output to measure, so it is charged at the requested duration.
      const reported = job.state === 'succeeded' ? job.payload.reportedDurationSeconds : undefined;
      const billed = billedVideoRequest(caps, request, reported);
      return { billed, credits: estimateVideoCostCredits(caps, billed), usd: estimateVideoCostUsd(caps, billed) };
    } catch (error) {
      deps.logger.error('video_job_estimate_failed', { jobId: job.id, model: request.model, error });
      return { billed: request, credits: Number.NaN, usd: null };
    }
  };

  const settle = async (job: IGenerationJobDocument) => {
    const { request } = job.payload;
    const { billed, credits, usd } = estimate(job);
    // Jobs without a quest use the job id: the video ledger variant is quest-scoped.
    const entry: CreditLedgerEntry = {
      type: 'video_generation_usage',
      sessionId: job.questId ?? job.id,
      questId: job.questId ?? job.id,
      model: request.model,
    };
    const charged = job.creditHold
      ? await settleCreditHold(
          job.creditHold,
          credits,
          entry,
          { featureLabel: FEATURE_LABEL, logger: deps.logger },
          deps.credits
        )
      : 0;
    await markSettled(job, charged);
    // Without a price there is no honest cost to report; the estimate failure is already logged.
    if (usd === null) return;
    // Usage is reporting only: the credits already moved, so a failure here must not hold up terminal handling.
    try {
      await deps.recordUsage({
        job,
        creditsCharged: charged,
        costUsd: usd,
        durationSeconds: billed.durationSeconds,
      });
    } catch (error) {
      deps.logger.error('video_job_record_usage_failed', { jobId: job.id, creditsCharged: charged, error });
    }
  };

  const prepareSubmit = async (
    job: IGenerationJobDocument,
    context: GenerationJobStepContext
  ): Promise<PreparedSubmit | StepResult> => {
    const provider = providerFor(job);
    const ctx = await contextFor(job, context);
    if (!ctx) return noApiKey(job);
    const { request } = job.payload;
    // Defensive: the catalog may have changed since the job was created.
    const validation = validateAgainstCapabilities(request, getVideoModelCapabilities(request.model));
    if (!validation.ok) return fail('provider_error', `stored request is no longer valid: ${validation.message}`);
    const inputs: ResolvedInputs = {};
    if (request.mode === 'image_to_video' && request.inputImageFileId) {
      const image = await deps.loadInputImage(job.requestedBy, request.inputImageFileId);
      if (!image) return fail('input_image_not_found', 'Input image not found');
      inputs.inputImage = image;
    }
    return { provider, request: validation.request, inputs, ctx };
  };

  const release = async (job: IGenerationJobDocument) => {
    if (job.creditHold) await releaseCreditHold(job.creditHold, deps.credits);
    await markSettled(job, 0);
  };

  // Written right after credits move, before anything else can fail, so a manual repair of a stuck terminal claim
  // (the engine's reportUnclaimable) can tell "settled, but markTerminalHandled was lost" from "never settled".
  const markSettled = async (job: IGenerationJobDocument, settledCredits: number) => {
    await deps.repository.recordSettlement(job.id, settledCredits);
  };

  return {
    kind: 'video',

    async submit(job, context) {
      let prepared: PreparedSubmit | StepResult;
      try {
        prepared = await prepareSubmit(job, context);
      } catch (error) {
        // Nothing has reached the provider yet, so the outcome is known: no provider job exists to orphan.
        deps.logger.warn('video job failed before reaching the provider; retrying', {
          jobId: job.id,
          message: messageOf(error),
        });
        return { next: 'retry', reason: messageOf(error) };
      }
      if ('next' in prepared) return prepared;
      const { provider, request, inputs, ctx } = prepared;
      try {
        const providerHandle = await provider.submit(request, inputs, ctx);
        return { next: 'running', payload: { ...job.payload, providerHandle } };
      } catch (error) {
        // The engine treats any submit throw as an unknown outcome (orphaned_submit). Only a definitive provider
        // rejection created nothing, so only that one comes back as a retry, or as a failure when resubmitting
        // the same request cannot help (ProviderSubmitError.retryable). See GenerationJobHandler.submit.
        if (!(error instanceof ProviderSubmitError) || !error.definitive) throw error;
        if (!error.retryable) {
          deps.logger.warn('video provider rejected the submit for good', { jobId: job.id, message: error.message });
          return fail('provider_error', error.message, error.raw);
        }
        deps.logger.warn('video provider rejected the submit; retrying', { jobId: job.id, message: error.message });
        return { next: 'retry', reason: error.message };
      }
    },

    async poll(job, context) {
      const ctx = await contextFor(job, context);
      if (!ctx) return noApiKey(job);
      const handle = handleOf(job);
      if (!handle) return fail('provider_error', 'running without a provider handle');
      const result = await providerFor(job).poll(handle, ctx);
      switch (result.status) {
        case 'running':
          return { next: 'poll_again', ...clampProgress(result.progress) };
        case 'succeeded':
          if (inlineBytes(result.output) > MAX_INLINE_PROVIDER_OUTPUT_BYTES) {
            return fail(
              'output_too_large',
              'Inline provider output exceeds the persistable limit; the adapter must use URL delivery'
            );
          }
          return {
            next: 'storing',
            payload: {
              ...job.payload,
              providerOutput: result.output,
              reportedDurationSeconds: result.reportedDurationSeconds,
            },
          };
        case 'blocked':
          return {
            next: 'blocked',
            error: { code: 'content_blocked', message: 'The provider declined this request under its content policy' },
            rawProviderError: result.raw,
            ...(result.billed && { payload: { ...job.payload, billedBlock: true } }),
          };
        case 'failed':
          return result.retryable
            ? { next: 'retry', reason: result.message }
            : fail('provider_error', result.message, result.raw);
      }
    },

    async store(job, context) {
      const { payload } = job;
      // The output is only persisted by the terminal commit, so a crash after saving and before that commit
      // re-runs this step and saves again: saveToFiles dedups per job (see VideoJobDeps.saveToFiles).
      const ctx = await contextFor(job, context);
      if (!ctx) return noApiKey(job);
      if (!payload.providerOutput) return fail('provider_error', 'storing without provider output');

      let bytes: Buffer;
      try {
        bytes = await providerFor(job).fetchOutput(payload.providerOutput, ctx);
      } catch (error) {
        if (error instanceof VideoOutputTooLargeError) return fail('output_too_large', error.message);
        // Retention ran out (or the file was purged): another attempt cannot fetch it.
        if (error instanceof ProviderOutputUnavailableError) {
          return fail('provider_error', 'The provider no longer has the generated video', { status: error.status });
        }
        throw error;
      }
      const contentType = payload.providerOutput.contentType ?? 'video/mp4';
      const common = {
        contentType,
        bytes: bytes.byteLength,
        durationSeconds: payload.reportedDurationSeconds ?? payload.request.durationSeconds,
      };

      const files = await deps.saveToFiles({
        userId: job.requestedBy,
        jobId: job.id,
        bytes,
        contentType,
        prompt: payload.request.prompt,
        signal: context.signal,
      });
      let output: VideoJobOutput;
      if (files.saved) {
        output = { location: 'files', s3Key: files.s3Key, fileId: files.fileId, ...common };
      } else {
        deps.logger.warn('video saved outside Files', { jobId: job.id, reason: files.reason });
        const key = `generated-video/${job.ownerId}/${job.id}.${extensionFor(contentType)}`;
        const { s3Key } = await deps.saveToGeneratedBucket({
          key,
          bytes,
          contentType,
          signal: context.signal,
        });
        output = { location: 'generated', s3Key, ...common };
      }
      return { next: 'succeeded', payload: { ...withoutProviderOutput(payload), output } };
    },

    async cancelAtProvider(job, context) {
      const handle = handleOf(job);
      const provider = deps.providers.get(job.payload.providerId);
      if (!handle || !provider?.cancel) return;
      const ctx = await contextFor(job, context);
      if (!ctx) {
        deps.logger.warn('video_job_cancel_no_key', { jobId: job.id, providerId: job.payload.providerId });
        return;
      }
      await provider.cancel(handle, ctx);
    },

    // Reads only the committed job, so the sweep's recovery of an unhandled terminal job settles or releases alike.
    async onTerminal(job) {
      const charged = job.state === 'succeeded' || (job.state === 'blocked' && job.payload.billedBlock === true);
      if (charged) await settle(job);
      else await release(job);
    },
  };
}
