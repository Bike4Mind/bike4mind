import {
  extensionFromMimeType,
  getImageModelCatalogEntry,
  imageJobInputs,
  usdToCreditsStochastic,
  validateImageRequest,
  type GeneratedAssetLineageEntry,
  type GenerationJobErrorCode,
  type ImageJobOutput,
  type ImageJobPayload,
} from '@bike4mind/common';
import {
  ProviderOutputTooLargeError,
  type ImageInputs,
  type ImageProvider,
  type ProviderContext,
  type ProviderTerminalResult,
  type ResolvedImageInput,
} from '@bike4mind/utils/imageProviders';
import type { CreditLedgerEntry } from '../creditService/creditHold';
import { isUsableApiKey } from '../generationJobs/apiKey';
import { releaseJobHold, settleJobHold } from '../generationJobs/settlement';
import type { GenerationJobHandler, GenerationJobStepContext, StepResult } from '../generationJobs/types';
import { estimateImageJobUsd } from './imageJobCost';
import type { ImageJob, ImageJobDeps } from './types';

const FEATURE_LABEL = 'image generation';
const MAX_RAW_PROVIDER_BYTES = 16 * 1024;
// Fresh budget for the bucket fallback when the step signal already fired; fits the engine's commit margin.
const FALLBACK_SAVE_BUDGET_MS = 10_000;

type ImageStepResult = StepResult<'image'>;
type SucceededResult = Extract<ProviderTerminalResult, { status: 'succeeded' }>;
type PreparedSubmit = { provider: ImageProvider; inputs: ImageInputs; ctx: ProviderContext };

const fail = (code: GenerationJobErrorCode, message: string, rawProviderError?: unknown): ImageStepResult => ({
  next: 'failed',
  error: { code, message },
  rawProviderError,
});

// The raw payload rides on the job document, and a provider can echo the request or image bytes into it.
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

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const normalizeContentType = (contentType: string): string => contentType.split(';')[0].trim().toLowerCase();

/** Inputs map 1:1 onto FabFile lineage roles (edit_source, mask, reference). */
const lineageOf = (job: ImageJob): GeneratedAssetLineageEntry[] =>
  imageJobInputs(job.payload.request).map(input => ({ fileId: input.fileId, role: input.role, jobId: job.id }));

/**
 * The image kind on the generic GenerationJobEngine: one job renders one image. The provider returns it from one
 * blocking call, so submit generates, moderates, stores and succeeds in a single step, and an unknown provider
 * outcome throws (the engine fails it as orphaned_submit) rather than rendering twice. The job renders exactly the
 * model it was created with: there is no fallback model, so the hold, the render and the charge name the same one.
 */
export function createImageJobHandler(deps: ImageJobDeps): GenerationJobHandler<'image'> {
  const loadInputs = async (job: ImageJob): Promise<ImageInputs | ImageStepResult> => {
    const images: ResolvedImageInput[] = [];
    for (const input of imageJobInputs(job.payload.request)) {
      const file = await deps.loadInputFile(job.requestedBy, input.fileId);
      if (!file) return fail('input_image_not_found', `Input image not found (${input.role})`);
      images.push({ role: input.role, ...file });
    }
    return { images };
  };

  const prepareSubmit = async (
    job: ImageJob,
    { signal }: GenerationJobStepContext
  ): Promise<PreparedSubmit | ImageStepResult> => {
    const { providerId, request } = job.payload;
    const provider = deps.providers.get(providerId);
    if (!provider) throw new Error(`image provider '${providerId}' is not registered`);
    const apiKey = await deps.resolveApiKey(providerId, job.requestedBy);
    if (!isUsableApiKey(apiKey)) return fail('provider_error', `No API key configured for ${providerId}`);
    // Defensive: the catalog may have changed since the job was created, and a now-invalid request is not retryable.
    const validation = validateImageRequest({ ...request, count: 1 }, getImageModelCatalogEntry(request.model));
    if (!validation.ok) {
      return fail('provider_error', `stored request is no longer valid: ${validation.failures[0].reason}`);
    }
    const inputs = await loadInputs(job);
    if ('next' in inputs) return inputs;
    return { provider, inputs, ctx: { apiKey, logger: deps.logger, now: () => deps.now(), signal } };
  };

  const saveOutput = async (
    job: ImageJob,
    params: { bytes: Buffer; contentType: string },
    { signal }: GenerationJobStepContext
  ): Promise<ImageJobOutput> => {
    const { payload } = job;
    const { bytes, contentType } = params;
    const common = { contentType, bytes: bytes.byteLength };
    const derivedFrom = lineageOf(job);
    try {
      const files = await deps.saveToFiles({
        userId: job.requestedBy,
        bytes,
        contentType,
        generation: {
          generator: 'image',
          provider: payload.providerId,
          modelId: payload.request.model,
          jobId: job.id,
          prompt: payload.request.prompt,
          request: payload.request,
        },
        ...(derivedFrom.length > 0 && { derivedFrom }),
        signal,
      });
      if (files.saved) return { location: 'files', s3Key: files.s3Key, fileId: files.fileId, ...common };
      deps.logger.warn('image saved outside Files', { jobId: job.id, reason: files.reason });
    } catch (error) {
      deps.logger.warn('image save to Files threw; saving outside Files', { jobId: job.id, error });
    }
    // Already moderated above, so the fallback cannot keep an image our scan withheld.
    const fallbackSignal = signal.aborted ? AbortSignal.timeout(FALLBACK_SAVE_BUDGET_MS) : signal;
    const key = `generated-images/${job.ownerId}/${job.id}.${extensionFromMimeType(contentType) ?? 'bin'}`;
    try {
      const { s3Key } = await deps.saveToGeneratedBucket({ key, bytes, contentType, signal: fallbackSignal });
      return { location: 'generated', s3Key, ...common };
    } catch (error) {
      // Rendered and billed but cannot be kept: the throw fails the job as orphaned_submit.
      deps.logger.error('image_job_output_unsaved', { jobId: job.id, bytes: bytes.byteLength, error });
      throw error;
    }
  };

  const store = async (
    job: ImageJob,
    { provider, ctx }: PreparedSubmit,
    result: SucceededResult,
    context: GenerationJobStepContext
  ): Promise<ImageStepResult> => {
    let bytes: Buffer;
    try {
      bytes = await provider.fetchOutput(result.output, ctx);
    } catch (error) {
      if (error instanceof ProviderOutputTooLargeError) return fail('output_too_large', error.message);
      throw error;
    }
    const contentType = normalizeContentType(result.output.contentType ?? 'image/png');
    // A throw here (the scan could not run) fails closed as orphaned_submit: the image is not kept.
    const verdict = await deps.moderate({ job, bytes, mimeType: contentType });
    if (verdict.blocked) {
      return {
        next: 'blocked',
        // Released, not charged, as the chat image path does when this scan withholds an image.
        error: { code: 'content_blocked', message: verdict.reason },
      };
    }
    const output = await saveOutput(job, { bytes, contentType }, context);
    const payload: ImageJobPayload = { ...job.payload, output };
    return { next: 'succeeded', payload };
  };

  // A pricing failure (a catalog change since create) must not fail terminal handling: NaN keeps the full hold.
  const estimate = (job: ImageJob): { credits: number; usd: number | null } => {
    try {
      const usd = estimateImageJobUsd(job.payload.request);
      return { credits: Number.isFinite(usd) ? usdToCreditsStochastic(usd) : Number.NaN, usd };
    } catch (error) {
      deps.logger.error('image_job_estimate_failed', { jobId: job.id, model: job.payload.request.model, error });
      return { credits: Number.NaN, usd: null };
    }
  };

  const settle = async (job: ImageJob) => {
    const { credits, usd } = estimate(job);
    // Same ledger types as the chat image paths. Jobs without a quest use the job id: these variants are quest-scoped.
    const entry: CreditLedgerEntry = {
      type: job.payload.request.mode === 'edit' ? 'image_edit_usage' : 'image_generation_usage',
      sessionId: job.questId ?? job.id,
      questId: job.questId ?? job.id,
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
        status: job.state === 'blocked' ? 'refusal' : 'ok',
      });
    } catch (error) {
      deps.logger.error('image_job_record_usage_failed', { jobId: job.id, creditsCharged: charged, error });
    }
  };

  const unreachable = (job: ImageJob, step: string): ImageStepResult => {
    deps.logger.error('image_job_unexpected_step', { jobId: job.id, state: job.state, step });
    return fail('provider_error', `image jobs finish in submit; ${step} is never reached`);
  };

  return {
    kind: 'image',
    submitMode: 'sync',

    async submit(job, context) {
      let prepared: PreparedSubmit | ImageStepResult;
      try {
        prepared = await prepareSubmit(job, context);
      } catch (error) {
        // Nothing has reached the provider yet, so the outcome is known and resubmitting is safe.
        deps.logger.warn('image job failed before reaching the provider; retrying', {
          jobId: job.id,
          message: messageOf(error),
        });
        return { next: 'retry', reason: messageOf(error) };
      }
      if ('next' in prepared) return prepared;
      // Not caught: a throw is an unknown outcome (the image may exist and be billed). See SyncGenerationProvider.
      const result = await prepared.provider.generate(job.payload.request, prepared.inputs, prepared.ctx);
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
