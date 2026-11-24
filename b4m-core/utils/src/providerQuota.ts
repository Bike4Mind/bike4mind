/**
 * Every provider reason for an exhausted account quota ends in this suffix (e.g.
 * `elevenlabs_sound_effect_quota_exhausted`), so job errors and routes can recognise one without a new error code.
 */
export const QUOTA_EXHAUSTED_REASON_SUFFIX = '_quota_exhausted';

export const isQuotaExhaustedReason = (reason: unknown): boolean =>
  typeof reason === 'string' && reason.endsWith(QUOTA_EXHAUSTED_REASON_SUFFIX);

// Machine codes only, never free text: a message can echo caller input.
const QUOTA_MARKERS = new Set(['quota_exceeded', 'quota_exhausted', 'insufficient_quota', 'insufficient_credits']);
const QUOTA_STATUSES_NEEDING_A_MARKER = new Set([401, 403, 429]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const parseBody = (body: unknown): unknown => {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

// ElevenLabs nests its codes under `detail`, OpenAI under `error` (and repeats `code`/`type` on the SDK error).
const markersOf = (body: unknown): string[] => {
  const parsed = parseBody(body);
  if (!isRecord(parsed)) return [];
  return [parsed, parsed.detail, parsed.error]
    .filter(isRecord)
    .flatMap(holder => [holder.code, holder.status, holder.type])
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.toLowerCase());
};

/**
 * True when a provider's refusal says the account is out of quota or credits: any HTTP 402, or a 401/403/429 whose
 * body carries a quota marker (ElevenLabs answers 401 with `detail.status: quota_exceeded`, OpenAI 429 with
 * `insufficient_quota`). A plain 401 is a bad key and a plain 429 a rate limit, so neither matches.
 */
export const isQuotaExhaustedResponse = (status: number, ...bodies: unknown[]): boolean => {
  if (status === 402) return true;
  if (!QUOTA_STATUSES_NEEDING_A_MARKER.has(status)) return false;
  return bodies.some(body => markersOf(body).some(marker => QUOTA_MARKERS.has(marker)));
};

/**
 * The provider account behind our key is out of quota or credits. An operational state (it needs a top-up, not a
 * code fix), so callers log it at warn and tell the user the feature is temporarily unavailable. `status` and
 * `detail` mirror the other provider errors so toAudioProviderResult can still classify it.
 */
export class ProviderQuotaExhaustedError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly detail: string,
    message: string
  ) {
    super(message);
    this.name = 'ProviderQuotaExhaustedError';
  }
}
