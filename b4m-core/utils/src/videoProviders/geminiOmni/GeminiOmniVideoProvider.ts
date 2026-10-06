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
const INTERACTIONS_URL = `${BASE_URL}/v1beta/interactions`;
// Whole-token match on enum-like fields (status, code, finish_reason). Not a substring match: auth failures
// carry API_KEY_SERVICE_BLOCKED, and invalid-param messages can name fields such as safety_settings.
const SAFETY_TOKEN = /^(IMAGE_)?(SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII)$/i;
// Free-text messages count only in the block phrasing ("... blocked for safety reasons").
const SAFETY_PHRASE = /\bblocked\b[^.]*\b(safety|policy|policies)\b/i;
// The only poll 400 that proves the interaction is gone; other 400s (an auth bug seen live) may be transient.
const UNKNOWN_INTERACTION = /Invalid interaction name/i;
// Unrecognised statuses that still read as terminal failures (the documented enum is not fully observed).
const FAILURE_LIKE_STATUS = /fail|error|cancel|expire|reject/i;
const SAFETY_REASON = 'gemini_omni_safety';
const NO_VIDEO_REASON = 'gemini_omni_no_video';

const ProviderErrorSchema = z.looseObject({
  // A string ("invalid_request") on Interactions endpoints, a number on Google front-end errors.
  code: z.union([z.string(), z.number()]).optional(),
  message: z.string().optional(),
  status: z.string().optional(),
});
type ProviderError = z.infer<typeof ProviderErrorSchema>;
const ErrorEnvelopeSchema = z.looseObject({ error: ProviderErrorSchema });

const ContentSchema = z.looseObject({ type: z.string(), uri: z.string().optional(), mime_type: z.string().optional() });
const InteractionSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  steps: z.array(z.looseObject({ type: z.string(), content: z.array(ContentSchema).optional() })).optional(),
  error: ProviderErrorSchema.optional(),
  finish_reason: z.string().optional(),
  usage: z
    .looseObject({
      output_tokens_by_modality: z.array(z.looseObject({ modality: z.string(), tokens: z.number() })).optional(),
    })
    .optional(),
});
type Interaction = z.infer<typeof InteractionSchema>;

const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** `{ error }` from Interactions endpoints, `[{ error }]` from the Google front end. */
const providerErrorOf = (raw: unknown): ProviderError | undefined => {
  const parsed = ErrorEnvelopeSchema.safeParse(Array.isArray(raw) ? raw[0] : raw);
  return parsed.success ? parsed.data.error : undefined;
};

const isSafetyError = (error: ProviderError | undefined, finishReason?: string): boolean =>
  [error?.status, error?.code, finishReason].some(value => typeof value === 'string' && SAFETY_TOKEN.test(value)) ||
  (error?.message !== undefined && SAFETY_PHRASE.test(error.message));

const interactionIdOf = (handle: ProviderJobHandle): string => {
  const id = handle.data.interactionId;
  if (typeof id !== 'string' || id.length === 0) throw new Error('gemini_omni_handle_without_interaction_id');
  return id;
};

const isUnknownInteraction = (raw: unknown): boolean => {
  const message = providerErrorOf(raw)?.message;
  return message !== undefined && UNKNOWN_INTERACTION.test(message);
};

const isBlockedHandle = (handle: ProviderJobHandle): boolean => handle.data.blocked === true;

const buildSubmitBody = (request: ValidatedVideoRequest, inputs: ResolvedInputs) => {
  let input: unknown = request.prompt;
  if (request.mode === 'image_to_video') {
    if (!inputs.inputImage) throw new ProviderSubmitError('gemini_omni_missing_input_image', true);
    input = [
      { type: 'image', data: inputs.inputImage.bytes.toString('base64'), mime_type: inputs.inputImage.mimeType },
      { type: 'text', text: request.prompt },
    ];
  }
  return {
    model: request.model,
    input,
    // Without it the POST blocks for the whole generation.
    background: true,
    response_format: {
      type: 'video',
      delivery: 'uri',
      aspect_ratio: request.aspectRatio,
      resolution: request.resolution,
      // A protobuf Duration string; a bare number is a 400.
      duration: `${request.durationSeconds}s`,
    },
  };
};

const findVideo = (interaction: Interaction) =>
  interaction.steps
    ?.filter(step => step.type === 'model_output')
    .flatMap(step => step.content ?? [])
    .find(content => content.type === 'video' && !!content.uri);

// Usage reporting video tokens means a video was generated, whatever the steps look like.
const reportsVideoTokens = (interaction: Interaction): boolean =>
  interaction.usage?.output_tokens_by_modality?.some(
    entry => entry.modality.toLowerCase() === 'video' && entry.tokens > 0
  ) ?? false;

const failed = (code: string, retryable: boolean, raw: unknown): ProviderPollResult => ({
  status: 'failed',
  retryable,
  message: `gemini_omni_${code}`,
  raw,
});

const toFailure = (interaction: Interaction, code: string): ProviderPollResult =>
  isSafetyError(interaction.error, interaction.finish_reason)
    ? { status: 'blocked', reason: SAFETY_REASON, raw: interaction }
    : failed(code, false, interaction);

const toPollResult = (interaction: Interaction, ctx: VideoProviderContext): ProviderPollResult => {
  switch (interaction.status) {
    case 'queued':
    case 'in_progress':
      return { status: 'running' };
    case 'completed': {
      const video = findVideo(interaction);
      if (video?.uri) {
        return {
          status: 'succeeded',
          output: { kind: 'url', url: video.uri, requiresAuth: true, contentType: video.mime_type ?? 'video/mp4' },
        };
      }
      if (reportsVideoTokens(interaction)) {
        // Generated (and billed) but not where we read it: a shape change to fix, not a content block.
        ctx.logger.error('gemini_omni_video_unparsed', { interactionId: interaction.id });
        return failed('video_unparsed', false, interaction);
      }
      // A safety refusal is `completed` with a text-only model_output, no video tokens, no error.
      return { status: 'blocked', reason: NO_VIDEO_REASON, raw: interaction };
    }
    case 'failed':
      return toFailure(interaction, 'failed');
    case 'budget_exceeded':
    case 'requires_action':
    case 'cancelled':
    // Terminal: retrying would only re-poll the same finished interaction.
    case 'incomplete':
      return failed(interaction.status, false, interaction);
    default:
      if (FAILURE_LIKE_STATUS.test(interaction.status)) return toFailure(interaction, 'unrecognised_failure');
      // Unknown and not failure-like: keep polling; the engine's job deadline bounds a status that never ends.
      ctx.logger.warn('gemini_omni_unknown_status', { status: interaction.status });
      return { status: 'running' };
  }
};

// The live uri carries ?alt=media, which the fixture scrubber strips; without it the endpoint is not the media.
const downloadUrlOf = (raw: string): URL => {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.host !== API_HOST) throw new Error('gemini_omni_untrusted_output_url');
  if (!url.searchParams.has('alt')) url.searchParams.set('alt', 'media');
  return url;
};

/** Gemini Omni Flash over the Interactions REST API. Every method is one bounded call; the engine owns waiting. */
export class GeminiOmniVideoProvider implements VideoProvider {
  readonly id = 'gemini-omni' as const;
  readonly models = ['gemini-omni-1.1-flash'] as const;

  async submit(
    request: ValidatedVideoRequest,
    inputs: ResolvedInputs,
    ctx: VideoProviderContext
  ): Promise<ProviderJobHandle> {
    const body = buildSubmitBody(request, inputs);
    let response: Response;
    try {
      response = await fetch(INTERACTIONS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': ctx.apiKey },
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
    } catch (error) {
      // Unknown outcome: the interaction may exist, so the engine must not resubmit.
      throw new ProviderSubmitError('gemini_omni_submit_transport', false, String(error));
    }
    const raw = await readJson(response);
    if (!response.ok) {
      // A safety 400 is a content outcome, not a request error: a definitive ProviderSubmitError would let the
      // engine resubmit the same prompt. The handle carries the verdict and poll() returns it offline.
      if (response.status === 400 && isSafetyError(providerErrorOf(raw))) {
        return { provider: this.id, data: { blocked: true, reason: SAFETY_REASON } };
      }
      // A 4xx (invalid parameter, undecodable image, auth, quota) created nothing; a 5xx may have.
      throw new ProviderSubmitError(`gemini_omni_http_${response.status}`, response.status < 500, raw);
    }
    const parsed = InteractionSchema.safeParse(raw);
    if (!parsed.success) throw new ProviderSubmitError('gemini_omni_submit_unparseable', false, raw);
    return { provider: this.id, data: { interactionId: parsed.data.id } };
  }

  async poll(handle: ProviderJobHandle, ctx: VideoProviderContext): Promise<ProviderPollResult> {
    if (isBlockedHandle(handle)) return { status: 'blocked', reason: SAFETY_REASON, raw: handle.data };
    const id = interactionIdOf(handle);
    const response = await fetch(`${INTERACTIONS_URL}/${encodeURIComponent(id)}`, {
      headers: { 'x-goog-api-key': ctx.apiKey },
      signal: ctx.signal,
    });
    const raw = await readJson(response);
    // An unknown interaction id is a 400 "Invalid interaction name", not a 404; neither recovers on retry.
    if (response.status === 404 || (response.status === 400 && isUnknownInteraction(raw))) {
      return failed('interaction_not_found', false, raw);
    }
    if (response.status === 400) {
      // Seen live as an auth-layer bug on a running, billed interaction: throw so the engine retries.
      ctx.logger.error('gemini_omni_poll_rejected', { status: response.status, raw });
    }
    if (!response.ok) throw new Error(`gemini_omni_poll_http_${response.status}`);
    const parsed = InteractionSchema.safeParse(raw);
    if (!parsed.success) throw new Error('gemini_omni_poll_unparseable');
    return toPollResult(parsed.data, ctx);
  }

  async fetchOutput(output: ProviderOutput, ctx: VideoProviderContext): Promise<Buffer> {
    if (output.kind !== 'url') throw new Error('gemini_omni_unexpected_inline_output');
    const url = downloadUrlOf(output.url);
    let response = await fetch(url, {
      headers: { 'x-goog-api-key': ctx.apiKey },
      redirect: 'manual',
      signal: ctx.signal,
    });
    // The live download is a direct 200; a redirect to storage is still followed once, without the key.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('gemini_omni_redirect_without_location');
      const target = new URL(location, url);
      if (target.protocol !== 'https:') throw new Error('gemini_omni_untrusted_output_url');
      await response.body?.cancel();
      response = await fetch(target, { redirect: 'error', signal: ctx.signal });
    }
    if (response.status === 404 || response.status === 410) throw new ProviderOutputUnavailableError(response.status);
    if (!response.ok) throw new Error(`gemini_omni_download_http_${response.status}`);
    return readBoundedResponse(response);
  }

  // Best effort: the engine cancels the job either way, so a refused cancel is logged, not thrown.
  async cancel(handle: ProviderJobHandle, ctx: VideoProviderContext): Promise<void> {
    if (isBlockedHandle(handle)) return;
    const id = interactionIdOf(handle);
    const response = await fetch(`${INTERACTIONS_URL}/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      headers: { 'x-goog-api-key': ctx.apiKey },
      signal: ctx.signal,
    });
    const raw = await readJson(response);
    if (!response.ok) ctx.logger.warn('gemini_omni_cancel_refused', { status: response.status, raw });
  }
}
