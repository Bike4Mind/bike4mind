import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import {
  CompletionReasoningEffortSchema,
  supportsOneHourPromptCache,
  type ReasoningEffort,
  type VideoModel,
} from '@bike4mind/common';
import type { ChatModelCatalog, ChatModelOption } from '@shared/chat';
import type { ModelListOptions } from '../modelServers/ModelServerRegistry';
import { parseVideoModels } from './media/videoModels';
import { hostedControls, withOllamaContext } from './modelControls';
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
  thinkingStyle?: unknown;
  dispatchProfile?: unknown;
  pricing?: unknown;
  disabled?: unknown;
}

/**
 * The public projection of the same list, read only for `reasoning_efforts` and
 * `reasons_within_output_budget`: the server computes those in llm-adapters, which this client
 * cannot import, and `/api/models` does not carry them.
 */
const PUBLIC_MODELS_PATH = '/api/v1/models';
const PUBLIC_MODELS_PAGE = 100;
const PUBLIC_MODELS_MAX_PAGES = 5;
const PUBLIC_MODELS_TIMEOUT_MS = 5_000;

/** How a model reasons, as one `/api/v1/models` row states it; a field the row lacks is absent. */
export interface HostedReasoning {
  efforts?: readonly ReasoningEffort[];
  reasonsWithinOutputBudget?: boolean;
}

export type HostedReasoningById = ReadonlyMap<string, HostedReasoning>;

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
  /** The cached hosted list changed without a list() call, after the reasoning read landed late. */
  changed?(): void;
}

/**
 * The models this deployment will actually accept, fetched once and cached per environment.
 *
 * A failed or empty fetch is NOT cached: the picker retries on its next open, and caching
 * "no models" would hide a healthy server behind one network blip for the rest of the TTL -
 * the same reasoning `/api/models` applies to its own server-side cache.
 */
export class ModelCatalog {
  private cache: { environmentUrl: string; wire: unknown; models: ChatModelOption[]; expiresAt: number } | null = null;

  /** The last `/api/v1/models` read, kept past the list's TTL so a slow read never costs what is already known. */
  private reasoning: { environmentUrl: string; byId: HostedReasoningById } | null = null;

  private reasoningRead: string | null = null;

  private localCache: { models: ChatModelOption[]; expiresAt: number } | null = null;
  /**
   * Reads started, and the newest start number whose read may no longer be cached: a read never replaces one that
   * started later, and one in flight at forgetLocal() is not cached.
   */
  private localReads = 0;
  private localWritten = 0;

  /** Separate from `cache` because the two views are read on different paths; see listImageModels. */
  private imageCache: { environmentUrl: string; models: string[]; expiresAt: number } | null = null;

  private videoCache: { environmentUrl: string; models: VideoModel[]; expiresAt: number } | null = null;

  constructor(
    private readonly deps: ModelCatalogDeps,
    private readonly local: { models(options?: ModelListOptions): Promise<ChatModelOption[]> } = new OllamaLocal()
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

  async list(force: boolean | 'local' = false): Promise<ChatModelCatalog> {
    const api = this.deps.getApiClient();
    const entry = this.cache;
    const hostedHit =
      force !== true && api && entry?.environmentUrl === this.deps.getEnvironmentUrl() && Date.now() < entry.expiresAt
        ? entry.models
        : null;
    // The device and the server are asked at the same time; neither waits on the other, and the list
    // waits on neither the effort levels nor the reasoning floor, which update it when they land.
    if (api && !hostedHit) this.refreshReasoning(api);
    const [local, hosted] = await Promise.all([
      this.listLocal(force !== false),
      api && !hostedHit
        ? api.get<{ models?: WireModel[] }>(MODELS_PATH).then(
            response => ({ ok: true as const, wire: response?.models }),
            (err: unknown) => ({ ok: false as const, err })
          )
        : null,
    ]);
    if (hostedHit) return { models: this.mergeLocal(hostedHit, local) };
    if (!api || !hosted) return local.length ? { models: local } : { models: [], error: 'Sign in to see models.' };

    if (!hosted.ok) {
      const message = hosted.err instanceof Error ? hosted.err.message : String(hosted.err);
      this.deps.logger.warn(`CHAT: model list lookup failed: ${message}`);
      return local.length
        ? { models: local }
        : { models: [], error: 'Could not load the model list from this server.' };
    }
    const environmentUrl = this.deps.getEnvironmentUrl();
    const known = this.reasoning?.environmentUrl === environmentUrl ? this.reasoning.byId : undefined;
    const models = selectUsableModels(hosted.wire, known);

    if (models.length === 0) {
      this.cache = null;
      this.deps.logger.warn('CHAT: server returned no tool-capable text models');
      return { models: local };
    }

    this.cache = { environmentUrl, wire: hosted.wire, models, expiresAt: Date.now() + CACHE_TTL_MS };
    this.deps.logger.debug(`CHAT: ${models.length} model(s) available`);
    return { models: this.mergeLocal(models, local) };
  }

  /** Starts one reasoning read per environment; a read that lands after the list rebuilds the cached one. */
  private refreshReasoning(api: AuthenticatedApiClient): void {
    const environmentUrl = this.deps.getEnvironmentUrl();
    if (this.reasoningRead === environmentUrl) return;
    this.reasoningRead = environmentUrl;
    void this.readReasoning(api).then(byId => {
      if (this.reasoningRead === environmentUrl) this.reasoningRead = null;
      if (!byId || environmentUrl !== this.deps.getEnvironmentUrl()) return;
      const previous = this.reasoning?.environmentUrl === environmentUrl ? this.reasoning.byId : undefined;
      this.reasoning = { environmentUrl, byId };
      if (previous && JSON.stringify([...previous]) === JSON.stringify([...byId])) return;
      const entry = this.cache;
      if (entry?.environmentUrl !== environmentUrl) return;
      this.cache = { ...entry, models: selectUsableModels(entry.wire, byId) };
      this.deps.changed?.();
    });
  }

  /**
   * How every listed model reasons, or null when the server publishes nothing (an older server, a
   * failed read). Any failure leaves the list itself alone: the models then keep the levels Desktop
   * always offered.
   */
  private async readReasoning(api: AuthenticatedApiClient): Promise<HostedReasoningById | null> {
    const reasoning = new Map<string, HostedReasoning>();
    let cursor: string | null = null;
    try {
      for (let page = 0; page < PUBLIC_MODELS_MAX_PAGES; page++) {
        const response: unknown = await api.get<unknown>(PUBLIC_MODELS_PATH, {
          params: { limit: PUBLIC_MODELS_PAGE, ...(cursor ? { cursor } : {}) },
          timeout: PUBLIC_MODELS_TIMEOUT_MS,
        });
        const read = parseReasoningPage(response);
        if (!read) return null;
        for (const [id, row] of read.rows) reasoning.set(id, row);
        cursor = read.nextCursor;
        if (!cursor) break;
      }
    } catch (err) {
      this.deps.logger.debug(`CHAT: effort levels unavailable: ${err instanceof Error ? err.message : 'unknown'}`);
      return null;
    }
    return reasoning;
  }

  /** Device discovery never depends on the configured server or account. */
  async listLocal(force = false, options?: ModelListOptions): Promise<ChatModelOption[]> {
    if (!force && this.localCache && Date.now() < this.localCache.expiresAt) {
      return withCurrentContexts(this.localCache.models);
    }
    const started = ++this.localReads;
    const models = await this.local.models(options);
    if (started > this.localWritten) {
      this.localWritten = started;
      this.localCache = { models, expiresAt: Date.now() + 5_000 };
    }
    return withCurrentContexts(models);
  }

  /** The last local list however old, without a round trip; null before the first list or after forgetLocal. */
  lastLocal(): ChatModelOption[] | null {
    return this.localCache ? withCurrentContexts(this.localCache.models) : null;
  }

  /** After the local context setting changes or a model turns out removed, so the next list reads Ollama again. */
  forgetLocal(): void {
    this.localCache = null;
    this.localWritten = this.localReads;
  }

  /**
   * After a server's health changed: the next list reads again while lastLocal keeps the rows, and a read in flight
   * still caches its result, since a picker read can itself be what changed that health.
   */
  expireLocal(): void {
    if (this.localCache) this.localCache = { ...this.localCache, expiresAt: 0 };
  }

  private mergeLocal(hosted: ChatModelOption[], local = this.freshLocal()): ChatModelOption[] {
    return [...hosted.filter(model => !local.some(candidate => candidate.id === model.id)), ...local];
  }

  private freshLocal(): ChatModelOption[] {
    return this.localCache && Date.now() < this.localCache.expiresAt ? withCurrentContexts(this.localCache.models) : [];
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
    if (tokens === undefined || tokens === model.contextWindow) return model;
    return {
      ...model,
      contextWindow: tokens,
      ...(model.controls ? { controls: withOllamaContext(model.controls, tokens) } : {}),
    };
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
export function selectUsableModels(wire: unknown, reasoning?: HostedReasoningById): ChatModelOption[] {
  if (!Array.isArray(wire)) return [];

  return wire
    .filter((model): model is WireModel => !!model && typeof model === 'object')
    .filter(model => model.type === 'text' && model.supportsTools === true && typeof model.id === 'string')
    .map(model => {
      const id = model.id as string;
      const maxOutputTokens =
        typeof model.max_tokens === 'number' && model.max_tokens > 0 ? model.max_tokens : undefined;
      const stated = reasoning?.get(id);
      const controls = hostedControls(
        {
          id,
          ...(typeof model.backend === 'string' ? { backend: model.backend } : {}),
          canThink: model.can_think === true,
          ...(typeof model.thinkingStyle === 'string' ? { thinkingStyle: model.thinkingStyle } : {}),
          ...(maxOutputTokens ? { maxOutputTokens } : {}),
          maxCompletionTokens: maxTokensParamOf(model.dispatchProfile) === 'max_completion_tokens',
          ...(stated?.reasonsWithinOutputBudget !== undefined
            ? { reasonsWithinOutputBudget: stated.reasonsWithinOutputBudget }
            : {}),
        },
        stated?.efforts,
        supportsReasoningEffort(id)
      );
      return {
        id,
        name: typeof model.name === 'string' && model.name ? model.name : id,
        ...(typeof model.backend === 'string' ? { backend: model.backend } : {}),
        ...(typeof model.releaseDate === 'string' && model.releaseDate ? { releaseDate: model.releaseDate } : {}),
        ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
        // Carried through only when the server stated it. Absent is "not said", which the
        // attachment gate treats differently from an explicit false - see ChatService.
        ...(typeof model.supportsVision === 'boolean' ? { supportsVision: model.supportsVision } : {}),
        // Always stated: the renderer disables the effort picker on a model that would ignore the field.
        supportsReasoningEffort: controls.effort !== undefined,
        // Direct Anthropic only: it is the one backend Desktop marks for caching (see supportsPromptCache).
        ...(model.backend === 'anthropic' && supportsOneHourPromptCache({ id, backend: model.backend })
          ? { supportsOneHourCache: true }
          : {}),
        supportsTools: true,
        ...(model.backend === 'ollama' && model.can_think === true ? { thinkingToggle: true } : {}),
        ...(model.disabled === true ? { disabled: true } : {}),
        ...pricingOf(model.pricing),
        controls,
      };
    });
}

function maxTokensParamOf(profile: unknown): unknown {
  return profile && typeof profile === 'object' ? (profile as { maxTokensParam?: unknown }).maxTokensParam : undefined;
}

const KNOWN_EFFORTS: ReadonlySet<string> = new Set(CompletionReasoningEffortSchema.options);

/** One page of `/api/v1/models`, or null when the answer is not that shape. */
export function parseReasoningPage(
  wire: unknown
): { rows: [string, HostedReasoning][]; nextCursor: string | null } | null {
  if (!wire || typeof wire !== 'object') return null;
  const { data, next_cursor: nextCursor } = wire as { data?: unknown; next_cursor?: unknown };
  if (!Array.isArray(data)) return null;
  const rows = data.flatMap((row): [string, HostedReasoning][] => {
    const {
      id,
      reasoning_efforts: levels,
      reasons_within_output_budget: withinBudget,
    } = (row ?? {}) as { id?: unknown; reasoning_efforts?: unknown; reasons_within_output_budget?: unknown };
    if (typeof id !== 'string') return [];
    const read: HostedReasoning = {
      ...(Array.isArray(levels)
        ? { efforts: levels.filter((level): level is ReasoningEffort => KNOWN_EFFORTS.has(level)) }
        : {}),
      ...(typeof withinBudget === 'boolean' ? { reasonsWithinOutputBudget: withinBudget } : {}),
    };
    return Object.keys(read).length > 0 ? [[id, read]] : [];
  });
  return { rows, nextCursor: typeof nextCursor === 'string' && nextCursor ? nextCursor : null };
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
