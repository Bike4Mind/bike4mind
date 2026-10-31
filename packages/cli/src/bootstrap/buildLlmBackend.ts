import type { ModelInfo } from '@bike4mind/common';
import {
  OllamaBackend,
  OpenAICompatibleBackend,
  type ICompletionBackend,
  type OpenAICompatibleBackendOptions,
} from '@bike4mind/llm-adapters';
import { parseLocalModelId, type FetchLike } from '@bike4mind/local-models/servers';
import type { ILogger } from '@bike4mind/observability';
import { extractErrorMessage } from '@bike4mind/utils';
import type { CliConfig } from '../storage';
import type { ApiClient } from '../auth/ApiClient';
import { logger } from '../utils/Logger';
import { withDefaultOllamaPort } from '../utils/ollamaHost.js';
import { ServerLlmBackend } from '../llm/ServerLlmBackend';
import { WebSocketLlmBackend } from '../llm/WebSocketLlmBackend';
import { MultiLlmBackend, type LlmRoute } from '../llm/MultiLlmBackend.js';
import { ServerModelBackend } from '../llm/ServerModelBackend.js';
import { clean } from '../models/localModels.js';
import {
  loadModelServers,
  loginHint,
  needsCredential,
  resolveServerTarget,
  serverFetch,
  type CliModelServer,
  type LoadedModelServers,
} from '../models/modelServers.js';
import { setWebSocketToolExecutor } from '../llm/ToolRouter';
import { WebSocketConnectionManager } from '../ws/WebSocketConnectionManager';
import { createSseBackend } from './sseTransport.js';

/** The concrete backend types this builder can produce. */
export type CliLlmBackend = ServerLlmBackend | WebSocketLlmBackend | MultiLlmBackend;

export interface BuildLlmBackendInput {
  config: CliConfig;
  apiClient: ApiClient;
  /** Token getter for the feature-event WebSocket auth. */
  tokenGetter: () => Promise<string | null>;
  /** Startup log collected for the two-column banner; pushed into, not owned. */
  startupLog: string[];
  /** Ollama endpoint; defaults to process.env.B4M_OLLAMA_HOST, then config.ollamaHost. Injectable for tests. */
  ollamaHost?: string;
  /** Deadline for listing a saved Ollama host's models (ms); defaults to `SAVED_OLLAMA_LISTING_TIMEOUT_MS`. */
  ollamaListingTimeoutMs?: number;
  /** The live session id, sent with each completion so the server ledger can attribute it. */
  getSessionId?: () => string | undefined;
  /** Where a model server's tools-off notice goes; defaults to a logged warning. */
  onNotice?: (text: string) => void;
}

export const SAVED_OLLAMA_LISTING_TIMEOUT_MS = 5_000;

const WARNING_SIGN = String.fromCodePoint(0x26a0, 0xfe0f);
const COMPUTER_SIGN = String.fromCodePoint(0x1f5a5, 0xfe0f);

export interface BuildLlmBackendResult {
  llm: CliLlmBackend;
  /**
   * Realtime socket for feature-module events only - completions always use SSE.
   * Null unless a WS-consuming feature is enabled and the server advertises a
   * `websocketUrl` (and null if that connect failed).
   */
  wsManager: WebSocketConnectionManager | null;
  models: ModelInfo[];
  /** The resolved default model (falls back to models[0] if requested model is unavailable). */
  modelInfo: ModelInfo;
}

/**
 * Side-effecting collaborators, injected so the transport wiring can be
 * unit-tested with fakes (no real WebSocket, SSE, or Ollama). Production callers
 * omit this - `defaultLlmBackendDeps` is used, which wires the real classes and
 * the `setWebSocketToolExecutor` singleton.
 */
export interface BuildLlmBackendDeps {
  /**
   * Create + connect a WebSocket manager for feature-module events. Rejects if the
   * socket can't connect. `verifySession` is called when a connect ATTEMPT fails to
   * open (a 401 handshake refusal never fires onopen) - see WebSocketConnectionManager
   * for why this is the only way to tell "session revoked" apart from "transient
   * network issue" on a WS close.
   */
  connectWebSocket: (
    wsUrl: string,
    tokenGetter: () => Promise<string | null>,
    verifySession: () => Promise<boolean>
  ) => Promise<WebSocketConnectionManager>;
  /** Clear the server-tool executor: with SSE completions, tools run CLI-side. */
  clearWebSocketToolExecutor: () => void;
  createServerBackend: (opts: ConstructorParameters<typeof ServerLlmBackend>[0]) => CliLlmBackend;
  /** `fetch` is a saved model server's, which adds its credentials. */
  createOllamaBackend: (host: string, options?: { fetch?: FetchLike }) => LocalBackend;
  createOpenAICompatibleBackend: (options: OpenAICompatibleBackendOptions) => LocalBackend;
  createMultiBackend: (
    server: CliLlmBackend,
    serverModels: ModelInfo[],
    routes: LlmRoute[],
    defaultModel: string
  ) => CliLlmBackend;
  /** Desktop's saved model servers; defaults to reading Desktop's file. */
  loadModelServers?: () => Promise<LoadedModelServers>;
}

/** A local backend that can also list its models. */
export type LocalBackend = ICompletionBackend & { getModelInfo(): Promise<ModelInfo[]> };

const cliLogger: ILogger = {
  debug: (...args: unknown[]) => logger.debug(args.map(String).join(' ')),
  info: (...args: unknown[]) => logger.info(args.map(String).join(' ')),
  warn: (...args: unknown[]) => logger.warn(args.map(String).join(' ')),
  error: (...args: unknown[]) => logger.error(args.map(String).join(' ')),
};

/** Production wiring: real transport classes + the ToolRouter singleton. */
export const defaultLlmBackendDeps: BuildLlmBackendDeps = {
  connectWebSocket: async (wsUrl, tokenGetter, verifySession) => {
    const ws = new WebSocketConnectionManager(wsUrl, tokenGetter, verifySession);
    ws.onRevoked(() => {
      logger.warn('Session revoked - run `b4m login` again. WebSocket reconnect stopped.');
    });
    try {
      await ws.connect();
    } catch (err) {
      // A failed connect ATTEMPT still schedules a verify/reconnect via onclose. If the
      // caller falls back to SSE on this throw, that background loop would be orphaned -
      // reconnecting forever with no owner. Tear it down before propagating.
      ws.disconnect();
      throw err;
    }
    return ws;
  },
  clearWebSocketToolExecutor: () => setWebSocketToolExecutor(null),
  createServerBackend: opts => new ServerLlmBackend(opts),
  createOllamaBackend: (host, options) =>
    new OllamaBackend(host, cliLogger, { fetch: options?.fetch as typeof globalThis.fetch | undefined }),
  createOpenAICompatibleBackend: options => new OpenAICompatibleBackend({ logger: cliLogger, ...options }),
  createMultiBackend: (server, serverModels, routes, defaultModel) =>
    new MultiLlmBackend(server, serverModels, routes, defaultModel),
};

/**
 * True when some enabled feature module consumes realtime server events. Only
 * Tavern does today (TavernModule.registerWsHandlers -> TavernActivityStream);
 * keep this in sync with the module registration in index.tsx. Everything else
 * runs socket-free, so the common path never opens a WebSocket.
 */
function needsFeatureEventSocket(config: CliConfig): boolean {
  return config.features?.tavern === true;
}

/**
 * Connect the events-only socket that feature modules register handlers on.
 * Returns null when it isn't needed, isn't advertised, or won't connect - a
 * feature's live updates degrading is never a reason to fail startup, since
 * completions no longer depend on this socket at all.
 */
async function connectFeatureEventSocket(
  config: CliConfig,
  websocketUrl: string | undefined,
  deps: BuildLlmBackendDeps,
  auth: { tokenGetter: () => Promise<string | null>; verifySession: () => Promise<boolean> }
): Promise<WebSocketConnectionManager | null> {
  if (!needsFeatureEventSocket(config)) return null;
  if (!websocketUrl) {
    logger.debug('[WS] No websocketUrl in server config - feature live updates disabled');
    return null;
  }

  try {
    return await deps.connectWebSocket(websocketUrl, auth.tokenGetter, auth.verifySession);
  } catch (err) {
    logger.warn(
      `Realtime socket unavailable - live feature updates are disabled: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * Resolve the model to use from the available list: the requested default if
 * present, otherwise the first available model. Pure - exported for testing.
 */
export function resolveModelInfo(models: ModelInfo[], defaultModel: string): ModelInfo {
  return models.find(m => m.id === defaultModel) || models[0];
}

/**
 * A saved `local:` default that is not listed is never swapped for another model, hosted or not. A default on a
 * saved model server has already failed with the server's own reason in `attachLocalModels`.
 */
export function requireLocalDefaultListed(models: ModelInfo[], defaultModel: string): void {
  if (!defaultModel.startsWith('local:') || models.some(m => m.id === defaultModel)) return;
  throw new Error(
    `Model "${clean(defaultModel)}" is on a local runtime the CLI cannot chat with, so it was not replaced by another model. ` +
      'Pick another model with: b4m models use <name>'
  );
}

/**
 * Model choice for headless (`-p`) runs, which have no banner to show a fallback in. A missing default that is
 * plausibly local (Ollama did not list its models, or `b4m models use` chose it) is an error rather than a silent
 * switch to a hosted model; with Ollama configured any other fallback comes with a warning to print.
 */
export function resolveHeadlessModel(
  models: ModelInfo[],
  config: Pick<CliConfig, 'defaultModel' | 'localDefaultModel'>,
  ollama: Pick<LocalModelsAttachment, 'ollamaHost' | 'ollamaListingFailed'>
): { modelInfo: ModelInfo; warning: string | null } {
  const { defaultModel } = config;
  requireLocalDefaultListed(models, defaultModel);
  const modelInfo = resolveModelInfo(models, defaultModel);
  if (modelInfo.id === defaultModel || !ollama.ollamaHost) return { modelInfo, warning: null };
  if (ollama.ollamaListingFailed || defaultModel === config.localDefaultModel) {
    throw new Error(
      `Model "${defaultModel}" is not available from the server or from Ollama at ${ollama.ollamaHost}. ` +
        'Start Ollama, or pick another model with: b4m models use <name>'
    );
  }
  return { modelInfo, warning: `Model "${defaultModel}" is not available; using "${modelInfo.id}".` };
}

export interface LocalModelsAttachment {
  llm: CliLlmBackend;
  models: ModelInfo[];
  /** The Ollama host in use, or null when none is configured. */
  ollamaHost: string | null;
  ollamaModelCount: number;
  /** Ollama's model listing failed or timed out, so its models are unknown. */
  ollamaListingFailed: boolean;
  /** Saved model servers whose models were listed. */
  servers: { name: string; modelCount: number }[];
  warnings: string[];
}

export interface AttachLocalModelsOptions {
  ollamaHost?: string;
  listingTimeoutMs?: number;
  /** Which saved model servers to list: all of them (interactive, for the picker) or only the default model's. */
  servers?: 'all' | 'default';
  /** Says why a turn runs without tools and how to fix it; called once per cause. */
  onNotice?: (text: string) => void;
}

type LocalModelsDeps = Pick<
  BuildLlmBackendDeps,
  'createOllamaBackend' | 'createOpenAICompatibleBackend' | 'createMultiBackend' | 'loadModelServers'
>;

/** Rejects after `ms`, so a saved host or server that is gone cannot hold up startup; undefined waits. */
function withDeadline<T>(work: Promise<T>, ms: number | undefined): Promise<T> {
  if (ms === undefined) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s`)), ms);
    timer.unref?.();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** The saved server id and model of a `local:srv-<id>:<model>` default; null for any other default. */
function defaultOnServer(defaultModel: string): { serverId: string; model: string } | null {
  const parsed = parseLocalModelId(defaultModel);
  if (!parsed?.runtimeId.startsWith('srv-')) return null;
  return { serverId: parsed.runtimeId.slice('srv-'.length), model: parsed.model };
}

function defaultUnusable(model: string, server: string, reason: string): Error {
  return new Error(
    `Cannot chat with ${clean(model)} on ${clean(server)}: ${reason}\n` +
      'The CLI does not switch to another model on its own. To pick one, run: b4m models use <name>'
  );
}

/** Probes one saved server with the CLI's credential and lists its models under server-scoped ids. */
async function attachServer(
  server: CliModelServer,
  config: CliConfig,
  opts: AttachLocalModelsOptions,
  deps: LocalModelsDeps
): Promise<LlmRoute> {
  const secret = config.modelServerCredentials?.[server.id]?.secret;
  if (needsCredential(server, secret))
    throw new Error(`${clean(server.name)} needs credentials. Run: ${loginHint(server)}`);
  const fetch = serverFetch(server, secret);
  const target = await resolveServerTarget(server, secret, fetch);
  const baseUrl = target.runtime.baseUrl;
  const inner =
    target.runtime.kind === 'ollama'
      ? deps.createOllamaBackend(baseUrl, { fetch })
      : deps.createOpenAICompatibleBackend({
          baseUrl,
          label: clean(server.name),
          product: target.product,
          fetch,
          redact: target.redact,
          onNotice: opts.onNotice,
        });
  const backend = new ServerModelBackend(inner, {
    server: { id: server.id, name: server.name },
    onNotice: opts.onNotice,
  });
  return { backend, models: await backend.getModelInfo() };
}

/**
 * Lists saved model servers in parallel. A server holding the default model must answer and list it, or startup
 * fails with the server's reason; any other server that cannot be used becomes a warning.
 */
async function attachServers(
  config: CliConfig,
  opts: AttachLocalModelsOptions,
  deps: LocalModelsDeps
): Promise<{ routes: (LlmRoute & { name: string })[]; warnings: string[] }> {
  const wanted = defaultOnServer(config.defaultModel);
  if ((opts.servers ?? 'all') === 'default' && !wanted) return { routes: [], warnings: [] };
  const loaded = await (deps.loadModelServers ?? loadModelServers)();
  const warnings: string[] = [];
  const owner = wanted ? loaded.servers.find(server => server.id === wanted.serverId) : undefined;
  if (wanted && !owner) {
    throw new Error(
      `The default model ${clean(wanted.model)} is on a model server that is not saved in Desktop any more` +
        (loaded.problem ? ` (${loaded.problem})` : '') +
        ', so it was not replaced by another model. Pick another model with: b4m models use <name>'
    );
  }
  if (loaded.problem) warnings.push(`\u26a0\ufe0f  Desktop's model servers were not read: ${loaded.problem}`);

  const chosen = (opts.servers ?? 'all') === 'all' ? loaded.servers : [owner!];
  const deadlineMs = opts.listingTimeoutMs ?? SAVED_OLLAMA_LISTING_TIMEOUT_MS;
  const settled = await Promise.all(
    chosen.map(server =>
      withDeadline(attachServer(server, config, opts, deps), deadlineMs).then(
        route => ({ server, route, error: null }),
        (error: unknown) => ({ server, route: null, error: clean(extractErrorMessage(error)) })
      )
    )
  );
  const routes: (LlmRoute & { name: string })[] = [];
  for (const { server, route, error } of settled) {
    const name = clean(server.name);
    if (server === owner && wanted) {
      if (!route) throw defaultUnusable(wanted.model, server.name, error ?? 'it did not answer.');
      if (!route.models.some(model => model.id === config.defaultModel)) {
        throw defaultUnusable(
          wanted.model,
          server.name,
          `${name} does not serve it. See: b4m models ls --server ${name}`
        );
      }
    }
    if (route) routes.push({ ...route, name });
    else warnings.push(`\u26a0\ufe0f  Model server ${name} skipped: ${error}`);
  }
  return { routes, warnings };
}

/**
 * Wraps the server backend with Ollama (when a host is given, set in B4M_OLLAMA_HOST, or saved by `b4m models`)
 * and with Desktop's saved model servers, and lists the models of all of them. Shared by interactive and headless
 * (`-p`) startup.
 */
export async function attachLocalModels(
  llm: CliLlmBackend,
  config: CliConfig,
  opts: AttachLocalModelsOptions,
  deps: LocalModelsDeps
): Promise<LocalModelsAttachment> {
  const explicit = opts.ollamaHost ?? (process.env.B4M_OLLAMA_HOST || undefined);
  const rawHost = explicit ?? config.ollamaHost;
  const ollamaHost = rawHost ? withDefaultOllamaPort(rawHost) : null;
  const ollamaBackend = ollamaHost ? deps.createOllamaBackend(ollamaHost) : null;
  // A down Ollama must not block startup on the server models. A saved host may be a machine that is
  // gone, so its listing also gets a deadline; a host passed for this run is waited on.
  const deadlineMs = explicit ? undefined : (opts.listingTimeoutMs ?? SAVED_OLLAMA_LISTING_TIMEOUT_MS);
  const ollamaListing = ollamaBackend
    ? withDeadline(ollamaBackend.getModelInfo(), deadlineMs).then(
        (listed): { models: ModelInfo[]; error?: string } => ({ models: listed }),
        (error: unknown) => {
          const message = extractErrorMessage(error);
          logger.warn(`Error fetching model info from Ollama: ${message}`);
          return { models: [] as ModelInfo[], error: message };
        }
      )
    : Promise.resolve({ models: [] as ModelInfo[] } as { models: ModelInfo[]; error?: string });
  const [serverModels, ollama, servers] = await Promise.all([
    llm.getModelInfo(),
    ollamaListing,
    attachServers(config, opts, deps),
  ]);
  const ollamaModels = ollama.models;
  const serverRouteModels = servers.routes.reduce((count, route) => count + route.models.length, 0);

  if (serverModels.length === 0 && ollamaModels.length === 0 && serverRouteModels === 0) {
    if (!ollamaHost) throw new Error('No models available from server.');
    throw new Error(
      ollama.error !== undefined
        ? `No models available from server, and Ollama at ${ollamaHost} is unreachable: ${ollama.error}`
        : `No models available from server or Ollama at ${ollamaHost}.\n` + `Pull a model: ollama pull qwen3.5`
    );
  }
  const warnings: string[] = [];
  if (ollama.error !== undefined) {
    warnings.push(`\u26a0\ufe0f  Ollama at ${ollamaHost} is unreachable: ${ollama.error}`);
  } else if (ollamaHost && ollamaModels.length === 0) {
    warnings.push(`\u26a0\ufe0f  No models found in Ollama at ${ollamaHost}. Pull one with: ollama pull qwen3.5`);
  }
  warnings.push(...servers.warnings);

  const routes: LlmRoute[] = [
    ...(ollamaBackend ? [{ backend: ollamaBackend, models: ollamaModels }] : []),
    ...servers.routes,
  ];
  const summary = {
    ollamaHost,
    ollamaModelCount: ollamaModels.length,
    ollamaListingFailed: ollama.error !== undefined,
    servers: servers.routes.map(route => ({ name: route.name, modelCount: route.models.length })),
    warnings,
  };
  if (routes.length === 0) return { llm, models: serverModels, ...summary };
  const multi = deps.createMultiBackend(llm, serverModels, routes, config.defaultModel);
  return { llm: multi, models: await multi.getModelInfo(), ...summary };
}

/**
 * Build the LLM backend: HTTP+SSE transport (ServerLlmBackend), optional Ollama
 * multiplexing. Resolves the default model and pins it on the backend.
 *
 * The WebSocket COMPLETION transport was removed - completions always use SSE,
 * because relays that emit the generic `streamed_chat_completion` action drop
 * every CLI chunk. The socket itself is still connected, but only when a
 * WS-consuming feature module is enabled, and only to carry that module's events
 * (see `wsManager`); Keep relay and WS server-side tool execution stay off.
 *
 * Pure bootstrap seam: no React hooks, no Zustand state.
 */
export async function buildLlmBackend(
  input: BuildLlmBackendInput,
  deps: BuildLlmBackendDeps = defaultLlmBackendDeps
): Promise<BuildLlmBackendResult> {
  const { config, apiClient, startupLog, tokenGetter, getSessionId } = input;

  const sse = await createSseBackend(
    { apiClient, model: config.defaultModel, getSessionId },
    { createServerBackend: deps.createServerBackend, clearWebSocketToolExecutor: deps.clearWebSocketToolExecutor }
  );
  const wsManager = await connectFeatureEventSocket(config, sse.serverConfig.websocketUrl, deps, {
    tokenGetter,
    verifySession: () => apiClient.checkSessionValid(),
  });

  const attached = await attachLocalModels(
    sse.llm,
    config,
    {
      ollamaHost: input.ollamaHost,
      listingTimeoutMs: input.ollamaListingTimeoutMs,
      servers: 'all',
      onNotice: input.onNotice ?? (text => logger.warn(`${WARNING_SIGN}  ${text}`)),
    },
    deps
  );
  const { llm, models } = attached;
  startupLog.push(...attached.warnings);
  if (attached.ollamaHost) {
    startupLog.push(`\u{1f999} Self-hosted Ollama: ${attached.ollamaModelCount} model(s) added to picker`);
  }
  for (const server of attached.servers) {
    startupLog.push(`${COMPUTER_SIGN}  Model server ${server.name}: ${server.modelCount} model(s) added to picker`);
  }

  logger.debug(`📋 Available models: ${models.map(m => m.id).join(', ')}`);

  requireLocalDefaultListed(models, config.defaultModel);
  const modelInfo = resolveModelInfo(models, config.defaultModel);

  // Log model selection
  if (modelInfo.id !== config.defaultModel) {
    logger.warn(`⚠️  Requested model '${config.defaultModel}' not available`);
    logger.warn(`🤖 Using fallback model: ${modelInfo.id}`);
  }

  // Update LLM backend with selected model
  llm.currentModel = modelInfo.id;

  return { llm, wsManager, models, modelInfo };
}
