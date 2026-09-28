import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatModelCatalog, ChatModelOption } from '@shared/chat';

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

/** The subset of `ModelInfo` this client reads. Extra fields on the wire are ignored. */
interface WireModel {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  backend?: unknown;
  contextWindow?: unknown;
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
      // Carried through only when the server stated it. Absent is "not said", which the
      // attachment gate treats differently from an explicit false - see ChatService.
      ...(typeof model.supportsVision === 'boolean' ? { supportsVision: model.supportsVision } : {}),
    }));
}

/**
 * Which model a new conversation starts on, and which one a conversation falls back to when
 * its saved model is gone.
 *
 * `preferred` is the CLI's default, so the two clients agree about what "the default model"
 * means on a given account; when this deployment does not offer it, the first model the server
 * listed wins rather than a second hardcoded guess - only the server knows what it has.
 */
export function resolveDefaultModel(models: readonly ChatModelOption[], preferred: string): string | null {
  if (models.some(model => model.id === preferred)) return preferred;
  return models[0]?.id ?? null;
}
