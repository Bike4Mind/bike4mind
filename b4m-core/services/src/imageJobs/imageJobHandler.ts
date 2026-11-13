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
  ProviderOutputUnavailableError,
  ProviderSubmitError,
  sniffImageFormat,
  type AsyncImageProvider,
  type ImageInputs,
  type ImageProvider,
  type ProviderContext,
  type ProviderOutput,
  type ProviderTerminalResult,
  type ResolvedImageInput,
  type SyncImageProvider,
} from '@bike4mind/utils/imageProviders';
import type { CreditLedgerEntry } from '../creditService/creditHold';
import { isUsableApiKey } from '../generationJobs/apiKey';
import { releaseJobHold, settleJobHold } from '../generationJobs/settlement';
import { storeGeneratedOutput, type StoreOutputResult } from '../generationJobs/storeOutput';
import type { GenerationJobHandler, GenerationJobStepContext, StepResult } from '../generationJobs/types';
import { estimateImageJobUsd } from './imageJobCost';
import type { ImageJob, ImageJobDeps } from './types';

const FEATURE_LABEL = 'image generation';
const MAX_RAW_PROVIDER_BYTES = 16 * 1024;

type ImageStepResult = StepResult<'image'>;
type UnsuccessfulResult = Exclude<ProviderTerminalResult, { status: 'succeeded' }>;
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
 * The image kind on the generic GenerationJobEngine: one job renders one image. The submit mode follows the job's
 * provider. A sync provider returns the image from one blocking call, so submit generates, moderates, stores and
 * succeeds in a single step. An async provider (BFL) queues a task in submit; poll follows it, and store downloads,
 * moderates and saves the result. Either way an unknown provider outcome throws (the engine fails it as
 * orphaned_submit) rather than rendering twice. The job renders exactly the model it was created with: there is no
 * fallback model, so the hold, the render and the charge name the same one.
 */
export function createImageJobHandler(deps: ImageJobDeps): GenerationJobHandler<'image'> {
  const providerFor = (job: ImageJob): ImageProvider => {
    const provider = deps.providers.get(job.payload.providerId);
    if (!provider) throw new Error(`image provider '${job.payload.providerId}' is not registered`);
    return provider;
  };

  const contextFor = async (job: ImageJob, { signal }: GenerationJobStepContext): Promise<ProviderContext | null> => {
    const apiKey = await deps.resolveApiKey(job.payload.providerId, job.requestedBy);
    if (!isUsableApiKey(apiKey)) return null;
    return { apiKey, logger: deps.logger, now: () => deps.now(), signal };
  };

  const noApiKey = (job: ImageJob): ImageStepResult =>
    fail('provider_error', `No API key configured for ${job.payload.providerId}`);

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
    context: GenerationJobStepContext
  ): Promise<PreparedSubmit | ImageStepResult> => {
    const { request } = job.payload;
    const provider = providerFor(job);
    const ctx = await contextFor(job, context);
    if (!ctx) return noApiKey(job);
    // Defensive: the catalog may have changed since the job was created, and a now-invalid request is not retryable.
    const validation = validateImageRequest({ ...request, count: 1 }, getImageModelCatalogEntry(request.model));
    if (!validation.ok) {
      return fail('provider_error', `stored request is no longer valid: ${validation.failures[0].reason}`);
    }
    const inputs = await loadInputs(job);
    if ('next' in inputs) return inputs;
    return { provider, inputs, ctx };
  };

  const saveOutput = async (
    job: ImageJob,
    params: { bytes: Buffer; contentType: string },
    { signal }: GenerationJobStepContext
  ): Promise<StoreOutputResult> => {
    const { payload } = job;
    const { bytes, contentType } = params;
    return storeGeneratedOutput(
      {
        job,
        noun: 'image',
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
        derivedFrom: lineageOf(job),
        bucketFolder: 'generated-images',
        extension: extensionFromMimeType(contentType) ?? 'bin',
        // A sync submit cannot retry, so a throwing Files save still keeps the image in the bucket.
        onFilesError: 'fallback',
        // A throw here (the scan could not run) fails closed: orphaned_submit on the sync path, a retried store
        // step on the async one (up to MAX_STEP_ATTEMPTS, then the job fails). Either way the image is not kept.
        moderate: () => deps.moderate({ job, bytes, mimeType: contentType }),
        signal,
      },
      deps
    );
  };

  /** Downloads, moderates and saves the provider's image: the end of submit (sync) or the store step (async). */
  const storeOutput = async (
    job: ImageJob,
    provider: ImageProvider,
    ctx: ProviderContext,
    providerOutput: ProviderOutput,
    context: GenerationJobStepContext
  ): Promise<ImageStepResult> => {
    let bytes: Buffer;
    try {
      bytes = await provider.fetchOutput(providerOutput, ctx);
    } catch (error) {
      if (error instanceof ProviderOutputTooLargeError) return fail('output_too_large', error.message);
      if (error instanceof ProviderOutputUnavailableError) {
        return fail('provider_error', 'The provider no longer has the image', { status: error.status });
      }
      throw error;
    }
    // A delivery URL carries no type, so the bytes say what they are; anything that is not an image is refused.
    const declared = providerOutput.contentType ?? sniffImageFormat(bytes)?.mimeType;
    if (!declared) return fail('provider_error', 'The provider returned something that is not an image');
    const contentType = normalizeContentType(declared);
    const stored = await saveOutput(job, { bytes, contentType }, context);
    if (!stored.stored) {
      return {
        next: 'blocked',
        // Released, not charged, as the chat image path does when our scan withholds an image.
        error: { code: 'content_blocked', message: stored.reason },
      };
    }
    const output: ImageJobOutput = { ...stored.location, contentType, bytes: bytes.byteLength };
    // The provider handle and delivery URL only drive the steps; the terminal payload keeps the stored output.
    const { providerHandle: _handle, providerOutput: _output, ...rest } = job.payload;
    const payload: ImageJobPayload = { ...rest, output };
    return { next: 'succeeded', payload };
  };

  const unsuccessfulStep = (job: ImageJob, result: UnsuccessfulResult): ImageStepResult => {
    if (result.status === 'blocked') {
      return {
        next: 'blocked',
        error: { code: 'content_blocked', message: 'The provider declined this request under its content policy' },
        rawProviderError: boundRawPayload(result.raw),
        ...(result.billed && { payload: { ...job.payload, billedBlock: true } }),
      };
    }
    // Retryable only when the provider definitively generated nothing (a 429).
    return result.retryable
      ? { next: 'retry', reason: result.message }
      : fail('provider_error', result.message, boundRawPayload(result.raw));
  };

  const submitSync = async (
    job: ImageJob,
    { provider, inputs, ctx }: PreparedSubmit & { provider: SyncImageProvider },
    context: GenerationJobStepContext
  ): Promise<ImageStepResult> => {
    // Not caught: a throw is an unknown outcome (the image may exist and be billed). See SyncGenerationProvider.
    const result = await provider.generate(job.payload.request, inputs, ctx);
    if (result.status !== 'succeeded') return unsuccessfulStep(job, result);
    return storeOutput(job, provider, ctx, result.output, context);
  };

  const submitAsync = async (
    job: ImageJob,
    { provider, inputs, ctx }: PreparedSubmit & { provider: AsyncImageProvider }
  ): Promise<ImageStepResult> => {
    try {
      const providerHandle = await provider.submit(job.payload.request, inputs, ctx);
      return { next: 'running', payload: { ...job.payload, providerHandle } };
    } catch (error) {
      // Only a definitive rejection created nothing; anything else rethrows as an unknown outcome (orphaned_submit).
      if (!(error instanceof ProviderSubmitError) || !error.definitive) throw error;
      if (!error.retryable) return fail('provider_error', error.message, boundRawPayload(error.raw));
      deps.logger.warn('image provider rejected the submit; retrying', { jobId: job.id, message: error.message });
      return { next: 'retry', reason: error.message };
    }
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
    return fail('provider_error', `a sync image job finishes in submit; ${step} is never reached`);
  };

  return {
    kind: 'image',
    // The provider id is fixed at create, so a job's mode never changes under it.
    // An unregistered provider (e.g. removed mid-flight) keeps an in-flight async job on the poll path.
    submitMode: job =>
      deps.providers.get(job.payload.providerId)?.mode ?? (job.payload.providerHandle ? 'async' : 'sync'),

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
      const { provider } = prepared;
      return provider.mode === 'sync'
        ? submitSync(job, { ...prepared, provider }, context)
        : submitAsync(job, { ...prepared, provider });
    },

    async poll(job, context) {
      const provider = providerFor(job);
      if (provider.mode !== 'async') return unreachable(job, 'poll');
      const handle = job.payload.providerHandle;
      if (!handle) return fail('provider_error', 'running without a provider handle');
      const ctx = await contextFor(job, context);
      if (!ctx) return noApiKey(job);
      const result = await provider.poll(handle, ctx);
      switch (result.status) {
        case 'running':
          return { next: 'poll_again' };
        case 'succeeded':
          // The payload is persisted between steps, so it may carry a delivery URL but never the image bytes.
          if (result.output.kind !== 'url') {
            return fail('provider_error', 'An async image provider must deliver its image by URL');
          }
          return { next: 'storing', payload: { ...job.payload, providerOutput: result.output } };
        default:
          return unsuccessfulStep(job, result);
      }
    },

    async store(job, context) {
      const provider = providerFor(job);
      if (provider.mode !== 'async') return unreachable(job, 'store');
      const { providerOutput } = job.payload;
      if (!providerOutput) return fail('provider_error', 'storing without provider output');
      const ctx = await contextFor(job, context);
      if (!ctx) return noApiKey(job);
      // A crash after saving and before the terminal commit re-runs this step; saveToFiles dedups per job.
      return storeOutput(job, provider, ctx, providerOutput, context);
    },

    // A sync job can only be cancelled before its provider call starts, so only an async task can be stopped.
    async cancelAtProvider(job, context) {
      const provider = deps.providers.get(job.payload.providerId);
      const handle = job.payload.providerHandle;
      if (provider?.mode !== 'async' || !provider.cancel || !handle) return;
      const ctx = await contextFor(job, context);
      if (ctx) await provider.cancel(handle, ctx);
    },

    // Reads only the committed job, so the sweep's recovery of an unhandled terminal job settles or releases alike.
    async onTerminal(job) {
      const charged = job.state === 'succeeded' || (job.state === 'blocked' && job.payload.billedBlock === true);
      if (charged) await settle(job);
      else await releaseJobHold(job, deps);
    },
  };
}
