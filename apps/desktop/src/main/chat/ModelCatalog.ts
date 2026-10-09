import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { VideoModel } from '@bike4mind/common';
import type { ChatModelCatalog, ChatModelOption } from '@shared/chat';
import { parseVideoModels } from './media/videoModels';
import { supportsReasoningEffort } from './reasoningEffort';

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
  contextWindow?: unknown;
  max_tokens?: unknown;
  supportsTools?: unknown;
  supportsVision?: unknown;
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

  /** Separate from `cache` because the two views are read on different paths; see listImageModels. */
  private imageCache: { environmentUrl: string; models: string[]; expiresAt: number } | null = null;

  private videoCache: { environmentUrl: string; models: VideoModel[]; expiresAt: number } | null = null;

  constructor(private readonly deps: ModelCatalogDeps) {}

  /** Cached models for the current environment, without a round trip. Null when nothing is cached. */
  cached(): ChatModelOption[] | null {
    const entry = this.cache;
    if (!entry) return null;
    if (entry.environmentUrl !== this.deps.getEnvironmentUrl()) return null;
    if (Date.now() >= entry.expiresAt) return null;
    return entry.models;
  }

  async list(force = false): Promise<ChatModelCatalog> {
    if (!force) {
      const hit = this.cached();
      if (hit) return { models: hit };
    }

    const api = this.deps.getApiClient();
    if (!api) return { models: [], error: 'Sign in to see the models this server offers.' };

    let models: ChatModelOption[];
    try {
      const response = await api.get<{ models?: WireModel[] }>(MODELS_PATH);
      models = selectUsableModels(response?.models);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn(`CHAT: model list lookup failed: ${message}`);
      return { models: [], error: 'Could not load the model list from this server.' };
    }

    if (models.length === 0) {
      this.deps.logger.warn('CHAT: server returned no tool-capable text models');
      return { models: [] };
    }

    this.cache = {
      environmentUrl: this.deps.getEnvironmentUrl(),
      models,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };
    this.deps.logger.debug(`CHAT: ${models.length} model(s) available`);
    return { models };
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
      ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
      ...(typeof model.max_tokens === 'number' && model.max_tokens > 0 ? { maxOutputTokens: model.max_tokens } : {}),
      // Carried through only when the server stated it. Absent is "not said", which the
      // attachment gate treats differently from an explicit false - see ChatService.
      ...(typeof model.supportsVision === 'boolean' ? { supportsVision: model.supportsVision } : {}),
      // Decided here rather than read off the wire: the catalog does not report it, and the
      // renderer has to disable the effort picker on a model that would ignore the field.
      supportsReasoningEffort: supportsReasoningEffort(model.id as string),
    }));
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
