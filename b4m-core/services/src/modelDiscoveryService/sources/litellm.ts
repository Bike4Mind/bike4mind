import type {
  DiscoveredModel,
  DiscoveredPatch,
  DiscoveredPrice,
  DiscoveredPriceBracket,
  DiscoveryFetchContext,
  DiscoverySource,
  SourceResult,
} from '../types';
import { isEmptyDocument, joinTargets, logCoverage, type AggregatorSourceOptions, type JoinTarget } from './aggregator';
import { boolean, compact, contentHashOf, count, fetchJson } from './http';

/**
 * The git ref the price blob is read from. A MOVING ref on purpose: a release tag
 * is an immutable snapshot, and a snapshot that is weeks behind reports the price
 * a provider used to charge. Two feeds then disagree about the same model, the
 * agreement check applies neither, and the stale rate keeps billing - which is
 * exactly the failure this constant used to cause.
 *
 * What protects the catalog is not the ref: no single aggregator can write a price
 * (a lone one only ever raises a flag), the two aggregators must agree within
 * PRICE_AGREEMENT_TOLERANCE, any move past modelDiscoveryPriceBandPct is flagged
 * rather than applied, operator-owned rows are untouchable, and anything else
 * suspicious keeps the row in force billing. The tradeoff accepted here is that
 * upstream data can change between two runs, which is the point of a live
 * registry; the source report records the body's `contentHash`, so "the
 * aggregator changed under us" stays answerable after the fact.
 *
 * Single constant so re-pinning to a tag is one edit if upstream ever ships a
 * commit worth pinning away from.
 */
export const LITELLM_REF = 'main';

export const LITELLM_PRICES_URL = `https://raw.githubusercontent.com/BerriAI/litellm/${LITELLM_REF}/model_prices_and_context_window.json`;

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

/** litellm's field-name prefix for each rate, and the DiscoveredRates key it lands in. */
const BRACKET_RATE_BY_PREFIX = {
  input_cost_per_token: 'inputPerMTok',
  output_cost_per_token: 'outputPerMTok',
  cache_read_input_token_cost: 'cacheReadPerMTok',
  cache_creation_input_token_cost: 'cacheWritePerMTok',
} as const satisfies Record<string, keyof DiscoveredPriceBracket>;

type BracketRateKey = (typeof BRACKET_RATE_BY_PREFIX)[keyof typeof BRACKET_RATE_BY_PREFIX];

/**
 * litellm spells a long-context bracket as a field-name family, so the breakpoint
 * is read off the NAME - nothing here knows 272k. Anchored at both ends on
 * purpose: `_above_272k_tokens_priority`, `_flex`, `_batches` and
 * `cache_creation_input_token_cost_above_1hr_above_200k_tokens` are different
 * service or cache-TTL lanes, and pricing one of them as the long-context rate
 * would overcharge every long prompt.
 */
const BRACKET_FIELD = new RegExp(`^(${Object.keys(BRACKET_RATE_BY_PREFIX).join('|')})_above_(\\d+)k_tokens$`);

/** The rate and breakpoint a litellm field name declares, or null when it is not a context bracket. */
export function parseBracketField(field: string): { rate: BracketRateKey; aboveTokens: number } | null {
  const match = BRACKET_FIELD.exec(field);
  if (!match) return null;
  const rate = BRACKET_RATE_BY_PREFIX[match[1] as keyof typeof BRACKET_RATE_BY_PREFIX];
  const thousands = Number(match[2]);
  return thousands > 0 ? { rate, aboveTokens: thousands * 1000 } : null;
}

/**
 * The entry's context brackets, ascending by breakpoint. A bracket missing either
 * text rate, or carrying an unreadable one, drops the WHOLE ladder rather than
 * part of it (gemini-1.5-flash publishes an above-128k input rate and no output
 * rate): a half ladder would leave the tier we dropped billing at the rate below
 * it, and the price planner treats a ladderless observation as flat, which is what
 * this feed has always been read as.
 */
function bracketsOf(entry: LiteLlmEntry): DiscoveredPriceBracket[] | undefined {
  const byBreakpoint = new Map<number, Partial<Record<BracketRateKey, number>>>();
  for (const [field, value] of Object.entries(entry as Record<string, unknown>)) {
    const parsed = parseBracketField(field);
    if (!parsed) continue;
    const rate = perMTok(value);
    if (rate === undefined) return undefined;
    const rates = byBreakpoint.get(parsed.aboveTokens) ?? {};
    rates[parsed.rate] = rate;
    byBreakpoint.set(parsed.aboveTokens, rates);
  }
  if (byBreakpoint.size === 0) return undefined;

  const brackets: DiscoveredPriceBracket[] = [];
  for (const [aboveTokens, rates] of [...byBreakpoint.entries()].sort(([a], [b]) => a - b)) {
    const { inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok } = rates;
    if (inputPerMTok === undefined || outputPerMTok === undefined) return undefined;
    brackets.push(
      compact<DiscoveredPriceBracket>({ aboveTokens, inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok })
    );
  }
  return brackets;
}

function priceOf(entry: LiteLlmEntry): DiscoveredPrice | undefined {
  const inputPerMTok = perMTok(entry.input_cost_per_token);
  const outputPerMTok = perMTok(entry.output_cost_per_token);
  if (inputPerMTok === undefined || outputPerMTok === undefined) return undefined;
  if (inputPerMTok === 0 && outputPerMTok === 0) return undefined;
  // The `_priority`, `_flex` and `_batches` variants stay ignored: those are
  // service tiers of the same context bracket, not brackets, and quoting one
  // would price the standard lane at a lane nobody is on.
  return compact({
    inputPerMTok,
    outputPerMTok,
    cacheReadPerMTok: perMTok(entry.cache_read_input_token_cost),
    cacheWritePerMTok: perMTok(entry.cache_creation_input_token_cost),
    brackets: bracketsOf(entry),
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
      // No conditional GET: a 304 carries no body, the join needs the body on
      // every run, and contentHash already answers "did this change since last
      // run" - so a validator would only buy an extra round trip.
      const response = await fetchJson<LiteLlmDocument>({ url: LITELLM_PRICES_URL, followRedirects: true }, ctx);
      if (!response.ok) return { ok: false, error: response.error, httpStatus: response.status };
      if (response.notModified) return { ok: false, error: 'unexpected 304 without a validator', httpStatus: 304 };
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
