import { ModelBackend, type ModelRecord } from '@bike4mind/common';
import type {
  DiscoveredModel,
  DiscoveredPrice,
  DiscoveryCredentials,
  DiscoveryFetchContext,
  DiscoverySource,
  SourceResult,
} from '../types';
import { compact, count, fetchJson, text } from './http';

const XAI_BASE_URL = 'https://api.x.ai/v1';
export const XAI_LANGUAGE_MODELS_URL = `${XAI_BASE_URL}/language-models`;
export const XAI_MODELS_URL = `${XAI_BASE_URL}/models`;
export const XAI_IMAGE_MODELS_URL = `${XAI_BASE_URL}/image-generation-models`;
export const XAI_EMBEDDING_MODELS_URL = `${XAI_BASE_URL}/embedding-models`;

/**
 * TWO DIFFERENT CONSTANTS ON TWO ENDPOINTS OF ONE PROVIDER. Crossing them is a
 * 100x billing error, which is why each has its own name, its own doc line, and
 * its own unit test against a published rate.
 *
 * /v1/language-models, /v1/models and /v1/image-generation-models quote token
 * prices in USD CENTS PER 100 MILLION TOKENS: cents/100M -> $/MTok is
 * (value / 100 cents-per-dollar) / 100 hundred-million-per-million = value / 1e4.
 * Grok 4's published $3.00 / MTok input arrives as 30000.
 */
export const CENTS_PER_100M_TOKENS_TO_USD_PER_MTOK = 1e4;

/**
 * /v1/embedding-models quotes USD CENTS PER 1 MILLION TOKENS instead:
 * cents/1M -> $/MTok is value / 100. Same provider, different endpoint,
 * different scale (spec sec 3).
 */
export const CENTS_PER_1M_TOKENS_TO_USD_PER_MTOK = 100;

interface XaiLanguageModel {
  id?: unknown;
  aliases?: unknown;
  input_modalities?: unknown;
  output_modalities?: unknown;
  prompt_text_token_price?: unknown;
  completion_text_token_price?: unknown;
  cached_prompt_text_token_price?: unknown;
  prompt_text_token_price_long_context?: unknown;
  completion_text_token_price_long_context?: unknown;
  long_context_threshold?: unknown;
}

interface XaiImageModel {
  id?: unknown;
  input_modalities?: unknown;
  max_prompt_length?: unknown;
}

interface XaiEmbeddingModel {
  id?: unknown;
  prompt_text_token_price?: unknown;
}

/** The only field this endpoint has that /v1/language-models does not (the trap in sec 3). */
interface XaiMinimalModel {
  id?: unknown;
  context_length?: unknown;
}

export interface XaiPayloads {
  languageModels: unknown;
  /** /v1/models, joined on id purely for context_length. */
  models: unknown;
  imageModels?: unknown;
  embeddingModels?: unknown;
}

const listOf = <T>(payload: unknown, key: 'models' | 'data'): T[] => {
  const container = payload as Record<string, unknown> | null;
  const list = container?.[key];
  return Array.isArray(list) ? (list as T[]) : [];
};

const modalities = (value: unknown): string[] => (Array.isArray(value) ? value.filter(v => typeof v === 'string') : []);

/** A token price, or undefined when the feed omits it or quotes a non-number. */
function price(value: unknown, divisor: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value / divisor;
}

function pairedPrice(input: unknown, output: unknown, divisor: number): DiscoveredPrice | undefined {
  const inputPerMTok = price(input, divisor);
  const outputPerMTok = price(output, divisor);
  if (inputPerMTok === undefined || outputPerMTok === undefined) return undefined;
  // An all-zero pair is xAI's "not priced on this endpoint" filler, not free.
  if (inputPerMTok === 0 && outputPerMTok === 0) return undefined;
  return { inputPerMTok, outputPerMTok };
}

/**
 * Join /v1/language-models (capabilities and prices) with /v1/models
 * (context_length, and nothing else we need). A model present on only one side
 * still produces a record: the language endpoint is the list of what exists, and
 * a missing context_length simply means the field falls through to whatever the
 * catalog already believes rather than being overwritten with a guess.
 *
 * An id that appears ONLY in /v1/models is deliberately not emitted - that
 * endpoint does not say what modality the model is, and `type` is not guessable.
 */
export function normalizeXai(payloads: XaiPayloads): DiscoveredModel[] {
  const contextById = new Map<string, number>();
  for (const entry of listOf<XaiMinimalModel>(payloads.models, 'data')) {
    const id = text(entry?.id);
    const contextLength = count(entry?.context_length);
    if (id && contextLength !== undefined && contextLength > 0) contextById.set(id, contextLength);
  }

  const records: DiscoveredModel[] = [];

  for (const entry of listOf<XaiLanguageModel>(payloads.languageModels, 'models')) {
    const id = text(entry?.id);
    if (!id) continue;
    const inputs = modalities(entry?.input_modalities);
    records.push({
      modelId: id,
      patch: compact<Partial<ModelRecord>>({
        id,
        vendor: 'xai',
        backend: ModelBackend.XAI,
        type: 'text',
        contextWindow: contextById.get(id),
        canStream: true,
        supportsVision: inputs.length > 0 ? inputs.includes('image') : undefined,
        promptCaching: cachingOf(entry),
      }),
      pricing: pairedPrice(
        entry?.prompt_text_token_price,
        entry?.completion_text_token_price,
        CENTS_PER_100M_TOKENS_TO_USD_PER_MTOK
      ),
    });
  }

  for (const entry of listOf<XaiImageModel>(payloads.imageModels, 'models')) {
    const id = text(entry?.id);
    if (!id) continue;
    const inputs = modalities(entry?.input_modalities);
    records.push({
      modelId: id,
      patch: compact<Partial<ModelRecord>>({
        id,
        vendor: 'xai',
        backend: ModelBackend.XAI,
        type: 'image',
        // Image models have no token context; 0 is the catalog's "not applicable".
        contextWindow: contextById.get(id) ?? 0,
        supportsImageVariation: inputs.length > 0 ? inputs.includes('image') : undefined,
      }),
    });
  }

  for (const entry of listOf<XaiEmbeddingModel>(payloads.embeddingModels, 'models')) {
    const id = text(entry?.id);
    if (!id) continue;
    const perMTok = price(entry?.prompt_text_token_price, CENTS_PER_1M_TOKENS_TO_USD_PER_MTOK);
    records.push({
      modelId: id,
      patch: compact<Partial<ModelRecord>>({
        id,
        vendor: 'xai',
        backend: ModelBackend.XAI,
        type: 'embedding',
        contextWindow: contextById.get(id) ?? 0,
      }),
      // An embedding model bills input only; output is reported at the same rate
      // rather than invented, and Phase 3 is what turns this into a price row.
      pricing: perMTok === undefined ? undefined : { inputPerMTok: perMTok, outputPerMTok: perMTok },
    });
  }

  return records.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

function cachingOf(entry: XaiLanguageModel): { supported: boolean } | undefined {
  const cached = entry?.cached_prompt_text_token_price;
  if (typeof cached !== 'number' || !Number.isFinite(cached)) return undefined;
  return { supported: cached > 0 };
}

export function createXaiSource(): DiscoverySource {
  return {
    name: 'xai',
    kind: 'provider',
    isConfigured: (creds: DiscoveryCredentials) => Boolean(creds.xai),
    async fetch(ctx: DiscoveryFetchContext): Promise<SourceResult> {
      const headers = { authorization: `Bearer ${ctx.credentials.xai ?? ''}` };

      const languageModels = await fetchJson<unknown>({ url: XAI_LANGUAGE_MODELS_URL, headers }, ctx);
      if (!languageModels.ok || languageModels.notModified) {
        return { ok: false, error: errorOf(languageModels), httpStatus: statusOf(languageModels) };
      }

      const models = await fetchJson<unknown>({ url: XAI_MODELS_URL, headers }, ctx);
      if (!models.ok || models.notModified) {
        // Without /v1/models there is no context_length anywhere, and half a
        // record for every xAI model is not worth claiming authority over.
        return { ok: false, error: errorOf(models), httpStatus: statusOf(models) };
      }

      // Image and embedding listings are best effort: neither is required to
      // describe the text models this backend is mostly made of, and the
      // embedding endpoint is not part of xAI's published reference.
      const imageModels = await fetchJson<unknown>({ url: XAI_IMAGE_MODELS_URL, headers }, ctx);
      const embeddingModels = await fetchJson<unknown>({ url: XAI_EMBEDDING_MODELS_URL, headers }, ctx);
      for (const [name, result] of [
        ['image-generation-models', imageModels],
        ['embedding-models', embeddingModels],
      ] as const) {
        if (!result.ok) ctx.logger.warn(`[model-discovery] xai ${name} unavailable: ${result.error}`);
      }

      const listedImages = imageModels.ok && !imageModels.notModified;
      const listedEmbeddings = embeddingModels.ok && !embeddingModels.notModified;
      const records = normalizeXai({
        languageModels: languageModels.body,
        models: models.body,
        imageModels: listedImages ? imageModels.body : undefined,
        embeddingModels: listedEmbeddings ? embeddingModels.body : undefined,
      });
      if (records.length === 0) {
        return { ok: false, error: 'language-models listed nothing', httpStatus: languageModels.status };
      }

      // Authority is a claim of EXHAUSTIVENESS, so it needs every listing that
      // contributes ids. grok-imagine-image-quality comes from the image
      // endpoint alone: claiming the backend after a 5xx there would count every
      // xAI image and embedding model as absent and eventually deprecate them.
      const exhaustive = listedImages && listedEmbeddings;
      return {
        ok: true,
        records,
        authoritativeFor: exhaustive ? [ModelBackend.XAI] : [],
        httpStatus: languageModels.status,
      };
    },
  };
}

const errorOf = (result: { ok: boolean; error?: string; notModified?: boolean }): string =>
  result.error ?? 'unexpected 304 from a provider list';

const statusOf = (result: { status?: number }): number | undefined => result.status;
