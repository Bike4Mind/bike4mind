import type { DecisionModelId, DecisionProtocol, RawDecisionAnswer, ValidatedDecisionRequest } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

/** Input with every image already resolved (ACL-checked, downscaled) to a base64 data URL. */
export type ResolvedDecisionInputPart =
  { type: 'text'; text: string } | { type: 'json'; json: unknown } | { type: 'image'; dataUrl: string };
export type ResolvedDecisionInput = string | readonly ResolvedDecisionInputPart[];

export type DecisionProviderRequest = {
  model: DecisionModelId;
  input: ResolvedDecisionInput;
  questions: ValidatedDecisionRequest['questions'];
  safetyIdentifier?: string;
};

export type DecisionProviderContext = {
  apiKey: string;
  logger: Logger;
  /** Carries the per-attempt deadline; pass it to every network call. An abort surfaces as `overloaded`. */
  signal: AbortSignal;
};

/** One vendor answer per question, in question order; `normalizeDecisionAnswers` turns these into the public shape. */
export type ProviderDecision = {
  /** The vendor's resolved model id (e.g. a versioned id for a `-latest` alias). */
  model: string;
  answers: RawDecisionAnswer[];
  usage: { inputTokens: number; outputTokens: number };
};

export interface DecisionProvider {
  readonly id: DecisionProtocol;
  readonly models: readonly DecisionModelId[];
  /** One bounded call. Never retries: `decideWithRetry` owns the retry policy. */
  decide(request: DecisionProviderRequest, ctx: DecisionProviderContext): Promise<ProviderDecision>;
}

/**
 * How a provider failure maps onto our envelope:
 * - `overloaded`: 429/5xx/529, timeout or network failure. Retried once on the same model, then 503 `provider_overloaded`.
 * - `rejected_key`: the vendor refused our key. 401 `provider_rejected`.
 * - `context_length`: the vendor reported a context overflow. 422 `context_length_exceeded`.
 * - `invalid_request`: a vendor 4xx our local validation did not catch. 422 `invalid_request`.
 * - `upstream`: anything else, including a response that does not fit our questions. 502 `provider_error`.
 */
export const DECISION_PROVIDER_ERROR_KINDS = [
  'overloaded',
  'rejected_key',
  'context_length',
  'invalid_request',
  'upstream',
] as const;
export type DecisionProviderErrorKind = (typeof DECISION_PROVIDER_ERROR_KINDS)[number];

export class DecisionProviderError extends Error {
  constructor(
    readonly kind: DecisionProviderErrorKind,
    message: string,
    readonly details: {
      status?: number;
      /** From the vendor's `retry-after`, in ms. */
      retryAfterMs?: number;
      /** The vendor's field path, when it names one. */
      param?: string;
      raw?: unknown;
    } = {}
  ) {
    super(message);
    this.name = 'DecisionProviderError';
  }
}
