import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { VideoModel } from '@bike4mind/common';
import type { ChatModelCatalog, ChatModelOption } from '@shared/chat';
import { parseVideoModels } from './media/videoModels';
import { supportsReasoningEffort } from './reasoningEffort';
import { currentLocalContext, OllamaLocal } from './OllamaLocal';

/**
 * The model list is per-DEPLOYMENT and per-ACCOUNT, never a constant in this client.
 *
 * `/api/models` assembles it from the effective LLM keys of the calling user, so a self-host
 * stack advertises only the providers it holds a key for plus whatever Ollama is serving, and
 * two accounts on the same server can legitimately see different lists. Hardcoding a list here
 * would offer models that 4xx on first use.
 */
const MODELS_PATH = '/api/models';

/**
 * Backstop for a list that changes without the environment URL changing - the caller signs in
 * as a different account, or an admin adds a provider key. Short, because the route is itself
 * cached server-side for 60s, so a miss here is cheap.
 */
const CACHE_TTL_MS = 5 * 60_000;

/**
 * The video list decides whether a turn offers generate_video at all, so it is read at the start
 * of every turn that can generate. An empty or failed answer is cached too, but briefly: a server
 * with no video provider must not cost each turn a round trip, and a blip must not hide the tool
 * for the full TTL.
 */
const VIDEO_EMPTY_TTL_MS = 60_000;

/** Bounds what that read can add to a turn's start. */
const VIDEO_MODELS_TIMEOUT_MS = 5_000;

/** The subset of `ModelInfo` this client reads. Extra fields on the wire are ignored. */
interface WireModel {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  backend?: unknown;
  releaseDate?: unknown;
  contextWindow?: unknown;
  max_tokens?: unknown;
  supportsTools?: unknown;
  supportsVision?: unknown;
  can_think?: unknown;
  pricing?: unknown;
}

export interface ModelCatalogLogger {
  debug(message: string): void;
  warn(message: string): void;
}

export interface ModelCatalogDeps {
  logger: ModelCatalogLogger;
  /** Null when signed out; the list is an authenticated read, so there is nothing to fetch. */
  getApiClient(): AuthenticatedApiClient | null;
  /** Cache identity: switching environments must not show the previous server's models. */
  getEnvironmentUrl(): string;
}

/**
 * The models this deployment will actually accept, fetched once and cached per environment.
 *
 * A failed or empty fetch is NOT cached: the picker retries on its next open, and caching
 * "no models" would hide a healthy server behind one network blip for the rest of the TTL -
 * the same reasoning `/api/models` applies to its own server-side cache.
 */
export class ModelCatalog {
  private cache: { environmentUrl: string; models: ChatModelOption[]; expiresAt: number } | null = null;

  private localCache: { models: ChatModelOption[]; expiresAt: number } | null = null;

  /** Separate from `cache` because the two views are read on different paths; see listImageModels. */
  private imageCache: { environmentUrl: string; models: string[]; expiresAt: number } | null = null;

  private videoCache: { environmentUrl: string; models: VideoModel[]; expiresAt: number } | null = null;

  constructor(
    private readonly deps: ModelCatalogDeps,
    private readonly local: Pick<OllamaLocal, 'models'> = new OllamaLocal()
  ) {}

  /** Cached models for the current environment, without a round trip. Null when nothing is cached. */
  cached(): ChatModelOption[] | null {
    const entry = this.cache;
    if (!this.deps.getApiClient()) {
      return this.localCache && Date.now() < this.localCache.expiresAt
        ? withCurrentContexts(this.localCache.models)
        : null;
    }
    if (!entry) return null;
    if (entry.environmentUrl !== this.deps.getEnvironmentUrl()) return null;
    if (Date.now() >= entry.expiresAt) return null;
    return this.mergeLocal(entry.models);
  }

  /** Retain a known thinking preference through a failed refresh, without offering stale models. */
  lastKnownThinkingToggle(modelId: string): boolean | undefined {
    const entry = this.cache;
    if (!entry || entry.environmentUrl !== this.deps.getEnvironmentUrl()) return undefined;
    return entry.models.find(model => model.id === modelId)?.thinkingToggle;
  }

  async list(force = false): Promise<ChatModelCatalog> {
    const api = this.deps.getApiClient();
    const entry = this.cache;
    const hostedHit =
      !force && api && entry?.environmentUrl === this.deps.getEnvironmentUrl() && Date.now() < entry.expiresAt
        ? entry.models
        : null;
    // The device and the server are asked at the same time; neither waits on the other.
    const [local, hosted] = await Promise.all([
      this.listLocal(force),
      api && !hostedHit
        ? api.get<{ models?: WireModel[] }>(MODELS_PATH).then(
            response => ({ ok: true as const, models: selectUsableModels(response?.models) }),
            (err: unknown) => ({ ok: false as const, err })
          )
        : null,
    ]);
    if (hostedHit) return { models: this.mergeLocal(hostedHit) };
    if (!api || !hosted) return local.length ? { models: local } : { models: [], error: 'Sign in to see models.' };

    if (!hosted.ok) {
      const message = hosted.err instanceof Error ? hosted.err.message : String(hosted.err);
      this.deps.logger.warn(`CHAT: model list lookup failed: ${message}`);
      return local.length
        ? { models: local }
        : { models: [], error: 'Could not load the model list from this server.' };
    }
    const models = hosted.models;

    if (models.length === 0) {
      this.cache = null;
      this.deps.logger.warn('CHAT: server returned no tool-capable text models');
      return { models: local };
    }

    this.cache = {
      environmentUrl: this.deps.getEnvironmentUrl(),
      models,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };
    this.deps.logger.debug(`CHAT: ${models.length} model(s) available`);
    return { models: this.mergeLocal(models) };
  }

  /** Device discovery never depends on the configured server or account. */
  async listLocal(force = false): Promise<ChatModelOption[]> {
    if (force || !this.localCache || Date.now() >= this.localCache.expiresAt) {
      this.localCache = { models: await this.local.models(), expiresAt: Date.now() + 5_000 };
    }
    return withCurrentContexts(this.localCache.models);
  }

  /** The last local list however old, without a round trip; null before the first list or after forgetLocal. */
  lastLocal(): ChatModelOption[] | null {
    return this.localCache ? withCurrentContexts(this.localCache.models) : null;
  }

  /** After the local context setting changes or a model turns out removed, so the next list reads Ollama again. */
  forgetLocal(): void {
    this.localCache = null;
  }

  private mergeLocal(hosted: ChatModelOption[]): ChatModelOption[] {
    const local = this.localCache && Date.now() < this.localCache.expiresAt ? this.localCache.models : [];
    return [
      ...hosted.filter(model => !local.some(candidate => candidate.id === model.id)),
      ...withCurrentContexts(local),
    ];
  }

  /**
   * Image models this deployment offers, newest-listed first, for the image-generation tool.
   *
   * Fetched lazily and cached separately from the chat list: a turn that never generates an
   * image must not pay for this, and the chat picker must not pay for it either. Same reasoning
   * as `list` about never hardcoding a set - `/api/models` is assembled from the account's
   * effective provider keys, so a stack with no image provider correctly offers none.
   */
  async listImageModels(): Promise<string[]> {
    const environmentUrl = this.deps.getEnvironmentUrl();
    const hit = this.imageCache;
    if (hit && hit.environmentUrl === environmentUrl && Date.now() < hit.expiresAt) return hit.models;

    const api = this.deps.getApiClient();
    if (!api) return [];

    let models: string[];
    try {
      const response = await api.get<{ models?: WireModel[] }>(MODELS_PATH);
      models = selectImageModels(response?.models);
    } catch (err) {
      this.deps.logger.warn(`CHAT: image model lookup failed: ${err instanceof Error ? err.message : 'unknown'}`);
      return [];
    }

    if (models.length > 0) {
      this.imageCache = { environmentUrl, models, expiresAt: Date.now() + CACHE_TTL_MS };
    }
    return models;
  }

  /**
   * Video models this caller can use right now, from `/api/v1/video-models`: enabled by the
   * admin, registered on this deployment, and backed by a provider key. Empty when there are
   * none, which is what keeps generate_video off the tool list rather than failing when called.
   */
  async listVideoModels(): Promise<VideoModel[]> {
    const environmentUrl = this.deps.getEnvironmentUrl();
    const hit = this.videoCache;
    if (hit && hit.environmentUrl === environmentUrl && Date.now() < hit.expiresAt) return hit.models;

    const api = this.deps.getApiClient();
    if (!api) return [];

    let models: VideoModel[] = [];
    try {
      models = parseVideoModels(await api.get<unknown>(VIDEO_MODELS_PATH, { timeout: VIDEO_MODELS_TIMEOUT_MS }));
    } catch (err) {
      this.deps.logger.warn(`CHAT: video model lookup failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }
    this.videoCache = {
      environmentUrl,
      models,
      expiresAt: Date.now() + (models.length > 0 ? CACHE_TTL_MS : VIDEO_EMPTY_TTL_MS),
    };
    return models;
  }
}

const VIDEO_MODELS_PATH = '/api/v1/video-models';

/** A context that grew or fell back since the list was cached replaces the one it advertised. */
function withCurrentContexts(models: ChatModelOption[]): ChatModelOption[] {
  return models.map(model => {
    const tokens = currentLocalContext(model.id);
    return tokens === undefined || tokens === model.contextWindow ? model : { ...model, contextWindow: tokens };
  });
}

/** Image-generation model ids from the server's catalog, in the order it listed them. */
export function selectImageModels(wire: unknown): string[] {
  if (!Array.isArray(wire)) return [];
  return wire
    .filter((model): model is WireModel => !!model && typeof model === 'object')
    .filter(model => model.type === 'image' && typeof model.id === 'string')
    .map(model => model.id as string);
}

/**
 * Narrow the server's catalog to what this client can drive: text models that support tools.
 *
 * Tool support is a hard requirement, not a preference - the desktop agent declares tools on
 * every turn, and a model that cannot call them turns the app into a plain chat window that
 * claims it read your files. Image, video and speech models are filtered for the same reason
 * the CLI filters them: they cannot answer a completion request at all.
 */
export function selectUsableModels(wire: unknown): ChatModelOption[] {
  if (!Array.isArray(wire)) return [];

  return wire
    .filter((model): model is WireModel => !!model && typeof model === 'object')
    .filter(model => model.type === 'text' && model.supportsTools === true && typeof model.id === 'string')
    .map(model => ({
      id: model.id as string,
      name: typeof model.name === 'string' && model.name ? model.name : (model.id as string),
      ...(typeof model.backend === 'string' ? { backend: model.backend } : {}),
      ...(typeof model.releaseDate === 'string' && model.releaseDate ? { releaseDate: model.releaseDate } : {}),
      ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
      ...(typeof model.max_tokens === 'number' && model.max_tokens > 0 ? { maxOutputTokens: model.max_tokens } : {}),
      // Carried through only when the server stated it. Absent is "not said", which the
      // attachment gate treats differently from an explicit false - see ChatService.
      ...(typeof model.supportsVision === 'boolean' ? { supportsVision: model.supportsVision } : {}),
      // Decided here rather than read off the wire: the catalog does not report it, and the
      // renderer has to disable the effort picker on a model that would ignore the field.
      supportsReasoningEffort: supportsReasoningEffort(model.id as string),
      supportsTools: true,
      ...(model.backend === 'ollama' && model.can_think === true ? { thinkingToggle: true } : {}),
      ...pricingOf(model.pricing),
    }));
}

/** Only well-formed tiers, so a malformed row prices nothing rather than a wrong figure. */
function pricingOf(wire: unknown): Pick<ChatModelOption, 'pricing'> {
  if (!wire || typeof wire !== 'object') return {};
  const pricing: NonNullable<ChatModelOption['pricing']> = {};
  const rate = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  for (const [key, tier] of Object.entries(wire)) {
    const threshold = Number(key);
    if (!Number.isFinite(threshold) || !tier || typeof tier !== 'object') continue;
    const fields = tier as Record<string, unknown>;
    const input = rate(fields.input);
    const output = rate(fields.output);
    if (input === undefined || output === undefined) continue;
    const cacheRead = rate(fields.cache_read);
    const cacheWrite = rate(fields.cache_write);
    pricing[threshold] = {
      input,
      output,
      ...(cacheRead !== undefined ? { cache_read: cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cache_write: cacheWrite } : {}),
    };
  }
  return Object.keys(pricing).length > 0 ? { pricing } : {};
}

/**
 * Which model a new conversation starts on, and which one a conversation falls back to when
 * its saved model is gone.
 *
 * The first of `preferred` this deployment offers wins - in practice the user's remembered pick,
 * then the built-in default (see ChatService.pickModel). When it offers none of them, the first
 * model the server listed wins rather than another hardcoded guess - only the server knows what
 * it has.
 */
export function resolveDefaultModel(
  models: readonly ChatModelOption[],
  preferred: readonly (string | null | undefined)[]
): string | null {
  const offered = preferred.find(candidate => candidate && models.some(model => model.id === candidate));
  return offered ?? models[0]?.id ?? null;
}
