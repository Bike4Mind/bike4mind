import { ModelBackend, type ModelRecord } from '@bike4mind/common';
import type {
  DiscoveredModel,
  DiscoveryCredentials,
  DiscoveryFetchContext,
  DiscoverySource,
  SourceResult,
} from '../types';
import { compact, count, fetchJson, hasTimeLeft, text } from './http';

/**
 * Ollama >= 0.30 returns `capabilities[]` and `details.context_length` inline in
 * `GET /api/tags`, which retires the per-model `/api/show` N+1 this codebase has
 * been paying for. `/api/version` decides which path runs; the fallback stays
 * because a self-host install pinned to an older daemon still has to work.
 */
export const OLLAMA_CAPABILITIES_IN_TAGS_VERSION = { major: 0, minor: 30 };

/** A slow local daemon loading a large model can take a while to answer /api/show. */
export const OLLAMA_SHOW_CONCURRENCY = 4;

interface OllamaDetails {
  family?: unknown;
  families?: unknown;
  parameter_size?: unknown;
  quantization_level?: unknown;
  context_length?: unknown;
  embedding_length?: unknown;
}

interface OllamaTag {
  name?: unknown;
  model?: unknown;
  details?: OllamaDetails;
  capabilities?: unknown;
}

export interface OllamaTagList {
  models?: unknown;
}

export interface OllamaShow {
  details?: OllamaDetails;
  capabilities?: unknown;
  model_info?: Record<string, unknown>;
}

/** Enum has grown to 8 values and keeps growing; unknown members are ignored, never fatal. */
const capabilitiesOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** `<arch>.context_length` is where /api/show hides the window; the arch prefix varies per model. */
export function contextFromModelInfo(modelInfo: Record<string, unknown> | undefined): number | undefined {
  for (const [key, value] of Object.entries(modelInfo ?? {})) {
    if (key.endsWith('.context_length')) {
      const parsed = count(value);
      if (parsed !== undefined && parsed > 0) return parsed;
    }
  }
  return undefined;
}

export interface OllamaFacts {
  tags: unknown;
  /** Per-model /api/show bodies, keyed by tag name. Empty on the fast path. */
  shown?: ReadonlyMap<string, OllamaShow>;
}

export function normalizeOllamaModels({ tags, shown }: OllamaFacts): DiscoveredModel[] {
  const list = (tags as OllamaTagList | null)?.models;
  if (!Array.isArray(list)) return [];

  const records: DiscoveredModel[] = [];
  for (const entry of list as OllamaTag[]) {
    const id = text(entry?.name) ?? text(entry?.model);
    if (!id) continue;

    const detail = shown?.get(id);
    const capabilities = capabilitiesOf(entry?.capabilities ?? detail?.capabilities);
    const details = entry?.details ?? detail?.details;
    const contextWindow =
      count(details?.context_length) ??
      count(detail?.details?.context_length) ??
      contextFromModelInfo(detail?.model_info);

    const isEmbedding = capabilities.includes('embedding');
    const thinking = capabilities.includes('thinking');

    records.push({
      modelId: id,
      patch: compact<Partial<ModelRecord>>({
        id,
        // Ollama reports the GGUF architecture family, not who trained the
        // weights. It is the closest thing to a vendor a local daemon knows,
        // and it beats labelling every local model 'ollama'.
        vendor: text(details?.family) ?? id.split(':')[0] ?? 'ollama',
        backend: ModelBackend.Ollama,
        type: isEmbedding ? 'embedding' : 'text',
        // No display name exists locally; the tag IS the human-facing name.
        name: id,
        contextWindow: contextWindow ?? 0,
        canStream: true,
        supportsVision: capabilities.length > 0 ? capabilities.includes('vision') : undefined,
        supportsTools: capabilities.length > 0 ? capabilities.includes('tools') : undefined,
        reasoning:
          capabilities.length > 0
            ? { supported: thinking, ...(thinking ? { style: 'ollama' as const } : {}) }
            : undefined,
        // A local model costs no money, and saying so is what stops
        // getTextModelCost raising [UNPRICED_MODEL] on a legitimate zero.
        freeToRun: true,
      }),
    });
  }

  return records.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

/** True when this daemon puts capabilities in /api/tags, so /api/show is unnecessary. */
export function tagsCarryCapabilities(version: string | undefined): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(version ?? '');
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const { major: minMajor, minor: minMinor } = OLLAMA_CAPABILITIES_IN_TAGS_VERSION;
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

export function createOllamaSource(): DiscoverySource {
  return {
    name: 'ollama',
    kind: 'provider',
    // The credential here is a base URL, not a key: an install with no Ollama
    // configured has nothing to list, which is a skip rather than a failure.
    isConfigured: (creds: DiscoveryCredentials) => Boolean(creds.ollama),
    async fetch(ctx: DiscoveryFetchContext): Promise<SourceResult> {
      const base = trimSlash(ctx.credentials.ollama ?? '');
      if (!base) return { ok: false, error: 'no ollama base url' };

      const version = await fetchJson<{ version?: unknown }>({ url: `${base}/api/version` }, ctx);
      if (!version.ok || version.notModified) {
        return { ok: false, error: version.ok ? 'unexpected 304' : version.error, httpStatus: version.status };
      }

      const tags = await fetchJson<OllamaTagList>({ url: `${base}/api/tags` }, ctx);
      if (!tags.ok || tags.notModified) {
        return { ok: false, error: tags.ok ? 'unexpected 304' : tags.error, httpStatus: tags.status };
      }

      const fastPath = tagsCarryCapabilities(text(version.body?.version));
      const shown = fastPath ? undefined : await showEach(base, tags.body, ctx);

      const records = normalizeOllamaModels({ tags: tags.body, shown });
      // Zero pulled models is a legitimate state for a fresh daemon, unlike a
      // hosted provider listing nothing - but claiming authority over an empty
      // backend would then retire every Ollama row the catalog holds, so the
      // sighting is reported without the authority that drives absence.
      return {
        ok: true,
        records,
        authoritativeFor: records.length > 0 ? [ModelBackend.Ollama] : undefined,
        httpStatus: tags.status,
      };
    },
  };
}

/** The pre-0.30 path: one /api/show per tag, bounded by the run's deadline. */
async function showEach(
  base: string,
  tags: OllamaTagList,
  ctx: DiscoveryFetchContext
): Promise<Map<string, OllamaShow>> {
  const names = (Array.isArray(tags?.models) ? (tags.models as OllamaTag[]) : [])
    .map(entry => text(entry?.name) ?? text(entry?.model))
    .filter((name): name is string => Boolean(name));

  const shown = new Map<string, OllamaShow>();
  for (let index = 0; index < names.length; index += OLLAMA_SHOW_CONCURRENCY) {
    if (!hasTimeLeft(ctx)) break;
    const batch = names.slice(index, index + OLLAMA_SHOW_CONCURRENCY);
    await Promise.all(
      batch.map(async name => {
        const response = await fetchJson<OllamaShow>(
          { url: `${base}/api/show`, method: 'POST', body: JSON.stringify({ model: name }) },
          ctx
        );
        // One model refusing to describe itself is missing detail for that
        // model, never a reason to fail the whole local listing.
        if (response.ok && !response.notModified) shown.set(name, response.body);
      })
    );
  }
  return shown;
}
