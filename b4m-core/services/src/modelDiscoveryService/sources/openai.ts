import { ModelBackend, type ModelRecord } from '@bike4mind/common';
import type {
  DiscoveredModel,
  DiscoveredPrice,
  DiscoveryCredentials,
  DiscoveryFetchContext,
  DiscoverySource,
  DiscoverySourceOk,
  SourceResult,
} from '../types';
import {
  OPENAI_PRICING_URL,
  openAiModelDocUrl,
  parseOpenAiLongContextBreakpoint,
  parseOpenAiPricing,
  type OpenAiPriceRow,
  type OpenAiRates,
} from './openaiDocs';
import { PAGINATED_SOURCE_DEADLINE_MS } from '../runModelDiscovery';
import { compact, fetchJson, fetchText, hasTimeLeft, text } from './http';

export const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';

/**
 * Model pages read for a breakpoint in one run. The set is the rows that publish
 * long-context rates without stating the breakpoint inline, which is a handful of
 * frontier models rather than the whole catalog; the cap is a runaway guard for a
 * page restructure that made every row look like one of them.
 */
export const OPENAI_MAX_MODEL_DOC_FETCHES = 12;

/**
 * OpenAI's list is four fields wide (id, object, created, owned_by) and no richer
 * endpoint exists, so the API half of this source is an availability signal and
 * nothing else: context and capabilities still come from the aggregators.
 *
 * Pricing does NOT, any more. OpenAI publishes a markdown twin of its pricing
 * page, so this source is a provider price for its own models and they no longer
 * need two mirrors to agree before a change is applied (see openaiDocs.ts).
 *
 * It deliberately emits NO `name` and NO `contextWindow`. Emitting `name: id`
 * would overwrite every seeded display name with a lowercase id and append a row
 * every single run; emitting `contextWindow: 0` would beat models.dev's real
 * value, because a provider outranks an aggregator for every field it claims.
 * The consequence is stated rather than hidden: a model OpenAI lists that the
 * catalog has never held cannot be added by this source alone - it has no
 * context window from anywhere - and shows up in the run's dropped records.
 */
interface OpenAiModel {
  id?: unknown;
  object?: unknown;
  created?: unknown;
  owned_by?: unknown;
}

interface OpenAiModelList {
  data?: unknown;
}

/**
 * OpenAI encodes the model kind in the id namespace and nowhere else. Only the
 * unambiguous namespaces are classified; an unrecognized id omits `type` rather
 * than defaulting to 'text', so a new modality is a dropped-and-counted record
 * instead of a mislabeled picker entry.
 */
function inferType(id: string): ModelRecord['type'] | undefined {
  if (id.startsWith('whisper') || id.endsWith('-transcribe')) return 'speech-to-text';
  if (id.startsWith('sora-')) return 'video';
  if (id.startsWith('gpt-image-') || id.startsWith('dall-e-')) return 'image';
  if (id.startsWith('text-embedding-')) return 'embedding';
  if (id.startsWith('tts-') || id.endsWith('-tts')) return 'tts';
  if (id.includes('realtime')) return 'realtime-voice';
  return undefined;
}

export function normalizeOpenAiModels(payload: unknown): DiscoveredModel[] {
  const list = payload as OpenAiModelList | null;
  const data = Array.isArray(list?.data) ? (list.data as OpenAiModel[]) : [];
  const records: DiscoveredModel[] = [];

  for (const entry of data) {
    const id = text(entry?.id);
    // `object` is an open enum; anything other than a model is skipped rather
    // than guessed at, and a missing one is tolerated because the id is the fact.
    if (!id || (entry?.object !== undefined && entry.object !== 'model')) continue;
    records.push({
      modelId: id,
      patch: compact<Partial<ModelRecord>>({
        id,
        vendor: 'openai',
        backend: ModelBackend.OpenAI,
        type: inferType(id),
      }),
    });
  }

  return records.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

/**
 * Fold the pricing page onto the API listing. A model the page does not carry, or
 * carries in a shape this source will not price, keeps the availability signal
 * and falls through to the aggregators exactly as it did before.
 */
export function mergeOpenAiPricing(
  models: readonly DiscoveredModel[],
  pricing: readonly OpenAiPriceRow[] | undefined
): DiscoveredModel[] {
  if (!pricing) return [...models];
  const byId = new Map(pricing.map(row => [row.modelId, row]));

  return models.map(record => {
    const price = toPrice(byId.get(record.modelId));
    return price ? { ...record, pricing: price } : record;
  });
}

/**
 * The row as a DiscoveredPrice, or nothing.
 *
 * A row with long-context rates and no breakpoint is the one case that yields
 * NOTHING rather than the base rates. This source is a provider, so its value
 * wins over any aggregator that corroborates it; publishing the short-prompt rate
 * alone would both understate long prompts and, being flat, block the tiered
 * reprice the aggregators can still do between them. Saying nothing leaves that
 * model exactly where it was before this source existed.
 */
function toPrice(row: OpenAiPriceRow | undefined): DiscoveredPrice | undefined {
  if (!row) return undefined;
  if (!row.longContext) return rates(row);
  if (row.longContextAboveTokens === undefined) return undefined;
  return { ...rates(row), brackets: [{ aboveTokens: row.longContextAboveTokens, ...rates(row.longContext) }] };
}

const rates = (from: OpenAiRates): OpenAiRates =>
  compact({
    inputPerMTok: from.inputPerMTok,
    outputPerMTok: from.outputPerMTok,
    cacheReadPerMTok: from.cacheReadPerMTok,
    cacheWritePerMTok: from.cacheWritePerMTok,
  });

export function createOpenAiSource(): DiscoverySource {
  return {
    name: 'openai',
    kind: 'provider',
    // A listing, the pricing page, and a model page per unannotated ladder.
    deadlineMs: PAGINATED_SOURCE_DEADLINE_MS,
    isConfigured: (creds: DiscoveryCredentials) => Boolean(creds.openai),
    async fetch(ctx: DiscoveryFetchContext): Promise<SourceResult> {
      const response = await fetchJson<OpenAiModelList>(
        { url: OPENAI_MODELS_URL, headers: { authorization: `Bearer ${ctx.credentials.openai ?? ''}` } },
        ctx
      );
      if (!response.ok) return { ok: false, error: response.error, httpStatus: response.status };
      if (response.notModified) return { ok: false, error: 'unexpected 304 from a provider list' };

      const records = normalizeOpenAiModels(response.body);
      // A 200 listing zero models is a broken parse or a broken account, never
      // "OpenAI retired everything". Failing here keeps absence bookkeeping frozen.
      if (records.length === 0) return { ok: false, error: 'model list was empty', httpStatus: response.status };

      const pricing = await readPricing(records, ctx);

      return compact<DiscoverySourceOk>({
        ok: true,
        records: mergeOpenAiPricing(records, pricing),
        authoritativeFor: [ModelBackend.OpenAI],
        httpStatus: response.status,
        // Only when the parser ran: a page that failed to fetch has no count, and
        // comparing against a missing one would read as a 100% move.
        parserRows: pricing ? { pricing: pricing.length } : undefined,
      });
    },
  };
}

/**
 * The pricing table, with every breakpoint this source could resolve filled in.
 * Undefined on a fetch or parse failure: the caller keeps the availability signal
 * and the prices fall through to whatever the catalog already believes.
 */
async function readPricing(
  models: readonly DiscoveredModel[],
  ctx: DiscoveryFetchContext
): Promise<OpenAiPriceRow[] | undefined> {
  // The docs host redirects and this request carries no credential, so following
  // is safe here and only here (see HttpRequest.followRedirects).
  const response = await fetchText(
    { url: OPENAI_PRICING_URL, headers: { accept: 'text/markdown, text/plain' }, followRedirects: true },
    ctx
  );
  if (!response.ok || response.notModified) {
    ctx.logger.warn(`[model-discovery] openai docs ${OPENAI_PRICING_URL} unavailable`);
    return undefined;
  }

  const parsed = parseOpenAiPricing(response.text);
  if (!parsed.ok) {
    ctx.logger.warn(`[model-discovery] openai docs parser broke: ${parsed.error}`);
    return undefined;
  }

  const listed = new Set(models.map(record => record.modelId));
  const pending = parsed.rows.filter(
    row => listed.has(row.modelId) && row.longContext && row.longContextAboveTokens === undefined
  );
  if (pending.length === 0) return parsed.rows;

  const resolved = new Map<string, number>();
  let read = 0;
  for (const row of pending) {
    if (read >= OPENAI_MAX_MODEL_DOC_FETCHES || !hasTimeLeft(ctx)) {
      // Never a silent cut: the models left unread are the ones toPrice will
      // refuse to price, and that has to be answerable from the run's logs.
      ctx.logger.warn(
        `[model-discovery] openai docs: stopped after ${read} model pages, ` +
          `${pending.length - read} long-context breakpoints unresolved`
      );
      break;
    }
    read += 1;
    const breakpoint = await readBreakpoint(row.modelId, ctx);
    if (breakpoint !== undefined) resolved.set(row.modelId, breakpoint);
  }

  return parsed.rows.map(row => {
    const breakpoint = resolved.get(row.modelId);
    return breakpoint === undefined ? row : { ...row, longContextAboveTokens: breakpoint };
  });
}

async function readBreakpoint(modelId: string, ctx: DiscoveryFetchContext): Promise<number | undefined> {
  const url = openAiModelDocUrl(modelId);
  const response = await fetchText(
    { url, headers: { accept: 'text/markdown, text/plain' }, followRedirects: true },
    ctx
  );
  if (!response.ok || response.notModified) {
    ctx.logger.warn(`[model-discovery] openai docs ${url} unavailable`);
    return undefined;
  }
  const breakpoint = parseOpenAiLongContextBreakpoint(response.text);
  if (breakpoint === undefined) {
    ctx.logger.warn(`[model-discovery] openai docs: ${modelId} publishes long-context rates but no breakpoint`);
  }
  return breakpoint;
}
