import type { ModelRecord } from '@bike4mind/common';
import type { DiscoveredModel, DiscoveredPrice, DiscoveryFetchContext, DiscoverySource, SourceResult } from '../types';
import { joinTargets, logCoverage, type AggregatorSourceOptions, type JoinTarget } from './aggregator';
import { boolean, compact, contentHashOf, count, fetchJson } from './http';

/**
 * PINNED TO A RELEASE TAG, NEVER `main` (sec 6.5). This file is third-party data
 * fetched on a schedule and turned into prices; reading it from a moving branch
 * would mean an unreviewed upstream commit can reprice the catalog between two
 * runs. Bumping this constant is the review.
 */
export const LITELLM_RELEASE_TAG = 'v1.93.0';

export const LITELLM_PRICES_URL = `https://raw.githubusercontent.com/BerriAI/litellm/${LITELLM_RELEASE_TAG}/model_prices_and_context_window.json`;

/** The document's own self-describing template row, not a model. */
const SAMPLE_SPEC_KEY = 'sample_spec';

interface LiteLlmEntry {
  max_input_tokens?: unknown;
  max_output_tokens?: unknown;
  max_tokens?: unknown;
  input_cost_per_token?: unknown;
  output_cost_per_token?: unknown;
  supports_vision?: unknown;
  supports_function_calling?: unknown;
  supports_response_schema?: unknown;
  supports_pdf_input?: unknown;
  supports_prompt_caching?: unknown;
  supports_reasoning?: unknown;
  /** The correct no-temperature signal; `supported_parameters` on gateways is not. */
  supports_sampling_params?: unknown;
  deprecation_date?: unknown;
  litellm_provider?: unknown;
  mode?: unknown;
}

export type LiteLlmDocument = Record<string, LiteLlmEntry>;

/** litellm quotes cost per SINGLE token, so $/MTok is a factor of 1e6. */
export const TOKENS_PER_MTOK = 1_000_000;

const TOKEN_PRICE_KEYS = ['input_cost_per_token', 'output_cost_per_token'] as const;

function priceOf(entry: LiteLlmEntry): DiscoveredPrice | undefined {
  const [input, output] = TOKEN_PRICE_KEYS.map(key => {
    const value = entry[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value * TOKENS_PER_MTOK : undefined;
  });
  if (input === undefined || output === undefined) return undefined;
  if (input === 0 && output === 0) return undefined;
  return { inputPerMTok: input, outputPerMTok: output };
}

/** YYYY-MM-DD, which is how litellm writes deprecation_date. */
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * litellm's `deprecation_date` is often in the FUTURE - it is the announced
 * date, not a state. A future date leaves the model active and records the date;
 * a past one is what makes it deprecated. Either way a provider's own lifecycle
 * feed outranks this, because providers are merged first.
 */
function lifecycleOf(entry: LiteLlmEntry, at: Date): ModelRecord['lifecycle'] | undefined {
  const date = typeof entry.deprecation_date === 'string' ? entry.deprecation_date.trim() : '';
  if (!CALENDAR_DATE.test(date)) return undefined;
  const today = at.toISOString().slice(0, 10);
  return { status: date <= today ? 'deprecated' : 'active', deprecationDate: date };
}

function patchOf(entry: LiteLlmEntry, at: Date): Partial<ModelRecord> {
  const reasoning = boolean(entry.supports_reasoning);
  const caching = boolean(entry.supports_prompt_caching);

  return compact<Partial<ModelRecord>>({
    contextWindow: count(entry.max_input_tokens),
    maxOutputTokens: count(entry.max_output_tokens) ?? count(entry.max_tokens),
    reasoning: reasoning === undefined ? undefined : { supported: reasoning },
    // Only the explicit false is a signal. Absence means litellm did not say,
    // and `true` does not rule out a provider pinning the value.
    temperatureMode: entry.supports_sampling_params === false ? 'unsupported' : undefined,
    supportsVision: boolean(entry.supports_vision),
    supportsTools: boolean(entry.supports_function_calling),
    supportsStructuredOutput: boolean(entry.supports_response_schema),
    supportsPdfInput: boolean(entry.supports_pdf_input),
    promptCaching: caching === undefined ? undefined : { supported: caching },
    lifecycle: lifecycleOf(entry, at),
  });
}

export function indexLiteLlm(document: unknown): Map<string, LiteLlmEntry> {
  const entries = new Map<string, LiteLlmEntry>();
  for (const [key, entry] of Object.entries((document ?? {}) as LiteLlmDocument)) {
    if (key === SAMPLE_SPEC_KEY || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    entries.set(key, entry);
  }
  return entries;
}

export function normalizeLiteLlm(
  document: unknown,
  targets: readonly JoinTarget[],
  at: Date,
  aliases?: AggregatorSourceOptions['aliases']
): { records: DiscoveredModel[]; unmatched: string[] } {
  const { matched, unmatched } = joinTargets(targets, indexLiteLlm(document), 'litellm', aliases);

  const records: DiscoveredModel[] = [];
  for (const [modelId, entry] of matched) {
    // Emitted even when the patch comes out empty, which happens for the
    // per-image, per-character and per-second entries (FLUX, ElevenLabs,
    // Whisper): DiscoveredPrice models $/MTok only, so there is nothing to
    // carry. The record still goes out because AggregatorJoinCoverage is
    // computed from emitted records - dropping it would report a MATCHED id as
    // unmatched and alarm on a healthy run. The write path counts it as a
    // dropped record, which is the accurate statement: joined, nothing to say.
    records.push(compact({ modelId, patch: patchOf(entry, at), pricing: priceOf(entry) }));
  }

  return { records: records.sort((a, b) => a.modelId.localeCompare(b.modelId)), unmatched: unmatched.sort() };
}

export function createLiteLlmSource(options: AggregatorSourceOptions): DiscoverySource {
  return {
    name: 'litellm',
    kind: 'aggregator',
    isConfigured: () => true,
    async fetch(ctx: DiscoveryFetchContext): Promise<SourceResult> {
      // No conditional GET: a tagged file is immutable, so a validator would
      // only ever answer a question the tag already answers.
      const response = await fetchJson<LiteLlmDocument>({ url: LITELLM_PRICES_URL }, ctx);
      if (!response.ok) return { ok: false, error: response.error, httpStatus: response.status };
      if (response.notModified) return { ok: false, error: 'unexpected 304 from a pinned tag', httpStatus: 304 };

      const targets = await options.targets();
      const { records, unmatched } = normalizeLiteLlm(response.body, targets, ctx.runStartedAt, options.aliases);
      logCoverage(ctx, 'litellm', { matched: new Map(records.map(r => [r.modelId, r])), unmatched });

      return {
        ok: true,
        records,
        httpStatus: response.status,
        etag: response.etag,
        contentHash: contentHashOf(response.text),
      };
    },
  };
}
