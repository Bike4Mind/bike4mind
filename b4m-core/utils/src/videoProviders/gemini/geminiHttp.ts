import { z } from 'zod';
import {
  ProviderOutputUnavailableError,
  ProviderSubmitError,
  readBoundedResponse,
  type ProviderOutput,
  type VideoProviderContext,
} from '../types';

/**
 * Plumbing shared by every adapter that talks to generativelanguage.googleapis.com with the Gemini key. It owns
 * the security-relevant rules (which host may receive the key, what a redirect may carry, which 4xx is
 * definitive), so a fix lands once for all of them. `prefix` is the adapter's error-code prefix.
 */
export const GEMINI_API_HOST = 'generativelanguage.googleapis.com';
export const GEMINI_BASE_URL = `https://${GEMINI_API_HOST}`;

// Whole-token match on enum-like fields (status, code, finish_reason). Not a substring match: auth failures
// carry API_KEY_SERVICE_BLOCKED, and invalid-param messages can name fields such as safety_settings.
const SAFETY_TOKEN = /^(IMAGE_)?(SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII)$/i;
// Free-text messages count only in the block phrasing ("... blocked for safety reasons").
const SAFETY_PHRASE = /\bblocked\b[^.]*\b(safety|policy|policies)\b/i;
// The submit 4xx statuses a resubmit can get past; any other 4xx is deterministic for this request and key.
const RETRYABLE_SUBMIT_STATUSES: ReadonlySet<number> = new Set([408, 429]);

export const GeminiErrorSchema = z.looseObject({
  // A string ("invalid_request") on Interactions endpoints, a number on operations and Google front-end errors.
  code: z.union([z.string(), z.number()]).optional(),
  message: z.string().optional(),
  status: z.string().optional(),
});
export type GeminiError = z.infer<typeof GeminiErrorSchema>;
const ErrorEnvelopeSchema = z.looseObject({ error: GeminiErrorSchema });

/** `{ error }` from the API, `[{ error }]` from the Google front end. */
export const geminiErrorOf = (raw: unknown): GeminiError | undefined => {
  const parsed = ErrorEnvelopeSchema.safeParse(Array.isArray(raw) ? raw[0] : raw);
  return parsed.success ? parsed.data.error : undefined;
};

export const isGeminiSafetyError = (error: GeminiError | undefined, finishReason?: string): boolean =>
  [error?.status, error?.code, finishReason].some(value => typeof value === 'string' && SAFETY_TOKEN.test(value)) ||
  (error?.message !== undefined && SAFETY_PHRASE.test(error.message));

/**
 * Classifies a non-2xx submit. A safety 400 is a content outcome, not a request error: a definitive
 * ProviderSubmitError would let the engine resubmit the same prompt, so the caller turns `'blocked'` into a
 * blocked handle. Otherwise a 4xx created nothing (definitive; only a throttle is worth resubmitting) and a 5xx may have.
 */
export const classifyGeminiSubmitFailure = (
  status: number,
  raw: unknown,
  prefix: string
): 'blocked' | ProviderSubmitError => {
  if (status === 400 && isGeminiSafetyError(geminiErrorOf(raw))) return 'blocked';
  return new ProviderSubmitError(`${prefix}_http_${status}`, status < 500, raw, RETRYABLE_SUBMIT_STATUSES.has(status));
};

// The live uri carries ?alt=media, which the fixture scrubber strips; without it the endpoint is not the media.
const downloadUrlOf = (raw: string, prefix: string): URL => {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.host !== GEMINI_API_HOST) throw new Error(`${prefix}_untrusted_output_url`);
  if (!url.searchParams.has('alt')) url.searchParams.set('alt', 'media');
  return url;
};

/** Downloads a Gemini Files output. The key goes only to the Gemini host; a redirect is followed once, keyless. */
export const fetchGeminiOutput = async (
  output: ProviderOutput,
  ctx: VideoProviderContext,
  prefix: string
): Promise<Buffer> => {
  if (output.kind !== 'url') throw new Error(`${prefix}_unexpected_inline_output`);
  const url = downloadUrlOf(output.url, prefix);
  let response = await fetch(url, {
    headers: { 'x-goog-api-key': ctx.apiKey },
    redirect: 'manual',
    signal: ctx.signal,
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) throw new Error(`${prefix}_redirect_without_location`);
    const target = new URL(location, url);
    if (target.protocol !== 'https:') throw new Error(`${prefix}_untrusted_output_url`);
    await response.body?.cancel();
    response = await fetch(target, { redirect: 'error', signal: ctx.signal });
  }
  if (response.status === 404 || response.status === 410) throw new ProviderOutputUnavailableError(response.status);
  if (!response.ok) throw new Error(`${prefix}_download_http_${response.status}`);
  return readBoundedResponse(response);
};
