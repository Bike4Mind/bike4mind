import type {
  DiscoveredModel,
  DiscoveredPatch,
  DiscoveredPrice,
  DiscoveryFetchContext,
  DiscoverySource,
  SourceResult,
} from '../types';
import { isEmptyDocument, joinTargets, logCoverage, type AggregatorSourceOptions, type JoinTarget } from './aggregator';
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
  cache_read_input_token_cost?: unknown;
  /** litellm's name for the cache WRITE rate. */
  cache_creation_input_token_cost?: unknown;
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

const perMTok = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value * TOKENS_PER_MTOK : undefined;

function priceOf(entry: LiteLlmEntry): DiscoveredPrice | undefined {
  const inputPerMTok = perMTok(entry.input_cost_per_token);
  const outputPerMTok = perMTok(entry.output_cost_per_token);
  if (inputPerMTok === undefined || outputPerMTok === undefined) return undefined;
  if (inputPerMTok === 0 && outputPerMTok === 0) return undefined;
  // The `_above_*_tokens` and `_priority` variants are deliberately ignored:
  // DiscoveredPrice is one flat rate, and picking one of them would quote a
  // long-context or priority-lane price as if it were the standard one.
  return compact({
    inputPerMTok,
    outputPerMTok,
    cacheReadPerMTok: perMTok(entry.cache_read_input_token_cost),
    cacheWritePerMTok: perMTok(entry.cache_creation_input_token_cost),
  });
}

/** YYYY-MM-DD, which is how litellm writes deprecation_date. */
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * litellm's `deprecation_date` is often in the FUTURE - it is the announced
 * date, not a state. A future date therefore claims NO status: litellm does not
 * know what the model is today, and 'active' here would walk a model the catalog
 * holds as deprecated back into every picker. A past one is what makes it
 * deprecated. Either way a provider's own lifecycle feed outranks this, because
 * providers are merged first.
 */
function lifecycleOf(entry: LiteLlmEntry, at: Date): DiscoveredPatch['lifecycle'] | undefined {
  const date = typeof entry.deprecation_date === 'string' ? entry.deprecation_date.trim() : '';
  if (!CALENDAR_DATE.test(date)) return undefined;
  const today = at.toISOString().slice(0, 10);
  return date <= today ? { status: 'deprecated', deprecationDate: date } : { deprecationDate: date };
}

function patchOf(entry: LiteLlmEntry, at: Date): DiscoveredPatch {
  const reasoning = boolean(entry.supports_reasoning);
  const caching = boolean(entry.supports_prompt_caching);

  return compact<DiscoveredPatch>({
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
    const patch = patchOf(entry, at);
    // Emitted even when the patch comes out empty, which happens for the
    // per-image, per-character and per-second entries (FLUX, ElevenLabs,
    // Whisper): DiscoveredPrice models $/MTok only, so there is nothing to
    // carry. The record still goes out because AggregatorJoinCoverage is
    // computed from emitted records - dropping it would report a MATCHED id as
    // unmatched and alarm on a healthy run. The write path counts it as a
    // dropped record, which is the accurate statement: joined, nothing to say.
    records.push(
      compact<DiscoveredModel>({
        modelId,
        patch,
        pricing: priceOf(entry),
        // deprecation_date is a published field, not a scraped one.
        lifecycleEvidence: patch.lifecycle ? 'typed' : undefined,
      })
    );
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
      const response = await fetchJson<LiteLlmDocument>({ url: LITELLM_PRICES_URL, followRedirects: true }, ctx);
      if (!response.ok) return { ok: false, error: response.error, httpStatus: response.status };
      if (response.notModified) return { ok: false, error: 'unexpected 304 from a pinned tag', httpStatus: 304 };
      // Same contract every provider source honors (types.ts:154-158): a
      // valid-but-empty body is a failed fetch, not a run on which every price
      // happened to vanish. Checked on the document, not the join.
      if (isEmptyDocument(response.body)) {
        return { ok: false, error: 'litellm returned an empty document', httpStatus: response.status };
      }

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
