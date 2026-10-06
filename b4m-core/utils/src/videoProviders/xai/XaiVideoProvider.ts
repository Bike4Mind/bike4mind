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
const GENERATIONS_URL = 'https://api.x.ai/v1/videos/generations';
const VIDEOS_URL = 'https://api.x.ai/v1/videos';
// Whole-token match on the normalised error code (`-` read as `_`), never a substring: a capacity or auth failure
// must not read as a content block. The wording of a real block is unconfirmed until the live recording.
const MODERATION_CODE = /^(content_|safety_)?(blocked|moderat\w*)$|^(safety|content_policy|content_filter)$/;
// Free text counts only in the block phrasing ("blocked by moderation", "rejected by safety filters").
const MODERATION_PHRASE = /\b(blocked|rejected|flagged|violat\w*)\b[^.:]*\b(moderation|safety|polic(y|ies))\b/i;
// The live "bad request id" 400 reads "Malformed request ID"; an id that is well formed but gone reads as unknown.
// Anchored on "request id" so a transient "Unknown error" 400 never ends a running, billed job.
const UNKNOWN_REQUEST_PATTERN =
  /\b(malformed|invalid|unknown) request id\b|\brequest id\b[^.]*\b(unknown|not found)\b/i;
// The submit statuses a resubmit can get past; any other 4xx is deterministic for this request and key.
const RETRYABLE_SUBMIT_STATUSES: ReadonlySet<number> = new Set([408, 429]);
const MODERATION_REASON = 'xai_moderation';

// The live envelope is `{ code, error }` with a hyphenated code; the docs show `invalid_argument` and a nested
// `error: { code, message }` on a failed job. Both read through one shape.
const ErrorObjectSchema = z.looseObject({ code: z.string().optional(), message: z.string().optional() });
const ErrorEnvelopeSchema = z.looseObject({
  code: z.string().optional(),
  error: z.union([z.string(), ErrorObjectSchema]).optional(),
});
type ErrorInfo = { code?: string; message?: string };

const SubmitResponseSchema = z.looseObject({ request_id: z.string().min(1) });

const PollSchema = z.looseObject({
  status: z.string(),
  // 0-100 or null.
  progress: z.number().nullish(),
  video: z
    .looseObject({
      url: z.string().nullish(),
      duration: z.number().nullish(),
      respect_moderation: z.boolean().optional(),
    })
    .optional(),
  error: ErrorObjectSchema.nullish(),
});
type PollBody = z.infer<typeof PollSchema>;

const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const normaliseCode = (code: string | undefined): string | undefined => code?.toLowerCase().replaceAll('-', '_');

const errorInfoOf = (raw: unknown): ErrorInfo => {
  const parsed = ErrorEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return {};
  const { code, error } = parsed.data;
  if (typeof error === 'string') return { code, message: error };
  return { code: error?.code ?? code, message: error?.message };
};

const isModeration = (info: ErrorInfo): boolean =>
  (info.code !== undefined && MODERATION_CODE.test(normaliseCode(info.code) ?? '')) ||
  (info.message !== undefined && MODERATION_PHRASE.test(info.message));

const requestIdOf = (handle: ProviderJobHandle): string => {
  const id = handle.data.requestId;
  if (typeof id !== 'string' || id.length === 0) throw new Error('xai_handle_without_request_id');
  return id;
};

const isBlockedHandle = (handle: ProviderJobHandle): boolean => handle.data.blocked === true;

const buildSubmitBody = (request: ValidatedVideoRequest, inputs: ResolvedInputs) => {
  if (request.mode === 'image_to_video' && !inputs.inputImage) {
    throw new ProviderSubmitError('xai_missing_input_image', true, undefined, false);
  }
  return {
    model: request.model,
    prompt: request.prompt,
    duration: request.durationSeconds,
    aspect_ratio: request.aspectRatio,
    resolution: request.resolution,
    // Audio is on by default; generate_audio is not a confirmed REST field, so it is never sent.
    ...(request.mode === 'image_to_video' &&
      inputs.inputImage && {
        image: { url: `data:${inputs.inputImage.mimeType};base64,${inputs.inputImage.bytes.toString('base64')}` },
      }),
  };
};

const failed = (code: string, raw: unknown): ProviderPollResult => ({
  status: 'failed',
  retryable: false,
  message: `xai_${code}`,
  raw,
});

const toPollResult = (body: PollBody, ctx: VideoProviderContext): ProviderPollResult => {
  switch (body.status) {
    case 'pending':
      return typeof body.progress === 'number'
        ? { status: 'running', progress: body.progress / 100 }
        : { status: 'running' };
    case 'done': {
      if (body.video?.respect_moderation === false) {
        return { status: 'blocked', reason: MODERATION_REASON, raw: body };
      }
      if (body.video?.url) {
        return {
          status: 'succeeded',
          output: { kind: 'url', url: body.video.url, requiresAuth: false, contentType: 'video/mp4' },
          ...(typeof body.video.duration === 'number' && { reportedDurationSeconds: body.video.duration }),
        };
      }
      // Done (and billed) but no url where we read it: a shape change to fix, not a content block.
      ctx.logger.error('xai_video_unparsed', { status: body.status });
      return failed('video_unparsed', body);
    }
    case 'failed':
      return body.error && isModeration(body.error)
        ? { status: 'blocked', reason: MODERATION_REASON, raw: body }
        : failed('failed', body);
    case 'expired':
      return failed('expired', body);
    default:
      // Unknown status: keep polling; the engine's job deadline bounds a status that never ends.
      ctx.logger.warn('xai_unknown_status', { status: body.status });
      return { status: 'running' };
  }
};

const assertHttps = (url: URL): void => {
  if (url.protocol !== 'https:') throw new Error('xai_untrusted_output_url');
};

/** xAI Grok Imagine over the REST videos API. Every method is one bounded call; the engine owns waiting. */
export class XaiVideoProvider implements VideoProvider {
  readonly id = 'xai' as const;
  readonly models = ['grok-imagine-video-1.5'] as const;

  async submit(
    request: ValidatedVideoRequest,
    inputs: ResolvedInputs,
    ctx: VideoProviderContext
  ): Promise<ProviderJobHandle> {
    const body = buildSubmitBody(request, inputs);
    let response: Response;
    try {
      response = await fetch(GENERATIONS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.apiKey}` },
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
    } catch (error) {
      // Unknown outcome: the job may exist (and be billed), so the engine must not resubmit.
      throw new ProviderSubmitError('xai_submit_transport', false, String(error));
    }
    const raw = await readJson(response);
    if (!response.ok) {
      const info = errorInfoOf(raw);
      // A moderation 4xx is a content outcome, not a request error: a definitive ProviderSubmitError would let the
      // engine resubmit the same prompt. The handle carries the verdict and poll() returns it offline.
      if (normaliseCode(info.code) === 'invalid_argument' && isModeration(info)) {
        return { provider: this.id, data: { blocked: true, reason: MODERATION_REASON } };
      }
      // A 4xx created nothing; a 5xx may have, and it is not resubmitted because the job may already be billed
      // (definitive: false, so `retryable` would be dead and is left to default). Only a timeout or throttle is
      // definitive and worth a resubmit; any other 4xx fails the job at once.
      throw new ProviderSubmitError(
        `xai_http_${response.status}`,
        response.status < 500,
        raw,
        RETRYABLE_SUBMIT_STATUSES.has(response.status)
      );
    }
    const parsed = SubmitResponseSchema.safeParse(raw);
    if (!parsed.success) throw new ProviderSubmitError('xai_submit_unparseable', false, raw);
    return { provider: this.id, data: { requestId: parsed.data.request_id } };
  }

  async poll(handle: ProviderJobHandle, ctx: VideoProviderContext): Promise<ProviderPollResult> {
    if (isBlockedHandle(handle)) return { status: 'blocked', reason: MODERATION_REASON, raw: handle.data };
    const id = requestIdOf(handle);
    const response = await fetch(`${VIDEOS_URL}/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      signal: ctx.signal,
    });
    const raw = await readJson(response);
    // A malformed or unknown request id never recovers on retry.
    if (
      response.status === 404 ||
      (response.status === 400 && UNKNOWN_REQUEST_PATTERN.test(errorInfoOf(raw).message ?? ''))
    ) {
      return failed('request_not_found', raw);
    }
    if (!response.ok) {
      // The engine logs only the message; keep the provider text (never the key) for the retry streak.
      ctx.logger.error('xai_poll_rejected', { status: response.status, raw });
      throw new Error(`xai_poll_http_${response.status}`);
    }
    const parsed = PollSchema.safeParse(raw);
    if (!parsed.success) throw new Error('xai_poll_unparseable');
    return toPollResult(parsed.data, ctx);
  }

  // The URL is a pre-signed third-party link: the API key must never be sent to it.
  async fetchOutput(output: ProviderOutput, ctx: VideoProviderContext): Promise<Buffer> {
    if (output.kind !== 'url') throw new Error('xai_unexpected_inline_output');
    const url = new URL(output.url);
    assertHttps(url);
    let response = await fetch(url, { redirect: 'manual', signal: ctx.signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('xai_redirect_without_location');
      const target = new URL(location, url);
      assertHttps(target);
      await response.body?.cancel();
      response = await fetch(target, { redirect: 'error', signal: ctx.signal });
    }
    // An expired pre-signed link answers 403; a purged object 404 or 410.
    if ([403, 404, 410].includes(response.status)) throw new ProviderOutputUnavailableError(response.status);
    if (!response.ok) throw new Error(`xai_download_http_${response.status}`);
    return readBoundedResponse(response);
  }

  // No cancel: xAI documents none, and the engine skips a provider without one.
}
