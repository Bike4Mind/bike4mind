import { ModelBackend, type ModelRecord } from '@bike4mind/common';
import type {
  DiscoveredModel,
  DiscoveredPrice,
  DiscoveryCredentials,
  DiscoveryFetchContext,
  DiscoverySource,
  SourceResult,
} from '../types';
import {
  ANTHROPIC_DEPRECATIONS_URL,
  ANTHROPIC_PRICING_URL,
  parseAnthropicDeprecations,
  parseAnthropicPricing,
  priceInForce,
  type AnthropicLifecycleRow,
  type AnthropicPriceRow,
} from './anthropicDocs';
import { boolean, compact, count, fetchJson, fetchText, hasTimeLeft, text } from './http';

export const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_PAGE_SIZE = 1000;

/** 1000 per page against ~20 models; more than two pages means the cursor is stuck. */
export const ANTHROPIC_MAX_PAGES = 5;

interface CapabilitySupport {
  supported?: unknown;
}

interface AnthropicCapabilities {
  batch?: CapabilitySupport;
  citations?: CapabilitySupport;
  code_execution?: CapabilitySupport;
  effort?: CapabilitySupport & Record<string, unknown>;
  image_input?: CapabilitySupport;
  pdf_input?: CapabilitySupport;
  structured_outputs?: CapabilitySupport;
  thinking?: CapabilitySupport & { types?: Record<string, CapabilitySupport | null> };
}

interface AnthropicModel {
  id?: unknown;
  type?: unknown;
  display_name?: unknown;
  max_input_tokens?: unknown;
  max_tokens?: unknown;
  capabilities?: AnthropicCapabilities | null;
}

export interface AnthropicModelPage {
  data?: unknown;
  has_more?: unknown;
  last_id?: unknown;
}

/** Effort levels in the order Anthropic escalates them, filtered to what the model takes. */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const supported = (node: CapabilitySupport | null | undefined): boolean | undefined => boolean(node?.supported);

function reasoningOf(capabilities: AnthropicCapabilities | null | undefined): ModelRecord['reasoning'] | undefined {
  const thinking = capabilities?.thinking;
  const isSupported = supported(thinking);
  if (isSupported === undefined) return undefined;

  // 'adaptive' is the 4.7+ shape (thinking: {type:'adaptive'} + output_config.effort);
  // everything older takes the budget_tokens form. Which one is live decides how
  // the request is built, so it is read rather than inferred from the model name.
  const adaptive = supported(thinking?.types?.adaptive);
  const effort = capabilities?.effort;
  const levels = supported(effort)
    ? EFFORT_LEVELS.filter(level => supported(effort?.[level] as CapabilitySupport | null | undefined))
    : [];

  return compact<NonNullable<ModelRecord['reasoning']>>({
    supported: isSupported,
    style: isSupported ? (adaptive ? 'anthropic-adaptive' : 'anthropic-legacy') : undefined,
    effortLevels: levels.length > 0 ? levels : undefined,
  });
}

export function normalizeAnthropicModels(pages: readonly unknown[]): DiscoveredModel[] {
  const records = new Map<string, DiscoveredModel>();

  for (const page of pages) {
    const list = (page as AnthropicModelPage | null)?.data;
    if (!Array.isArray(list)) continue;

    for (const entry of list as AnthropicModel[]) {
      const id = text(entry?.id);
      if (!id || (entry?.type !== undefined && entry.type !== 'model')) continue;
      const capabilities = entry?.capabilities ?? null;

      records.set(id, {
        modelId: id,
        patch: compact<Partial<ModelRecord>>({
          id,
          vendor: 'anthropic',
          backend: ModelBackend.Anthropic,
          type: 'text',
          name: text(entry?.display_name),
          contextWindow: count(entry?.max_input_tokens),
          maxOutputTokens: count(entry?.max_tokens),
          canStream: true,
          reasoning: reasoningOf(capabilities),
          supportsVision: supported(capabilities?.image_input),
          supportsPdfInput: supported(capabilities?.pdf_input),
          supportsStructuredOutput: supported(capabilities?.structured_outputs),
        }),
      });
    }
  }

  return [...records.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
}

/**
 * Docs slug for a model id: the ids the pricing page is keyed by are the display
 * names, which slug to the undated id ("Claude Opus 4.5" -> `claude-opus-4-5`,
 * and `claude-opus-4-5-20251101` -> the same).
 */
export const pricingSlugFor = (modelId: string): string => modelId.toLowerCase().replace(/-\d{8}$/, '');

export interface AnthropicFacts {
  models: readonly DiscoveredModel[];
  lifecycle?: readonly AnthropicLifecycleRow[];
  pricing?: readonly AnthropicPriceRow[];
  at: Date;
}

/**
 * Fold the two docs feeds onto the API listing. Both are optional: a docs page
 * that moved must not cost us the availability signal for every Claude model,
 * so a parser failure degrades that one field group and nothing else.
 */
export function mergeAnthropicFacts({ models, lifecycle, pricing, at }: AnthropicFacts): DiscoveredModel[] {
  const lifecycleById = new Map((lifecycle ?? []).map(row => [row.modelId, row]));

  return models.map(record => {
    const row = lifecycleById.get(record.modelId);
    const price = pricing ? priceInForce(pricing, pricingSlugFor(record.modelId), at) : undefined;

    return {
      ...record,
      patch: row
        ? {
            ...record.patch,
            lifecycle: compact<NonNullable<ModelRecord['lifecycle']>>({
              status: row.status,
              deprecationDate: row.deprecationDate,
              retirementDate: row.retirementDate,
              replacedBy: row.replacedBy,
            }),
          }
        : record.patch,
      ...(price ? { pricing: toPrice(price) } : {}),
    };
  });
}

const toPrice = (row: AnthropicPriceRow): DiscoveredPrice => ({
  inputPerMTok: row.inputPerMTok,
  outputPerMTok: row.outputPerMTok,
});

export function createAnthropicSource(): DiscoverySource {
  return {
    name: 'anthropic',
    kind: 'provider',
    isConfigured: (creds: DiscoveryCredentials) => Boolean(creds.anthropic),
    async fetch(ctx: DiscoveryFetchContext): Promise<SourceResult> {
      const headers = {
        'x-api-key': ctx.credentials.anthropic ?? '',
        'anthropic-version': ANTHROPIC_VERSION,
      };

      const pages: unknown[] = [];
      let afterId: string | undefined;
      let status: number | undefined;

      for (let page = 0; page < ANTHROPIC_MAX_PAGES; page += 1) {
        const url = new URL(ANTHROPIC_MODELS_URL);
        url.searchParams.set('limit', String(ANTHROPIC_PAGE_SIZE));
        if (afterId) url.searchParams.set('after_id', afterId);

        const response = await fetchJson<AnthropicModelPage>({ url: url.toString(), headers }, ctx);
        if (!response.ok) return { ok: false, error: response.error, httpStatus: response.status };
        if (response.notModified) return { ok: false, error: 'unexpected 304 from a provider list' };

        status = response.status;
        pages.push(response.body);

        const lastId = text(response.body?.last_id);
        if (response.body?.has_more !== true || !lastId || lastId === afterId) break;
        afterId = lastId;
        if (!hasTimeLeft(ctx)) return { ok: false, error: 'ran out of budget mid-pagination', httpStatus: status };
      }

      const models = normalizeAnthropicModels(pages);
      if (models.length === 0) return { ok: false, error: 'model list was empty', httpStatus: status };

      const [lifecycle, pricing] = await Promise.all([
        readDoc(ANTHROPIC_DEPRECATIONS_URL, parseAnthropicDeprecations, ctx),
        readDoc(ANTHROPIC_PRICING_URL, parseAnthropicPricing, ctx),
      ]);

      return {
        ok: true,
        records: mergeAnthropicFacts({ models, lifecycle, pricing, at: ctx.runStartedAt }),
        authoritativeFor: [ModelBackend.Anthropic],
        httpStatus: status,
      };
    },
  };
}

/**
 * Fetch and parse one docs page. A fetch or parse failure is warned and returns
 * undefined: the caller keeps the availability signal, and the field group the
 * page owns falls through to whatever the catalog already believes.
 */
async function readDoc<T>(
  url: string,
  parse: (markdown: string) => { ok: true; rows: T[] } | { ok: false; error: string },
  ctx: DiscoveryFetchContext
): Promise<T[] | undefined> {
  const response = await fetchText({ url, headers: { accept: 'text/markdown, text/plain' } }, ctx);
  if (!response.ok || response.notModified) {
    ctx.logger.warn(`[model-discovery] anthropic docs ${url} unavailable`);
    return undefined;
  }
  const parsed = parse(response.text);
  if (!parsed.ok) {
    ctx.logger.warn(`[model-discovery] anthropic docs parser broke: ${parsed.error}`);
    return undefined;
  }
  return parsed.rows;
}
