import { ModelBackend, type ModelRecord } from '@bike4mind/common';
import type {
  DiscoveredModel,
  DiscoveryCredentials,
  DiscoveryFetchContext,
  DiscoverySource,
  SourceResult,
} from '../types';
import { boolean, compact, count, fetchJson, hasTimeLeft, text } from './http';

export const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/** models.list caps a page at 1000 whatever you ask for; the default is 50 (sec 5.5). */
export const GEMINI_PAGE_SIZE = 1000;

/**
 * Hard stop on the page loop. At 1000 per page this is 10,000 models, an order
 * of magnitude past anything Google has listed - so tripping it means a
 * pathological or looping nextPageToken, and the run should say so rather than
 * paginate until the lambda dies.
 */
export const GEMINI_MAX_PAGES = 10;

interface GeminiModel {
  name?: unknown;
  displayName?: unknown;
  inputTokenLimit?: unknown;
  outputTokenLimit?: unknown;
  supportedGenerationMethods?: unknown;
  temperature?: unknown;
  maxTemperature?: unknown;
  topP?: unknown;
  thinking?: unknown;
}

export interface GeminiModelPage {
  models?: unknown;
  nextPageToken?: unknown;
}

const methodsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/**
 * Gemini says what a model can be called with, not what kind of thing it is, so
 * the kind is read off the generation methods first and the id namespace second.
 * An id that fits neither omits `type` rather than defaulting to text: a
 * mislabeled model lands in the wrong picker, a typeless one is dropped and
 * counted.
 */
function inferType(id: string, methods: readonly string[]): ModelRecord['type'] | undefined {
  if (methods.includes('embedContent')) return 'embedding';
  if (id.startsWith('veo-')) return 'video';
  if (id.includes('-image')) return 'image';
  if (id.includes('-tts')) return 'tts';
  if (id.includes('-live') || (methods.includes('bidiGenerateContent') && !methods.includes('generateContent'))) {
    return 'realtime-voice';
  }
  if (methods.includes('generateContent')) return 'text';
  return undefined;
}

/** Normalize one or more pages; the pages are concatenated exactly as fetched. */
export function normalizeGeminiModels(pages: readonly unknown[]): DiscoveredModel[] {
  const records = new Map<string, DiscoveredModel>();

  for (const page of pages) {
    const list = (page as GeminiModelPage | null)?.models;
    if (!Array.isArray(list)) continue;

    for (const entry of list as GeminiModel[]) {
      // Every id arrives as the resource path `models/gemini-...`; the catalog
      // holds the bare id, which is also what the SDK takes.
      const name = text(entry?.name);
      const id = name?.startsWith('models/') ? name.slice('models/'.length) : name;
      if (!id) continue;

      const methods = methodsOf(entry?.supportedGenerationMethods);
      const thinking = boolean(entry?.thinking);
      records.set(id, {
        modelId: id,
        patch: compact<Partial<ModelRecord>>({
          id,
          vendor: 'google',
          backend: ModelBackend.Gemini,
          type: inferType(id, methods),
          name: text(entry?.displayName),
          contextWindow: count(entry?.inputTokenLimit),
          // Gemini is the only provider that publishes this one.
          maxOutputTokens: count(entry?.outputTokenLimit),
          canStream: methods.length > 0 ? methods.includes('streamGenerateContent') : undefined,
          reasoning: thinking === undefined ? undefined : { supported: thinking },
          // A published sampling default is the signal that sampling is open;
          // absence is silence, not "temperature is rejected".
          temperatureMode: typeof entry?.temperature === 'number' ? 'free' : undefined,
          supportsTopP: typeof entry?.topP === 'number' ? true : undefined,
        }),
      });
    }
  }

  return [...records.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
}

export function createGeminiSource(): DiscoverySource {
  return {
    name: 'gemini',
    kind: 'provider',
    isConfigured: (creds: DiscoveryCredentials) => Boolean(creds.gemini),
    async fetch(ctx: DiscoveryFetchContext): Promise<SourceResult> {
      // Header auth, not ?key=: the query form leaks the credential into every
      // access log and error string between here and Google.
      const headers = { 'x-goog-api-key': ctx.credentials.gemini ?? '' };
      const pages: unknown[] = [];
      const seenTokens = new Set<string>();
      let pageToken: string | undefined;
      let status: number | undefined;

      for (let page = 0; page < GEMINI_MAX_PAGES; page += 1) {
        const url = new URL(GEMINI_MODELS_URL);
        url.searchParams.set('pageSize', String(GEMINI_PAGE_SIZE));
        if (pageToken) url.searchParams.set('pageToken', pageToken);

        const response = await fetchJson<GeminiModelPage>({ url: url.toString(), headers }, ctx);
        if (!response.ok) return { ok: false, error: response.error, httpStatus: response.status };
        if (response.notModified) return { ok: false, error: 'unexpected 304 from a provider list' };

        status = response.status;
        pages.push(response.body);

        const next = text(response.body?.nextPageToken);
        if (!next) break;
        // A token that repeats is a server-side loop; one more page would be
        // the same page, and the bound above would only slow the discovery of that.
        if (seenTokens.has(next)) break;
        seenTokens.add(next);
        pageToken = next;

        if (!hasTimeLeft(ctx)) {
          return { ok: false, error: 'ran out of budget mid-pagination', httpStatus: status };
        }
      }

      const records = normalizeGeminiModels(pages);
      if (records.length === 0) return { ok: false, error: 'model list was empty', httpStatus: status };

      return { ok: true, records, authoritativeFor: [ModelBackend.Gemini], httpStatus: status };
    },
  };
}
