import {
  estimateVideoCostCredits,
  estimateVideoCostUsd,
  getVideoModelCapabilities,
  MAX_INLINE_PROVIDER_OUTPUT_BYTES,
  validateAgainstCapabilities,
  type GenerationJobErrorCode,
  type IGenerationJobDocument,
  type VideoJobOutput,
  type VideoJobPayload,
} from '@bike4mind/common';
import {
  ProviderSubmitError,
  VideoOutputTooLargeError,
  type ProviderJobHandle,
  type ProviderOutput,
  type ResolvedInputs,
  type VideoProvider,
  type VideoProviderContext,
} from '@bike4mind/utils/videoProviders';
import { releaseCreditHold, settleCreditHold, type CreditLedgerEntry } from '../creditService/creditHold';
import type { GenerationJobHandler, StepResult } from '../generationJobs/types';
import { VIDEO_JOB_MAX_WALL_CLOCK_MS, type VideoJobDeps } from './types';

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

// Inline output can be large base64, so it must not outlive the store step on the job document.
const withoutProviderOutput = ({ providerOutput: _dropped, ...payload }: VideoJobPayload): VideoJobPayload => payload;

/** The video kind on the generic GenerationJobEngine: provider calls, output storage and credit settlement. */
export function createVideoJobHandler(deps: VideoJobDeps): GenerationJobHandler {
  const providerFor = (job: IGenerationJobDocument): VideoProvider => {
    const provider = deps.providers.get(job.payload.providerId);
    if (!provider) throw new Error(`video provider '${job.payload.providerId}' is not registered`);
    return provider;
  };

  const contextFor = async (job: IGenerationJobDocument): Promise<VideoProviderContext | null> => {
    const apiKey = await deps.resolveApiKey(job.payload.providerId, job.requestedBy);
    if (!apiKey) return null;
    return { apiKey, logger: deps.logger, now: () => deps.now() };
  };

  // The handle is written by this handler's submit from a ProviderJobHandle; common stores it structurally.
  const handleOf = (job: IGenerationJobDocument): ProviderJobHandle | null => {
    const handle = job.payload.providerHandle;
    return handle ? { provider: job.payload.providerId, data: handle.data } : null;
  };

  const settle = async (job: IGenerationJobDocument): Promise<number> => {
    const { request } = job.payload;
    const caps = getVideoModelCapabilities(request.model);
    // Capability validation pinned the requested duration to what the model produces; prefer what it reports.
    const billed = { ...request, durationSeconds: job.payload.reportedDurationSeconds ?? request.durationSeconds };
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
          estimateVideoCostCredits(caps, billed),
          entry,
          { featureLabel: FEATURE_LABEL, logger: deps.logger },
          deps.credits
        )
      : 0;
    await deps.recordUsage({
      job,
      creditsCharged: charged,
      costUsd: estimateVideoCostUsd(caps, billed),
      durationSeconds: billed.durationSeconds,
    });
    return charged;
  };

  const release = async (job: IGenerationJobDocument): Promise<number> => {
    if (job.creditHold) await releaseCreditHold(job.creditHold, deps.credits);
    return 0;
  };

  return {
    kind: 'video',
    maxWallClockMs: VIDEO_JOB_MAX_WALL_CLOCK_MS,

    async submit(job) {
      const ctx = await contextFor(job);
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
      try {
        const providerHandle = await providerFor(job).submit(validation.request, inputs, ctx);
        return { next: 'running', payload: { ...job.payload, providerHandle } };
      } catch (error) {
        // The engine treats any submit throw as an unknown outcome (orphaned_submit). Only a definitive provider
        // rejection created nothing, so only that one comes back as a retry. See GenerationJobHandler.submit.
        if (!(error instanceof ProviderSubmitError) || !error.definitive) throw error;
        deps.logger.warn('video provider rejected the submit; retrying', { jobId: job.id, message: error.message });
        return { next: 'retry', reason: error.message };
      }
    },

    async poll(job) {
      const ctx = await contextFor(job);
      if (!ctx) return noApiKey(job);
      const handle = handleOf(job);
      if (!handle) return fail('provider_error', 'running without a provider handle');
      const result = await providerFor(job).poll(handle, ctx);
      switch (result.status) {
        case 'running':
          return { next: 'poll_again', progress: result.progress };
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
          };
        case 'failed':
          return result.retryable
            ? { next: 'retry', reason: result.message }
            : fail('provider_error', result.message, result.raw);
      }
    },

    async store(job) {
      const { payload } = job;
      // A re-run after a crash between saving and committing: the save already happened.
      if (payload.output) return { next: 'succeeded', payload: withoutProviderOutput(payload) };
      const ctx = await contextFor(job);
      if (!ctx) return noApiKey(job);
      if (!payload.providerOutput) return fail('provider_error', 'storing without provider output');

      let bytes: Buffer;
      try {
        bytes = await providerFor(job).fetchOutput(payload.providerOutput, ctx);
      } catch (error) {
        if (error instanceof VideoOutputTooLargeError) return fail('output_too_large', error.message);
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
      });
      let output: VideoJobOutput;
      if (files.saved) {
        output = { location: 'files', s3Key: files.s3Key, fileId: files.fileId, ...common };
      } else {
        deps.logger.warn('video saved outside Files', { jobId: job.id, reason: files.reason });
        const key = `generated-video/${job.ownerId}/${job.id}.mp4`;
        const { s3Key } = await deps.saveToGeneratedBucket({ key, bytes, contentType });
        output = { location: 'generated', s3Key, ...common };
      }
      return { next: 'succeeded', payload: { ...withoutProviderOutput(payload), output } };
    },

    async cancelAtProvider(job) {
      const handle = handleOf(job);
      const provider = deps.providers.get(job.payload.providerId);
      if (!handle || !provider?.cancel) return;
      const ctx = await contextFor(job);
      if (ctx) await provider.cancel(handle, ctx);
    },

    async onTerminal(job) {
      const settledCredits = job.state === 'succeeded' ? await settle(job) : await release(job);
      // Lets a manual repair of a stuck terminal claim (the engine's reportUnclaimable) tell "settled, but
      // markTerminalHandled was lost" from "never settled". Must stay in sync with createVideoJob's failUnqueuedJob.
      await deps.repository.commit(job.id, { settledCredits });
    },
  };
}
