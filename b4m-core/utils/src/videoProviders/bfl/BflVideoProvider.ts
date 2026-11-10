import { z } from 'zod';
import { MAX_VIDEO_OUTPUT_BYTES, type ValidatedVideoRequest } from '@bike4mind/common';
import { readJson } from '../../generationProviders/http';
import {
  ProviderOutputUnavailableError,
  ProviderSubmitError,
  readBoundedResponse,
  type ProviderJobHandle,
  type ProviderOutput,
  type ProviderPollResult,
  type VideoProvider,
  type VideoProviderContext,
} from '../types';

const BASE_URL = 'https://api.bfl.ai/v1';
const SUBMIT_URL = `${BASE_URL}/flux-3-video`;
const GET_RESULT_URL = `${BASE_URL}/get_result`;

const MODERATED_STATUSES: ReadonlySet<string> = new Set(['Request Moderated', 'Content Moderated']);
const IN_PROGRESS_STATUSES: ReadonlySet<string> = new Set(['Pending', 'Reasoning', 'Generating']);
const RETRYABLE_SUBMIT_STATUSES: ReadonlySet<number> = new Set([408, 429]);
const MODERATION_REASON = 'bfl_moderation';

const SubmitResponseSchema = z.looseObject({
  id: z.string().min(1),
  polling_url: z.string().optional(),
});

const PollSchema = z.looseObject({
  status: z.string(),
  result: z
    .looseObject({
      sample: z.string().nullish(),
      duration_seconds: z.number().nullish(),
      error: z.string().nullish(),
    })
    .nullish(),
});
type PollBody = z.infer<typeof PollSchema>;

const requestIdOf = (handle: ProviderJobHandle): string => {
  const id = handle.data.requestId;
  if (typeof id !== 'string' || id.length === 0) throw new Error('bfl_handle_without_request_id');
  return id;
};

const pollingUrlOf = (handle: ProviderJobHandle): string | undefined => {
  const url = handle.data.pollingUrl;
  return typeof url === 'string' ? url : undefined;
};

const failed = (code: string, raw: unknown): ProviderPollResult => ({
  status: 'failed',
  retryable: false,
  message: `bfl_${code}`,
  raw,
});

const toPollResult = (body: PollBody, ctx: VideoProviderContext): ProviderPollResult => {
  const { status } = body;

  if (MODERATED_STATUSES.has(status)) {
    return { status: 'blocked', reason: MODERATION_REASON, raw: body };
  }

  if (status === 'Ready') {
    if (body.result?.sample) {
      return {
        status: 'succeeded',
        output: { kind: 'url', url: body.result.sample, requiresAuth: false, contentType: 'video/mp4' },
        ...(typeof body.result.duration_seconds === 'number' && {
          reportedDurationSeconds: body.result.duration_seconds,
        }),
      };
    }
    ctx.logger.error('bfl_video_unparsed', { status });
    return failed('video_unparsed', body);
  }

  if (status === 'Error' || status === 'Failed') {
    return failed('failed', body);
  }

  if (IN_PROGRESS_STATUSES.has(status)) {
    return { status: 'running' };
  }

  ctx.logger.warn('bfl_unknown_status', { status });
  return { status: 'running' };
};

const assertHttps = (url: URL): void => {
  if (url.protocol !== 'https:') throw new Error('bfl_untrusted_output_url');
};

/** BFL FLUX 3 Video over the BFL REST API. Every method is one bounded call; the engine owns waiting. */
export class BflVideoProvider implements VideoProvider {
  readonly mode = 'async' as const;
  readonly id = 'bfl' as const;
  readonly models = ['flux-3-video'] as const;

  async submit(
    request: ValidatedVideoRequest,
    _inputs: Record<string, never>,
    ctx: VideoProviderContext
  ): Promise<ProviderJobHandle> {
    const body = {
      prompt: request.prompt,
      duration_seconds: request.durationSeconds,
      aspect_ratio: request.aspectRatio,
      resolution: request.resolution,
    };
    let response: Response;
    try {
      response = await fetch(SUBMIT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-key': ctx.apiKey },
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
    } catch (error) {
      throw new ProviderSubmitError('bfl_submit_transport', false, String(error));
    }
    const raw = await readJson(response);
    if (!response.ok) {
      throw new ProviderSubmitError(
        `bfl_http_${response.status}`,
        response.status < 500,
        raw,
        RETRYABLE_SUBMIT_STATUSES.has(response.status)
      );
    }
    const parsed = SubmitResponseSchema.safeParse(raw);
    if (!parsed.success) throw new ProviderSubmitError('bfl_submit_unparseable', false, raw);
    return {
      provider: this.id,
      data: {
        requestId: parsed.data.id,
        ...(parsed.data.polling_url && { pollingUrl: parsed.data.polling_url }),
      },
    };
  }

  async poll(handle: ProviderJobHandle, ctx: VideoProviderContext): Promise<ProviderPollResult> {
    const id = requestIdOf(handle);
    const url = pollingUrlOf(handle) ?? `${GET_RESULT_URL}?id=${encodeURIComponent(id)}`;
    const response = await fetch(url, {
      headers: { 'x-key': ctx.apiKey },
      signal: ctx.signal,
    });
    const raw = await readJson(response);
    if (!response.ok) {
      ctx.logger.error('bfl_poll_rejected', { status: response.status, raw });
      throw new Error(`bfl_poll_http_${response.status}`);
    }
    const parsed = PollSchema.safeParse(raw);
    if (!parsed.success) throw new Error('bfl_poll_unparseable');
    return toPollResult(parsed.data, ctx);
  }

  async fetchOutput(output: ProviderOutput, ctx: VideoProviderContext): Promise<Buffer> {
    if (output.kind !== 'url') throw new Error('bfl_unexpected_inline_output');
    const url = new URL(output.url);
    assertHttps(url);
    let response = await fetch(url, { redirect: 'manual', signal: ctx.signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('bfl_redirect_without_location');
      const target = new URL(location, url);
      assertHttps(target);
      await response.body?.cancel();
      response = await fetch(target, { redirect: 'error', signal: ctx.signal });
    }
    if ([403, 404, 410].includes(response.status)) throw new ProviderOutputUnavailableError(response.status);
    if (!response.ok) throw new Error(`bfl_download_http_${response.status}`);
    return readBoundedResponse(response, MAX_VIDEO_OUTPUT_BYTES);
  }
}
