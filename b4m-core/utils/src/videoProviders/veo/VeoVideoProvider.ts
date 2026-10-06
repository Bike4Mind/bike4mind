import { z } from 'zod';
import type { ValidatedVideoRequest } from '@bike4mind/common';
import {
  ProviderOutputUnavailableError,
  ProviderSubmitError,
  readBoundedResponse,
  type ProviderJobHandle,
  type ProviderOutput,
  type ProviderPollResult,
  type ResolvedInputs,
  type VideoProvider,
  type VideoProviderContext,
} from '../types';

// Wire shapes are pinned by __fixtures__ (see record.ts; each synthetic fixture names its evidence).
const API_HOST = 'generativelanguage.googleapis.com';
const BASE_URL = `https://${API_HOST}`;
const MODEL = 'veo-3.1-fast-generate-preview';
const SUBMIT_URL = `${BASE_URL}/v1beta/models/${MODEL}:predictLongRunning`;
// The operation name is interpolated into a URL path, so only the documented shape is accepted.
const OPERATION_NAME = /^models\/[\w.-]+\/operations\/[\w-]+$/;
// Whole-token match on enum-like fields (status, code). Not a substring match: auth failures carry
// API_KEY_SERVICE_BLOCKED, and invalid-param messages can name fields such as safety_settings.
const SAFETY_TOKEN = /^(IMAGE_)?(SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII)$/i;
// Free-text messages count only in the block phrasing ("... blocked for safety reasons").
const SAFETY_PHRASE = /\bblocked\b[^.]*\b(safety|policy|policies)\b/i;
// A poll of an unknown operation answers 403 PERMISSION_DENIED "... may not exist"; a bare 403 is an auth problem.
const UNKNOWN_OPERATION = /may not exist/i;
// The submit 4xx statuses a resubmit can get past; any other 4xx is deterministic for this request and key.
const RETRYABLE_SUBMIT_STATUSES: ReadonlySet<number> = new Set([408, 429]);
const SAFETY_REASON = 'veo_safety';

const ProviderErrorSchema = z.looseObject({
  code: z.union([z.string(), z.number()]).optional(),
  message: z.string().optional(),
  status: z.string().optional(),
});
type ProviderError = z.infer<typeof ProviderErrorSchema>;
const ErrorEnvelopeSchema = z.looseObject({ error: ProviderErrorSchema });

const GeneratedSampleSchema = z.looseObject({ video: z.looseObject({ uri: z.string().optional() }).optional() });
const OperationSchema = z.looseObject({
  name: z.string().min(1),
  done: z.boolean().optional(),
  error: ProviderErrorSchema.optional(),
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

const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** `{ error }` from the API, `[{ error }]` from the Google front end. */
const providerErrorOf = (raw: unknown): ProviderError | undefined => {
  const parsed = ErrorEnvelopeSchema.safeParse(Array.isArray(raw) ? raw[0] : raw);
  return parsed.success ? parsed.data.error : undefined;
};

const isSafetyError = (error: ProviderError | undefined): boolean =>
  [error?.status, error?.code].some(value => typeof value === 'string' && SAFETY_TOKEN.test(value)) ||
  (error?.message !== undefined && SAFETY_PHRASE.test(error.message));

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
            inlineData: { mimeType: inputs.inputImage.mimeType, data: inputs.inputImage.bytes.toString('base64') },
          },
        }
      : {};
  return {
    instances: [{ prompt: request.prompt, ...image }],
    parameters: {
      durationSeconds: request.durationSeconds,
      aspectRatio: request.aspectRatio,
      resolution: request.resolution,
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
    return isSafetyError(operation.error)
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

// The live uri carries ?alt=media, which the fixture scrubber strips; without it the endpoint is not the media.
const downloadUrlOf = (raw: string): URL => {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.host !== API_HOST) throw new Error('veo_untrusted_output_url');
  if (!url.searchParams.has('alt')) url.searchParams.set('alt', 'media');
  return url;
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
      // A safety 400 is a content outcome: a definitive error would let the engine resubmit the same prompt.
      if (response.status === 400 && isSafetyError(providerErrorOf(raw))) {
        return { provider: this.id, data: { blocked: true, reason: SAFETY_REASON } };
      }
      // A 4xx created nothing; a 5xx may have. Only a throttle is worth resubmitting.
      throw new ProviderSubmitError(
        `veo_http_${response.status}`,
        response.status < 500,
        raw,
        RETRYABLE_SUBMIT_STATUSES.has(response.status)
      );
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
    const response = await fetch(`${BASE_URL}/v1beta/${name}`, {
      headers: { 'x-goog-api-key': ctx.apiKey },
      signal: ctx.signal,
    });
    const raw = await readJson(response);
    const message = providerErrorOf(raw)?.message;
    const unknownOperation = response.status === 403 && message !== undefined && UNKNOWN_OPERATION.test(message);
    if (response.status === 404 || unknownOperation) return failed('operation_not_found', raw);
    if (!response.ok) throw new Error(`veo_poll_http_${response.status}`);
    const parsed = OperationSchema.safeParse(raw);
    if (!parsed.success) throw new Error('veo_poll_unparseable');
    return toPollResult(parsed.data);
  }

  async fetchOutput(output: ProviderOutput, ctx: VideoProviderContext): Promise<Buffer> {
    if (output.kind !== 'url') throw new Error('veo_unexpected_inline_output');
    const url = downloadUrlOf(output.url);
    let response = await fetch(url, {
      headers: { 'x-goog-api-key': ctx.apiKey },
      redirect: 'manual',
      signal: ctx.signal,
    });
    // A redirect to storage is followed once, without the key.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('veo_redirect_without_location');
      const target = new URL(location, url);
      if (target.protocol !== 'https:') throw new Error('veo_untrusted_output_url');
      await response.body?.cancel();
      response = await fetch(target, { redirect: 'error', signal: ctx.signal });
    }
    if (response.status === 404 || response.status === 410) throw new ProviderOutputUnavailableError(response.status);
    if (!response.ok) throw new Error(`veo_download_http_${response.status}`);
    return readBoundedResponse(response);
  }
}
