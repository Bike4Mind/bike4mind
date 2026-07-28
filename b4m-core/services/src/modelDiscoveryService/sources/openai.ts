import { ModelBackend, type ModelRecord } from '@bike4mind/common';
import type {
  DiscoveredModel,
  DiscoveryCredentials,
  DiscoveryFetchContext,
  DiscoverySource,
  SourceResult,
} from '../types';
import { compact, fetchJson, text } from './http';

export const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';

/**
 * OpenAI's list is four fields wide (id, object, created, owned_by) and no richer
 * endpoint exists, so this source is an availability signal and nothing else:
 * context, capabilities and pricing all come from the aggregators.
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

export function createOpenAiSource(): DiscoverySource {
  return {
    name: 'openai',
    kind: 'provider',
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

      return { ok: true, records, authoritativeFor: [ModelBackend.OpenAI], httpStatus: response.status };
    },
  };
}
