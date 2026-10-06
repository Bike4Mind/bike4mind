import { z } from 'zod';
import type { ValidatedVideoRequest } from '@bike4mind/common';
import { readJson } from '../http';
import {
  classifyGeminiSubmitFailure,
  fetchGeminiOutput,
  GEMINI_BASE_URL,
  GeminiErrorSchema,
  geminiErrorOf,
  isGeminiSafetyError,
  type GeminiError,
} from '../gemini/geminiHttp';
import {
  ProviderSubmitError,
  type ProviderJobHandle,
  type ProviderOutput,
  type ProviderPollResult,
  type ResolvedInputs,
  type VideoProvider,
  type VideoProviderContext,
} from '../types';

// Wire shapes are pinned by __fixtures__ (see record.ts; each synthetic fixture names its evidence).
const MODEL = 'veo-3.1-fast-generate-preview';
const SUBMIT_URL = `${GEMINI_BASE_URL}/v1beta/models/${MODEL}:predictLongRunning`;
// The operation name is interpolated into a URL path, so only this adapter's model and a plain id are accepted.
const OPERATION_NAME = new RegExp(`^models/${MODEL.replaceAll('.', '\\.')}/operations/[\\w-]+$`);
// A poll of an unknown operation answers 403 PERMISSION_DENIED "... may not exist"; a bare 403 is an auth problem.
// A key from another project gets the same answer, so rotating the key mid-flight fails in-flight jobs here, which
// is right: the operation is unreachable with the new key.
const UNKNOWN_OPERATION = /may not exist/i;
// A finished operation's error is a google.rpc.Status with a numeric code and no status token (seen live), so
// its safety refusals can only be recognised by wording; the shared phrase covers "blocked ... safety".
const VEO_POLICY_PHRASE = /responsible ai|usage guidelines|content polic/i;
const SAFETY_REASON = 'veo_safety';

const GeneratedSampleSchema = z.looseObject({ video: z.looseObject({ uri: z.string().optional() }).optional() });
const OperationSchema = z.looseObject({
  name: z.string().min(1),
  done: z.boolean().optional(),
  error: GeminiErrorSchema.optional(),
  response: z
    .looseObject({
      generateVideoResponse: z
        .looseObject({
          generatedSamples: z.array(GeneratedSampleSchema).optional(),
          raiMediaFilteredCount: z.number().optional(),
          raiMediaFilteredReasons: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
});
type Operation = z.infer<typeof OperationSchema>;

const isSafetyOperationError = (error: GeminiError): boolean =>
  isGeminiSafetyError(error) || (error.message !== undefined && VEO_POLICY_PHRASE.test(error.message));

const operationNameOf = (handle: ProviderJobHandle): string => {
  const name = handle.data.operationName;
  if (typeof name !== 'string' || !OPERATION_NAME.test(name)) throw new Error('veo_handle_without_operation_name');
  return name;
};

const buildSubmitBody = (request: ValidatedVideoRequest, inputs: ResolvedInputs) => {
  if (request.mode === 'image_to_video' && !inputs.inputImage) {
    throw new ProviderSubmitError('veo_missing_input_image', true, undefined, false);
  }
  const image =
    request.mode === 'image_to_video' && inputs.inputImage
      ? {
          image: {
            bytesBase64Encoded: inputs.inputImage.bytes.toString('base64'),
            mimeType: inputs.inputImage.mimeType,
          },
        }
      : {};
  return {
    instances: [{ prompt: request.prompt, ...image }],
    parameters: {
      durationSeconds: request.durationSeconds,
      aspectRatio: request.aspectRatio,
      resolution: request.resolution,
      // The docs allow only this value for image-to-video; sent explicitly so a per-region default cannot 400 it.
      ...(request.mode === 'image_to_video' && { personGeneration: 'allow_adult' }),
    },
  };
};

const failed = (code: string, raw: unknown): ProviderPollResult => ({
  status: 'failed',
  retryable: false,
  message: `veo_${code}`,
  raw,
});

const isFiltered = (operation: Operation): boolean => {
  const video = operation.response?.generateVideoResponse;
  return (video?.raiMediaFilteredCount ?? 0) > 0 || (video?.raiMediaFilteredReasons?.length ?? 0) > 0;
};

// A filtered or blocked output is documented as not charged, so `billed` stays unset.
const toPollResult = (operation: Operation): ProviderPollResult => {
  if (!operation.done) return { status: 'running' };
  if (operation.error) {
    // Not retryable even for code 13 (seen live, "internal server issue ... try again"): a retry re-polls the same
    // finished operation, which stays failed. The clip is not charged, so the user can simply resubmit.
    return isSafetyOperationError(operation.error)
      ? { status: 'blocked', reason: SAFETY_REASON, raw: operation }
      : failed('failed', operation);
  }
  const samples = operation.response?.generateVideoResponse?.generatedSamples ?? [];
  const uri = samples.find(sample => !!sample.video?.uri)?.video?.uri;
  if (uri)
    return { status: 'succeeded', output: { kind: 'url', url: uri, requiresAuth: true, contentType: 'video/mp4' } };
  if (isFiltered(operation)) return { status: 'blocked', reason: SAFETY_REASON, raw: operation };
  // Done with neither a video nor a filter verdict: a shape change to fix, not a content block.
  return failed('no_video', operation);
};

/**
 * Veo 3.1 Fast over the Gemini API long-running-operation path. Every method is one bounded call; the engine
 * owns waiting. No cancel: the docs show no operations cancel for Veo.
 */
export class VeoVideoProvider implements VideoProvider {
  readonly id = 'veo' as const;
  readonly models = [MODEL] as const;

  async submit(
    request: ValidatedVideoRequest,
    inputs: ResolvedInputs,
    ctx: VideoProviderContext
  ): Promise<ProviderJobHandle> {
    const body = buildSubmitBody(request, inputs);
    let response: Response;
    try {
      response = await fetch(SUBMIT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': ctx.apiKey },
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
    } catch (error) {
      // Unknown outcome: the operation may exist, so the engine must not resubmit.
      throw new ProviderSubmitError('veo_submit_transport', false, String(error));
    }
    const raw = await readJson(response);
    if (!response.ok) {
      const failure = classifyGeminiSubmitFailure(response.status, raw, 'veo');
      if (failure === 'blocked') return { provider: this.id, data: { blocked: true, reason: SAFETY_REASON } };
      throw failure;
    }
    const parsed = OperationSchema.safeParse(raw);
    if (!parsed.success || !OPERATION_NAME.test(parsed.data.name)) {
      throw new ProviderSubmitError('veo_submit_unparseable', false, raw);
    }
    return { provider: this.id, data: { operationName: parsed.data.name } };
  }

  async poll(handle: ProviderJobHandle, ctx: VideoProviderContext): Promise<ProviderPollResult> {
    if (handle.data.blocked === true) return { status: 'blocked', reason: SAFETY_REASON, raw: handle.data };
    const name = operationNameOf(handle);
    const response = await fetch(`${GEMINI_BASE_URL}/v1beta/${name}`, {
      headers: { 'x-goog-api-key': ctx.apiKey },
      signal: ctx.signal,
    });
    const raw = await readJson(response);
    const message = geminiErrorOf(raw)?.message;
    const unknownOperation = response.status === 403 && message !== undefined && UNKNOWN_OPERATION.test(message);
    if (response.status === 404 || unknownOperation) return failed('operation_not_found', raw);
    if (!response.ok) throw new Error(`veo_poll_http_${response.status}`);
    const parsed = OperationSchema.safeParse(raw);
    if (!parsed.success) throw new Error('veo_poll_unparseable');
    return toPollResult(parsed.data);
  }

  fetchOutput(output: ProviderOutput, ctx: VideoProviderContext): Promise<Buffer> {
    return fetchGeminiOutput(output, ctx, 'veo');
  }
}
