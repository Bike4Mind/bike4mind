import { ModelBackend, type ModelRecord } from '@bike4mind/common';
import type {
  DiscoveredModel,
  DiscoveryCredentials,
  DiscoveryFetchContext,
  DiscoverySource,
  SourceResult,
} from '../types';
import { compact, fetchJson, text } from './http';

export const KIMI_MODELS_URL = 'https://api.moonshot.ai/v1/models';

/**
 * Moonshot's list is OpenAI-shaped and just as thin - id, object, owned_by - and
 * unlike xAI there is no second endpoint carrying prices or context lengths.
 * So this source is an availability signal only, exactly like `./openai`: it
 * says what exists at the backend, and every capability, limit and rate is the
 * aggregators' job.
 *
 * Emits NO `name` and NO `contextWindow`, for the reasons openai.ts documents at
 * length: a provider outranks an aggregator on any field it claims, so a
 * `contextWindow: 0` here would beat models.dev's real 1M and a `name: id` would
 * append a row every run forever.
 *
 * Consequence, stated rather than hidden: a Kimi model Moonshot lists that the
 * catalog has never held cannot be added by this source alone - it has no context
 * window from anywhere - and lands in the run's dropped records until an
 * aggregator picks it up or an operator seeds it.
 */
interface KimiModel {
  id?: unknown;
  object?: unknown;
  owned_by?: unknown;
}

interface KimiModelList {
  data?: unknown;
}

/**
 * Moonshot ships only chat models on this endpoint today, but 'text' is asserted
 * from the id namespace rather than assumed for everything: a future
 * `moonshot-embedding-*` should be a dropped-and-counted record, not an embedding
 * model mislabeled as chat and offered in the picker.
 */
function inferType(id: string): ModelRecord['type'] | undefined {
  if (id.startsWith('kimi-') || id.startsWith('moonshot-v1-')) return 'text';
  return undefined;
}

export function normalizeKimiModels(payload: unknown): DiscoveredModel[] {
  const list = payload as KimiModelList | null;
  const data = Array.isArray(list?.data) ? (list.data as KimiModel[]) : [];
  const records: DiscoveredModel[] = [];

  for (const entry of data) {
    const id = text(entry?.id);
    // Same open-enum tolerance as the OpenAI source: a non-'model' object is
    // skipped, a missing one is fine because the id is the fact.
    if (!id || (entry?.object !== undefined && entry.object !== 'model')) continue;
    records.push({
      modelId: id,
      patch: compact<Partial<ModelRecord>>({
        id,
        // Vendor is the maker, so it stays 'moonshotai' on the Bedrock-served
        // copies too; only `backend` distinguishes them.
        vendor: 'moonshotai',
        backend: ModelBackend.Kimi,
        type: inferType(id),
      }),
    });
  }

  return records.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

export function createKimiSource(): DiscoverySource {
  return {
    name: 'kimi',
    kind: 'provider',
    isConfigured: (creds: DiscoveryCredentials) => Boolean(creds.kimi),
    async fetch(ctx: DiscoveryFetchContext): Promise<SourceResult> {
      const response = await fetchJson<KimiModelList>(
        { url: KIMI_MODELS_URL, headers: { authorization: `Bearer ${ctx.credentials.kimi ?? ''}` } },
        ctx
      );
      if (!response.ok) return { ok: false, error: response.error, httpStatus: response.status };
      if (response.notModified) return { ok: false, error: 'unexpected 304 from a provider list' };

      const records = normalizeKimiModels(response.body);
      // A 200 listing zero models is a broken parse or a broken account, never
      // "Moonshot retired everything". Failing here keeps absence bookkeeping
      // frozen instead of graduating the whole backend toward deprecated.
      if (records.length === 0) return { ok: false, error: 'model list was empty', httpStatus: response.status };

      // One endpoint lists every Kimi model, so a 200 here IS an exhaustive
      // statement about the backend - unlike xAI, where authority needs three
      // listings to agree before absence can mean anything.
      return { ok: true, records, authoritativeFor: [ModelBackend.Kimi], httpStatus: response.status };
    },
  };
}
