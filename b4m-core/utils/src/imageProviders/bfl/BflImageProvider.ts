import {
  BFL_IMAGE_MODELS,
  getImageModelCatalogEntry,
  isKontextModel,
  parseSizeEdges,
  takesBflInputImageList,
  type BFLImageModel,
  type ImageJobModelId,
  type StoredImageRequest,
} from '@bike4mind/common';
import {
  BFLImageService,
  type BflTask,
  type BflTaskRequest,
  type BflTaskStatus,
} from '../../imageGeneration/BFLImageService';
import {
  ProviderSubmitError,
  type GenerationProviderJobHandle,
  type ProviderContext,
  type ProviderOutput,
  type ProviderPollResult,
} from '../../generationProviders/types';
import { classifyImageProviderError, downloadImageOutput, inputsWithRole } from '../shared';
import type { AsyncImageProvider, ImageInputs, ResolvedImageInput } from '../types';

type BflHandle = GenerationProviderJobHandle<'bfl'>;

// The polling URL is persisted on the job and later sent our API key, so only BFL's own hosts are followed;
// the same check keeps the delivery download on BFL's hosts.
const isBflHostUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'bfl.ai' || url.hostname.endsWith('.bfl.ai'));
  } catch {
    return false;
  }
};

const isBflModel = (model: ImageJobModelId): model is BFLImageModel =>
  (BFL_IMAGE_MODELS as readonly ImageJobModelId[]).includes(model);

// BFL takes input images as bare base64, as the chat edit path sends them.
const toBase64 = (image: ResolvedImageInput): string => image.bytes.toString('base64');

const outputFormatOf = (request: StoredImageRequest): 'png' | 'jpeg' | undefined =>
  request.outputFormat === 'png' || request.outputFormat === 'jpeg' ? request.outputFormat : undefined;

/** width/height for the models sized by dimensions (the catalog default when the request names none). */
const dimensionsOf = (model: BFLImageModel, size: string | undefined): { width?: number; height?: number } => {
  const { sizing } = getImageModelCatalogEntry(model);
  if (sizing.kind !== 'dimensions') return {};
  const edges = parseSizeEdges(size ?? sizing.defaultSize);
  if (!edges) throw new Error(`size '${size}' is not WIDTHxHEIGHT`);
  return edges;
};

const taskOf = (handle: BflHandle): BflTask | null => {
  const { id, pollingUrl } = handle.data;
  if (typeof id !== 'string' || typeof pollingUrl !== 'string' || !isBflHostUrl(pollingUrl)) return null;
  return { id, pollingUrl };
};

/**
 * FLUX models through the existing BFLImageService. BFL queues each request as a task, so this is an async provider:
 * submit posts the task and the job engine polls it in later steps, which keeps a slow render out of one step's
 * budget. Role-tagged inputs map onto BFL's fields:
 * - generate: references become `image_prompt` (FLUX.1 Pro, 1.1, Ultra) or the input-image list (FLUX.2, FLUX 3).
 * - edit: the edit_source is Kontext's `input_image`, Fill's `image` (with the required mask), or FLUX.2's first
 *   input image (references follow it). FLUX 3 edit regions ride in the prompt as BFL's bounding-box layout.
 */
export class BflImageProvider implements AsyncImageProvider {
  readonly mode = 'async' as const;
  readonly id = 'bfl' as const;
  readonly models = BFL_IMAGE_MODELS;

  async submit(request: StoredImageRequest, inputs: ImageInputs, ctx: ProviderContext): Promise<BflHandle> {
    const service = new BFLImageService(ctx.apiKey, ctx.logger);
    let taskRequest: BflTaskRequest;
    try {
      taskRequest = this.toTaskRequest(service, request, inputs);
    } catch (error) {
      // Nothing was sent, and the same request would be refused again.
      throw new ProviderSubmitError(error instanceof Error ? error.message : String(error), true, undefined, false);
    }

    let task: BflTask;
    try {
      task = await service.submitTask(taskRequest.model, taskRequest.body, ctx.signal);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      const classified = classifyImageProviderError(error);
      // A 4xx: BFL queued nothing. Any other failure leaves the task's existence unknown, so it is rethrown.
      if (classified?.status === 'failed') {
        throw new ProviderSubmitError(classified.message, true, classified.raw, classified.retryable);
      }
      throw error;
    }
    // The task exists (and may bill), so a polling URL we will not follow is an unknown outcome, not a rejection.
    if (!isBflHostUrl(task.pollingUrl)) throw new Error('BFL returned a polling URL outside its own hosts');
    return { provider: 'bfl', data: { id: task.id, pollingUrl: task.pollingUrl } };
  }

  async poll(handle: BflHandle, ctx: ProviderContext): Promise<ProviderPollResult> {
    const task = taskOf(handle);
    if (!task) return { status: 'failed', retryable: false, message: 'invalid BFL task handle', raw: handle.data };
    const service = new BFLImageService(ctx.apiKey, ctx.logger);
    let reading: BflTaskStatus;
    try {
      reading = await service.checkTask(task, ctx.signal);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      // A 4xx (e.g. an unknown task) is final; a 5xx or transport error throws, and the engine polls again.
      const classified = classifyImageProviderError(error);
      if (classified) return classified;
      throw error;
    }
    switch (reading.state) {
      case 'ready':
        if (!isBflHostUrl(reading.sampleUrl)) {
          ctx.logger.error('BFL returned a delivery URL outside its own hosts', { requestId: task.id });
          return {
            status: 'failed',
            retryable: false,
            message: 'BFL returned a delivery URL outside its own hosts',
            raw: { requestId: task.id },
          };
        }
        return { status: 'succeeded', output: { kind: 'url', url: reading.sampleUrl, requiresAuth: false } };
      case 'moderated':
        // Not marked billed: BFL does not document whether a moderated task is charged.
        return { status: 'blocked', reason: reading.status, raw: { requestId: task.id, status: reading.status } };
      case 'failed':
        return { status: 'failed', retryable: false, message: reading.message, raw: { requestId: task.id } };
      case 'pending':
        // BFL no longer knows the task, so polling it again cannot succeed.
        if (reading.status === 'Task not found') {
          ctx.logger.error('BFL task not found', { requestId: task.id });
          return {
            status: 'failed',
            retryable: false,
            message: 'BFL no longer has this task (task_not_found)',
            raw: { requestId: task.id, status: reading.status },
          };
        }
        // An undocumented status keeps polling, as the chat path does; the job's deadline bounds it.
        if (!BFLImageService.isInProgressStatus(reading.status)) {
          ctx.logger.warn('BFL task reported an undocumented status', { requestId: task.id, status: reading.status });
        }
        return { status: 'running' };
    }
  }

  async fetchOutput(output: ProviderOutput, ctx: ProviderContext): Promise<Buffer> {
    return downloadImageOutput(output, ctx.signal);
  }

  private toTaskRequest(service: BFLImageService, request: StoredImageRequest, inputs: ImageInputs): BflTaskRequest {
    const { model, prompt } = request;
    if (!isBflModel(model)) throw new Error(`${model} is not a BFL model`);
    const seed = request.seed ?? null;
    const outputFormat = outputFormatOf(request);
    const references = inputsWithRole(inputs, 'reference').map(toBase64);

    if (request.mode === 'generate') {
      const [firstReference] = references;
      return service.buildGenerateRequest(prompt, {
        model,
        seed,
        ...(outputFormat && { output_format: outputFormat }),
        ...(request.aspectRatio && { aspect_ratio: request.aspectRatio }),
        ...dimensionsOf(model, request.size),
        ...(takesBflInputImageList(model)
          ? { reference_images: references }
          : firstReference
            ? { image_prompt: firstReference }
            : {}),
      });
    }

    const [source] = inputsWithRole(inputs, 'edit_source');
    if (!source) throw new Error('edit request reached the provider without an edit_source image');
    if (isKontextModel(model)) {
      return service.buildTransformRequest(toBase64(source), prompt, {
        model,
        seed,
        ...(outputFormat && { output_format: outputFormat }),
        ...(request.aspectRatio && { aspect_ratio: request.aspectRatio }),
      });
    }
    const [mask] = inputsWithRole(inputs, 'mask');
    return service.buildEditRequest(toBase64(source), prompt, {
      model,
      seed,
      ...(outputFormat && { output_format: outputFormat }),
      ...(mask && { mask: toBase64(mask) }),
      ...(references.length > 0 && { referenceImages: references }),
      ...(request.editRegions && { edit_regions: request.editRegions }),
    });
  }
}
