import { ModelBackend, type ModelRecord } from '@bike4mind/common';
import type {
  DiscoveredModel,
  DiscoveryCredentials,
  DiscoveryFetchContext,
  DiscoverySource,
  SourceResult,
} from '../types';
import { boolean, compact, count, fetchJson, text } from './http';

export const KIMI_MODELS_URL = 'https://api.moonshot.ai/v1/models';

/**
 * Moonshot's `/v1/models` is OpenAI-shaped in envelope but NOT thin: verified
 * against the live endpoint on 2026-07-28, each entry carries `context_length`,
 * `supports_image_in`, `supports_video_in`, `supports_reasoning`, and - on the
 * models that take it - a `reasoning_efforts` block naming the valid effort
 * levels and the default. That makes this a capability source closer to xAI's
 * than to `./openai`, and it is why this driver claims limits and modalities
 * rather than availability alone.
 *
 * Still emits NO `name`: the endpoint does not publish a display name, and
 * `name: id` would overwrite every seeded label with a lowercase id and append a
 * row on every run forever.
 *
 * NO pricing either - Moonshot publishes none here, so rates remain the
 * aggregators' job (and for k3 and the k2.7-code pair, which litellm does not yet
 * carry, the seeded price stands until a second aggregator agrees).
 *
 * Because `context_length` IS available, a Kimi model Moonshot lists that the
 * catalog has never held can be added by this source alone - unlike the OpenAI
 * source, which has to wait for an aggregator to supply a context window.
 */
interface KimiModel {
  id?: unknown;
  object?: unknown;
  owned_by?: unknown;
  context_length?: unknown;
  supports_image_in?: unknown;
  supports_video_in?: unknown;
  supports_reasoning?: unknown;
  /** Present only on the ids that take `reasoning_effort` (k3 today). */
  reasoning_efforts?: {
    support?: unknown;
    valid_efforts?: unknown;
    default_effort?: unknown;
  };
  /** 'only' means the model cannot be asked to stop reasoning (k3). */
  supports_thinking_type?: unknown;
}

interface KimiModelList {
  data?: unknown;
}

/**
 * Moonshot ships only chat models on this endpoint today, so the namespaces are
 * classified as 'text' - but modality markers are checked FIRST, the way
 * ./openai does it. Prefix alone is not enough: `kimi-` is the live namespace and
 * will be where a `kimi-tts-*` or `kimi-embedding-*` eventually appears, so
 * matching it blindly would label the next modality as chat and offer it in the
 * picker. An unrecognized marker returns undefined, which drops the record and
 * counts it rather than guessing.
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
  // `-vision-preview` is a moonshot-v1 chat model that ACCEPTS images, not an
  // image model, so it deliberately falls through to 'text' below.
  if (id.startsWith('kimi-') || id.startsWith('moonshot-v1-')) return 'text';
  return undefined;
}

/**
 * The reasoning group, from the two independent signals Moonshot publishes:
 * `supports_reasoning` (does it think) and `reasoning_efforts` (what levels the
 * effort parameter takes). The effort levels are read from the feed rather than
 * hardcoded, so a future fourth level arrives without a deploy - kimiParams'
 * mapping is the runtime contract, this is the catalog's record of it.
 *
 * `style` is deliberately NOT claimed: it decides how a request builder shapes
 * the call, and no feed may author that (see ModelCatalogTypes' dispatch note).
 */
function reasoningOf(entry: KimiModel): NonNullable<ModelRecord['reasoning']> | undefined {
  const supported = boolean(entry?.supports_reasoning);
  const efforts = Array.isArray(entry?.reasoning_efforts?.valid_efforts)
    ? (entry.reasoning_efforts!.valid_efforts as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  if (supported === undefined && efforts.length === 0) return undefined;
  return compact({
    // A model that publishes effort levels reasons by definition, even if the
    // boolean is absent.
    supported: supported ?? efforts.length > 0,
    effortLevels: efforts.length > 0 ? efforts : undefined,
  });
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
        // Only when positive: `count` rejects 0 and non-numbers, so a feed that
        // omits the field falls through to whatever the catalog already believes
        // instead of overwriting a real window with a guess.
        contextWindow: count(entry?.context_length),
        canStream: true,
        supportsVision: boolean(entry?.supports_image_in),
        reasoning: reasoningOf(entry),
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
