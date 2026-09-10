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
  parseOpenAiModelPage,
  parseOpenAiPricing,
  type OpenAiModelPage,
  type OpenAiPriceRow,
  type OpenAiRates,
} from './openaiDocs';
import { isIntroducibleModelId } from '../catalogWrite';
import { PAGINATED_SOURCE_DEADLINE_MS } from '../runModelDiscovery';
import { compact, count, fetchJson, fetchText, hasTimeLeft, text } from './http';

export const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';

/**
 * Model pages read for a breakpoint in one run. The set is the rows that publish
 * long-context rates without stating the breakpoint inline, which is a handful of
 * frontier models rather than the whole catalog; the cap is a runaway guard for a
 * page restructure that made every row look like one of them.
 */
export const OPENAI_MAX_MODEL_DOC_FETCHES = 12;

/**
 * Model pages read for a NEW model's facts in one run. Its own count, so a run
 * that sights twenty new ids cannot cost the pricing legs their pages; the
 * leftovers are read by the next run, newest first.
 */
export const OPENAI_MAX_NEW_MODEL_DOC_FETCHES = 6;

/**
 * Budget for the docs legs, separate from the source deadline and SHARED by
 * them: prices run first and the new-model leg takes what is left.
 *
 * The listing is already in hand by the time these run, and the runner races the
 * whole `fetch()` against the source deadline: a docs host that HANGS would take
 * the successful api.openai.com listing down with it, costing this backend its
 * availability signal and its absence bookkeeping for the run. The docs are the
 * optional half of this source and must not be able to do that.
 */
export const OPENAI_DOCS_BUDGET_MS = 20_000;

/**
 * OpenAI's list is four fields wide (id, object, created, owned_by) and no richer
 * endpoint exists, so the API half of this source is an availability signal and
 * nothing else: context and capabilities for a model the catalog HOLDS still come
 * from the aggregators.
 *
 * Pricing does NOT, any more. OpenAI publishes a markdown twin of its pricing
 * page, so this source is a provider price for its own models and they no longer
 * need two mirrors to agree before a change is applied (see openaiDocs.ts).
 *
 * For a model the catalog HOLDS it still emits NO `name` and NO `contextWindow`.
 * Emitting `name: id` would overwrite every seeded display name with a lowercase
 * id and append a row every single run; `contextWindow: 0` would beat
 * models.dev's real value, because a provider outranks an aggregator.
 *
 * For an id it does NOT hold (OpenAiSourceOptions.knownModelIds) it reads that
 * model's own docs page and emits what the page states. Nothing is invented: an
 * id whose page it cannot read is emitted exactly as the listing gave it, and
 * planCatalogWrites then refuses to introduce it - OpenAI lists far more ids
 * than it sells, and a parsed name is what tells the two apart.
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
 * The chat namespaces, checked only AFTER every modality marker below, so
 * `gpt-image-*`, `gpt-4o-mini-tts` and the realtime ids keep their own type
 * instead of being flattened into text. `o1`/`o3`/`o4` are anchored with a
 * boundary because "omni-moderation-latest" is also an id OpenAI lists.
 */
const CHAT_NAMESPACES: readonly RegExp[] = [/^gpt-/, /^chatgpt-/, /^o[134](-|$)/, /^codex-/];

/** Audio in, audio out. The catalog's `type` enum has no member for it. */
const AUDIO_MARKER = /(^|-)audio(-|$)/;

/**
 * OpenAI encodes the model kind in the id namespace and nowhere else. Only the
 * unambiguous namespaces are classified; an unrecognized id omits `type` rather
 * than defaulting to 'text', so a new modality is a dropped-and-counted record
 * instead of a mislabeled picker entry.
 *
 * The chat allowlist is part of that promise, not an exception to it: a `gpt-`,
 * `chatgpt-`, o-series or `codex-` id carrying no modality marker IS a chat
 * model, and refusing to say so was what left every new one unable to enter the
 * catalog at all. A namespace this function has not been taught is still dropped.
 */
function inferType(id: string): ModelRecord['type'] | undefined {
  if (id.startsWith('whisper') || id.endsWith('-transcribe')) return 'speech-to-text';
  if (id.startsWith('sora-')) return 'video';
  if (id.startsWith('gpt-image-') || id.startsWith('dall-e-')) return 'image';
  if (id.startsWith('text-embedding-')) return 'embedding';
  if (id.startsWith('tts-') || id.endsWith('-tts')) return 'tts';
  if (id.includes('realtime')) return 'realtime-voice';
  // 'text' would be a lie about a model whose point is speech in and speech out,
  // and there is no member to classify it as, so it stays unknown.
  if (AUDIO_MARKER.test(id)) return undefined;
  return CHAT_NAMESPACES.some(namespace => namespace.test(id)) ? 'text' : undefined;
}

export function normalizeOpenAiModels(payload: unknown): {
  records: DiscoveredModel[];
  /** Unix seconds per id. Not a catalog field: it only orders the docs budget. */
  createdAt: Map<string, number>;
} {
  const list = payload as OpenAiModelList | null;
  const data = Array.isArray(list?.data) ? (list.data as OpenAiModel[]) : [];
  const records: DiscoveredModel[] = [];
  const createdAt = new Map<string, number>();

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
    const at = count(entry?.created);
    if (at !== undefined) createdAt.set(id, at);
  }

  records.sort((a, b) => a.modelId.localeCompare(b.modelId));
  return { records, createdAt };
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

export interface OpenAiSourceOptions {
  /**
   * Every model id the catalog holds, in any lifecycle state. Only the ids NOT in
   * here get their docs page read: for a model the catalog holds, `name` and
   * `contextWindow` already belong to a seed, an operator or an aggregator, and a
   * provider claim would outrank all three.
   *
   * Injected rather than read off DiscoveryFetchContext because the context
   * deliberately carries no catalog - the same reason createBedrockSource takes
   * `activeModelIds`. Unset, or undefined because the catalog read FAILED, means
   * the source cannot tell a new id from a held one, so the leg does not run:
   * an empty set would make every listed id look new.
   */
  knownModelIds?: () => ReadonlySet<string> | undefined | Promise<ReadonlySet<string> | undefined>;
}

export function createOpenAiSource(options: OpenAiSourceOptions = {}): DiscoverySource {
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

      const { records, createdAt } = normalizeOpenAiModels(response.body);
      // A 200 listing zero models is a broken parse or a broken account, never
      // "OpenAI retired everything". Failing here keeps absence bookkeeping frozen.
      if (records.length === 0) return { ok: false, error: 'model list was empty', httpStatus: response.status };

      const docs = docsContext(ctx);
      const pricing = await readPricing(records, docs);
      const facts = await readNewModelFacts(records, createdAt, options, docs);

      return compact<DiscoverySourceOk>({
        ok: true,
        records: mergeOpenAiPricing(withFacts(records, facts), pricing),
        authoritativeFor: [ModelBackend.OpenAI],
        httpStatus: response.status,
        // Set only when the parser ran, because comparing against a missing count
        // would read as a 100% move. OBSERVABILITY ONLY: a detected shift logs and
        // raises DocsParserRowShift, and the runner feeds droppedDocsSources to
        // planLifecycleSignals alone - it never suppresses a price, from this
        // source or from anthropic. This source emits no lifecycle at all, so a
        // shift here changes nothing about what the run writes. What actually
        // protects the rates is the table and column selection below, the
        // corroboration rule, and the price band.
        //
        // The new-model leg is deliberately NOT reported here: its row count is
        // "how many models OpenAI shipped since the last run", which varies by
        // design, and detectParserRowShifts would read that as a restructure.
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
  // The docs host redirects, and following is safe on a request that carries no
  // credential (see HttpRequest.followRedirects for what a redirect would replay).
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
  // This request follows redirects, so a soft 404 or an index page answers 200
  // with somebody else's document - and the breakpoint parser takes the first
  // match in whatever it is handed. Every model page states its own id, so
  // require it rather than trusting the URL we asked for.
  if (!response.text.includes(`Model ID: \`${modelId}\``)) {
    ctx.logger.warn(`[model-discovery] openai docs: ${url} did not answer with ${modelId}'s page`);
    return undefined;
  }
  const breakpoint = parseOpenAiLongContextBreakpoint(response.text);
  if (breakpoint === undefined) {
    ctx.logger.warn(`[model-discovery] openai docs: ${modelId} publishes long-context rates but no breakpoint`);
  }
  return breakpoint;
}

/**
 * Facts for the ids the catalog does not hold yet, each off that model's own page.
 *
 * The parsed name is also what lets planCatalogWrites introduce an OpenAI model
 * at all, so a page this cannot read means no new row rather than a row labelled
 * with a raw id.
 */
async function readNewModelFacts(
  models: readonly DiscoveredModel[],
  createdAt: ReadonlyMap<string, number>,
  options: OpenAiSourceOptions,
  ctx: DiscoveryFetchContext
): Promise<Map<string, Partial<ModelRecord>>> {
  const facts = new Map<string, Partial<ModelRecord>>();
  if (!options.knownModelIds) return facts;
  const known = await options.knownModelIds();
  if (!known) return facts;

  // Only ids that could become a catalog model, newest first, and only text: a
  // context-window bullet is the one fact parseOpenAiModelPage cannot read a page
  // without, and an image, transcribe or realtime page states none, so those ids
  // would spend a slot every run and never yield a row. isIntroducibleModelId is
  // what planCatalogWrites refuses a snapshot or a fine-tune by. Without all
  // three filters the newest unintroducible ids take the whole budget every run.
  const pending = models
    .filter(record => record.patch.type === 'text' && !known.has(record.modelId))
    .map(record => record.modelId)
    .filter(isIntroducibleModelId)
    .sort((a, b) => (createdAt.get(b) ?? 0) - (createdAt.get(a) ?? 0) || a.localeCompare(b));

  let read = 0;
  for (const modelId of pending) {
    if (read >= OPENAI_MAX_NEW_MODEL_DOC_FETCHES || !hasTimeLeft(ctx)) {
      // The ids left unread are the ones that land with an id for a name, so the
      // cut stays answerable from the run's logs. Info, not a warning: a cap
      // reached on a run that sighted twenty new ids is working correctly.
      ctx.logger.info(
        `[model-discovery] openai docs: read ${read} new-model pages, ${pending.length - read} left for the next run`
      );
      break;
    }
    read += 1;
    const page = await readModelPage(modelId, ctx);
    if (page) facts.set(modelId, patchFromPage(page));
  }

  return facts;
}

/** Every field here is one the page STATES; see OpenAiModelPage for what is left out. */
function patchFromPage(page: OpenAiModelPage): Partial<ModelRecord> {
  const inputs = page.inputModalities;
  return compact<Partial<ModelRecord>>({
    name: page.name,
    contextWindow: page.contextWindow,
    maxOutputTokens: page.maxOutputTokens,
    supportsVision: inputs ? inputs.includes('image') : undefined,
    // No `style`: it decides how a request builder shapes the call, and no feed
    // may author dispatch. `reasoning` is claimed because requiresFixedTemp in
    // llm-adapters' openaiBackend reads it off the catalog.
    reasoning: page.reasoning ? { supported: true } : undefined,
  });
}

/** The listing's records with the new-model facts folded in, leaving the rest untouched. */
const withFacts = (
  models: readonly DiscoveredModel[],
  facts: ReadonlyMap<string, Partial<ModelRecord>>
): DiscoveredModel[] =>
  models.map(record => {
    const patch = facts.get(record.modelId);
    return patch ? { ...record, patch: { ...record.patch, ...patch } } : record;
  });

/** One model's page, or nothing: an id with no page keeps the listing's record as it is. */
async function readModelPage(modelId: string, ctx: DiscoveryFetchContext): Promise<OpenAiModelPage | undefined> {
  const url = openAiModelDocUrl(modelId);
  const response = await fetchText(
    { url, headers: { accept: 'text/markdown, text/plain' }, followRedirects: true },
    ctx
  );
  if (!response.ok) {
    // 404 is the ordinary answer for an id with no page of its own, and the count
    // of ids left unread is logged above, so it is not warned about one by one.
    if (response.status !== 404) ctx.logger.warn(`[model-discovery] openai docs ${url} unavailable`);
    return undefined;
  }
  if (response.notModified) return undefined;

  const parsed = parseOpenAiModelPage(response.text);
  if (!parsed.ok) {
    ctx.logger.warn(`[model-discovery] openai docs: ${url} did not parse: ${parsed.error}`);
    return undefined;
  }
  const page = parsed.rows[0];
  // This request follows redirects, so a soft 404 answers 200 with somebody
  // else's document; every model page states its own id, so require it rather
  // than trusting the URL we asked for.
  if (!page || page.modelId !== modelId) {
    ctx.logger.warn(`[model-discovery] openai docs: ${url} did not answer with ${modelId}'s page`);
    return undefined;
  }
  return page;
}

/**
 * The context the docs legs run under: the run's signal, plus a budget of its
 * own so a hung docs host cannot consume the source deadline and take the
 * listing down with it (see OPENAI_DOCS_BUDGET_MS).
 */
function docsContext(ctx: DiscoveryFetchContext): DiscoveryFetchContext {
  const deadlineAt = new Date(Math.min(ctx.deadlineAt.getTime(), Date.now() + OPENAI_DOCS_BUDGET_MS));
  const budget = AbortSignal.timeout(Math.max(0, deadlineAt.getTime() - Date.now()));
  return { ...ctx, deadlineAt, signal: AbortSignal.any([ctx.signal, budget]) };
}
