import { ModelBackend, type ModelRecord } from '@bike4mind/common';
import type {
  DiscoveredModel,
  DiscoveryCredentials,
  DiscoveryFetchContext,
  DiscoverySource,
  SourceResult,
} from '../types';
import { compact, fetchJson, text } from './http';

export const DEEPSEEK_MODELS_URL = 'https://api.deepseek.com/models';

/**
 * DeepSeek's `GET /models` is the thin OpenAI-listing shape - only `id`,
 * `object`, `owned_by`, verified against the vendor's own API reference - so
 * this source is closer to `./openai` than to `./kimi`: an availability signal
 * and nothing else, with no context window or capability flag to claim.
 *
 * That makes it a MAINTAIN-only source (see the discovery driver's landmine
 * notes on `planOne`): a listed id can refresh presence for a model the seed or
 * an aggregator already introduced, but this source alone can never introduce
 * one, because it has no context window to give `planOne`'s required fields.
 *
 * Emits NO `name`, the same deliberate omission `./kimi` makes: the endpoint
 * does not publish a display name, and `name: id` would overwrite every seeded
 * label with a lowercase id and append a row on every run forever.
 */
interface DeepSeekModel {
  id?: unknown;
  object?: unknown;
  owned_by?: unknown;
}

interface DeepSeekModelList {
  data?: unknown;
}

/**
 * DeepSeek ships only chat models today, all under the one `deepseek-` id
 * namespace, so a marker match is checked first the way `./kimi` and
 * `./openai` do it: a future `deepseek-embedding-*` or `deepseek-tts-*` id must
 * not fall through to 'text' just because it shares the vendor's namespace.
 */
const MODALITY_MARKERS: ReadonlyArray<[RegExp, ModelRecord['type']]> = [
  [/(^|-)tts(-|$)/, 'tts'],
  [/(^|-)embedding(s)?(-|$)/, 'embedding'],
  [/(^|-)(asr|transcribe|whisper)(-|$)/, 'speech-to-text'],
  [/(^|-)(video|sora)(-|$)/, 'video'],
  [/(^|-)realtime(-|$)/, 'realtime-voice'],
  [/(^|-)image(-|$)/, 'image'],
];

function inferType(id: string): ModelRecord['type'] | undefined {
  for (const [marker, type] of MODALITY_MARKERS) {
    if (marker.test(id)) return type;
  }
  if (id.startsWith('deepseek-')) return 'text';
  return undefined;
}

export function normalizeDeepSeekModels(payload: unknown): DiscoveredModel[] {
  const list = payload as DeepSeekModelList | null;
  const data = Array.isArray(list?.data) ? (list.data as DeepSeekModel[]) : [];
  const records: DiscoveredModel[] = [];

  for (const entry of data) {
    const id = text(entry?.id);
    // Same open-enum tolerance as ./kimi and ./openai: a non-'model' object is
    // skipped, a missing one is fine because the id is the fact.
    if (!id || (entry?.object !== undefined && entry.object !== 'model')) continue;
    records.push({
      modelId: id,
      patch: compact<Partial<ModelRecord>>({
        id,
        vendor: 'deepseek',
        backend: ModelBackend.DeepSeek,
        type: inferType(id),
        // The endpoint publishes no streaming flag, but every documented
        // completion path (including the legacy aliases) supports it.
        canStream: true,
      }),
    });
  }

  return records.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

export function createDeepSeekSource(): DiscoverySource {
  return {
    name: 'deepseek',
    kind: 'provider',
    isConfigured: (creds: DiscoveryCredentials) => Boolean(creds.deepseek),
    async fetch(ctx: DiscoveryFetchContext): Promise<SourceResult> {
      const response = await fetchJson<DeepSeekModelList>(
        { url: DEEPSEEK_MODELS_URL, headers: { authorization: `Bearer ${ctx.credentials.deepseek ?? ''}` } },
        ctx
      );
      if (!response.ok) return { ok: false, error: response.error, httpStatus: response.status };
      if (response.notModified) return { ok: false, error: 'unexpected 304 from a provider list' };

      const records = normalizeDeepSeekModels(response.body);
      // A 200 listing zero models is a broken parse or a broken account, never
      // "DeepSeek retired everything". Failing here keeps absence bookkeeping
      // frozen instead of graduating the whole backend toward deprecated.
      if (records.length === 0) return { ok: false, error: 'model list was empty', httpStatus: response.status };

      // One endpoint lists every DeepSeek model, so a 200 here IS an exhaustive
      // statement about the backend, the same authority ./kimi claims.
      return { ok: true, records, authoritativeFor: [ModelBackend.DeepSeek], httpStatus: response.status };
    },
  };
}
