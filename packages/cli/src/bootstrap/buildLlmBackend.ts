import type { ModelInfo } from '@bike4mind/common';
import {
  OllamaBackend,
  OpenAICompatibleBackend,
  type ICompletionBackend,
  type OllamaRequestSettingsReader,
  type OpenAICompatibleBackendOptions,
} from '@bike4mind/llm-adapters';
import { detectRuntimes } from '@bike4mind/local-models';
import { parseLocalModelId, serverRuntimeId, type FetchLike } from '@bike4mind/local-models/servers';
import type { ILogger } from '@bike4mind/observability';
import { extractErrorMessage } from '@bike4mind/utils';
import type { CliConfig } from '../storage';
import type { ApiClient } from '../auth/ApiClient';
import { logger } from '../utils/Logger';
import { DEFAULT_OLLAMA_PORT, withDefaultOllamaPort } from '../utils/ollamaHost.js';
import { ServerLlmBackend } from '../llm/ServerLlmBackend';
import { WebSocketLlmBackend } from '../llm/WebSocketLlmBackend';
import { MultiLlmBackend, type LlmRoute } from '../llm/MultiLlmBackend.js';
import { ServerModelBackend } from '../llm/ServerModelBackend.js';
import { desktopRequestSettings, desktopRuntimeIdForHost } from '../llm/desktopModelSettings.js';
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
import {
  INSTALL_OLLAMA_HINT,
  NoLocalModelsError,
  SignedOutCloudBackend,
  signedOutDefaultReplacedMessage,
  savedServerDownMessage,
  signedOutHeadlessCloudModelMessage,
} from './signedOutLocal.js';

/** The concrete backend types this builder can produce. */
export type CliLlmBackend = ServerLlmBackend | WebSocketLlmBackend | MultiLlmBackend | SignedOutCloudBackend;

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
  /** With no Ollama host configured, attach an Ollama answering on the default loopback address. */
  detectOllama?: boolean;
  /** Deadline for that probe (ms); defaults to `OLLAMA_DETECT_TIMEOUT_MS`. */
  ollamaDetectTimeoutMs?: number;
  /** Deadline for listing a detected Ollama's models (ms); defaults to `DETECTED_OLLAMA_LISTING_TIMEOUT_MS`. */
  ollamaDetectedListingTimeoutMs?: number;
  /** The live session id, sent with each completion so the server ledger can attribute it. */
  getSessionId?: () => string | undefined;
  /** Where a model server's tools-off notice goes; defaults to a logged warning. */
  onNotice?: (text: string) => void;
  /** Called with the full model list each time a saved model server joins after startup. */
  onModelsAdded?: (models: ModelInfo[]) => void;
  /** Which saved model servers to attach; defaults to all. A host that never switches models only needs the default's. */
  servers?: 'all' | 'default';
}

export const SAVED_OLLAMA_LISTING_TIMEOUT_MS = 5_000;
/** How long startup waits for an Ollama on the default loopback address when no host is configured. */
export const OLLAMA_DETECT_TIMEOUT_MS = 1_000;
/** How long startup waits to list the models of a detected Ollama; the user never configured it. */
export const DETECTED_OLLAMA_LISTING_TIMEOUT_MS = 1_500;
/** The default model's server must answer before startup goes on; a busy CPU-only box can be slow to. */
export const DEFAULT_SERVER_TIMEOUT_MS = 60_000;

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
  /** Settles once every other saved model server has joined `llm` or been skipped. */
  later: Promise<void>;
  /** An Ollama found running with no host configured, with the ids it listed; null otherwise. */
  detectedOllama: { host: string; modelIds: ReadonlySet<string> } | null;
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
  /**
   * `fetch` is a saved model server's, which adds its credentials; `redact` scrubs them from what is logged.
   * `requestSettings` applies Desktop's per-model settings to the host's models.
   */
  createOllamaBackend: (
    host: string,
    options?: { fetch?: FetchLike; redact?: (text: string) => string; requestSettings?: OllamaRequestSettingsReader }
  ) => LocalBackend;
  createOpenAICompatibleBackend: (options: OpenAICompatibleBackendOptions) => LocalBackend;
  createMultiBackend: (
    server: CliLlmBackend,
    serverModels: ModelInfo[],
    routes: LlmRoute[],
    defaultModel: string
  ) => MultiLlmBackend;
  /** Desktop's saved model servers; defaults to reading Desktop's file. */
  loadModelServers?: () => Promise<LoadedModelServers>;
  /** The base URL of a healthy Ollama on the default loopback address, or null. Must stop when `signal` aborts. */
  detectOllama: (signal: AbortSignal) => Promise<string | null>;
}

/** A local backend that can also list its models. */
export type LocalBackend = ICompletionBackend & { getModelInfo(): Promise<ModelInfo[]> };

function cliLogger(redact: (text: string) => string = text => text): ILogger {
  const line = (args: unknown[]) => redact(args.map(String).join(' '));
  return {
    debug: (...args: unknown[]) => logger.debug(line(args)),
    info: (...args: unknown[]) => logger.info(line(args)),
    warn: (...args: unknown[]) => logger.warn(line(args)),
    error: (...args: unknown[]) => logger.error(line(args)),
  };
}

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
    new OllamaBackend(host, cliLogger(options?.redact), {
      fetch: options?.fetch as typeof globalThis.fetch | undefined,
      requestSettings: options?.requestSettings,
      settingsWarning: message => logger.warnToFile(options?.redact ? options.redact(message) : message),
    }),
  createOpenAICompatibleBackend: options => new OpenAICompatibleBackend({ logger: cliLogger(), ...options }),
  createMultiBackend: (server, serverModels, routes, defaultModel) =>
    new MultiLlmBackend(server, serverModels, routes, defaultModel),
  detectOllama: async signal => {
    const fetchUntilAborted: FetchLike = (input, init) =>
      fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
    const found = await detectRuntimes({
      defaultHosts: [`127.0.0.1:${DEFAULT_OLLAMA_PORT}`],
      fetch: fetchUntilAborted,
    });
    return found.find(entry => entry.runtime.kind === 'ollama' && entry.health.ok)?.runtime.baseUrl ?? null;
  },
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

/**
 * Headless model choice while signed out, when `models` are all local: the default if listed, else the saved local
 * default (with a warning to print). A default that is itself the local default must be listed; any other is taken
 * for a cloud model and answered with how to pick a local one or sign in.
 */
export function resolveSignedOutHeadlessModel(
  models: ModelInfo[],
  config: Pick<CliConfig, 'defaultModel' | 'localDefaultModel'>,
  ollama: Pick<LocalModelsAttachment, 'ollamaHost' | 'serverFailures'>
): { modelInfo: ModelInfo; warning: string | null } {
  const { defaultModel, localDefaultModel } = config;
  requireLocalDefaultListed(models, defaultModel);
  const listed = models.find(model => model.id === defaultModel);
  if (listed) return { modelInfo: listed, warning: null };
  if (localDefaultModel && defaultModel !== localDefaultModel) {
    const saved = models.find(model => model.id === localDefaultModel);
    if (saved) {
      return {
        modelInfo: saved,
        warning: `Not signed in, so using the saved local model "${clean(saved.id)}" instead of "${clean(defaultModel)}".`,
      };
    }
  }
  const serverDown = savedLocalDefaultDownMessage(config, ollama.serverFailures);
  if (serverDown) throw new Error(serverDown);
  if (defaultModel === localDefaultModel) {
    throw new Error(
      `Model "${clean(defaultModel)}" is not available from Ollama${ollama.ollamaHost ? ` at ${clean(ollama.ollamaHost)}` : ''}. ` +
        'Start Ollama, or pick another model with: b4m models use <name>'
    );
  }
  throw new Error(signedOutHeadlessCloudModelMessage(defaultModel));
}

/**
 * Signed out, a cloud default gives way to the saved local default, which may be on a saved model server still
 * answering; this waits for those servers (each under its own deadline) only when that is the case.
 */
export async function withSignedOutLocalDefault(
  attached: Pick<LocalModelsAttachment, 'llm' | 'models' | 'later'>,
  config: Pick<CliConfig, 'defaultModel' | 'localDefaultModel'>
): Promise<ModelInfo[]> {
  const listed = (id: string | undefined) => id !== undefined && attached.models.some(model => model.id === id);
  if (listed(config.defaultModel) || !config.localDefaultModel || listed(config.localDefaultModel)) {
    return attached.models;
  }
  await attached.later;
  return attached.llm.getModelInfo();
}

export interface LocalModelsAttachment {
  llm: CliLlmBackend;
  models: ModelInfo[];
  /** The Ollama host in use, or null when none is configured. */
  ollamaHost: string | null;
  ollamaModelCount: number;
  ollamaModelIds: string[];
  /** Ollama's model listing failed or timed out, so its models are unknown. */
  ollamaListingFailed: boolean;
  /** `ollamaHost` was found by detection, not configured. */
  ollamaDetected: boolean;
  /** Saved model servers listed before startup went on: the default model's, if any, or all that answered when `signedOut` waited for them. */
  servers: { name: string; modelCount: number }[];
  /** Other saved model servers that could not be reached or listed, or lack a credential, by server id; complete once `later` settles. */
  serverFailures: ReadonlyMap<string, { name: string; error: string }>;
  warnings: string[];
  /** Settles once every other saved model server has joined `llm` or been skipped. */
  later: Promise<void>;
}

/** Why the saved local default cannot be used when the saved model server holding it failed; else null. */
export function savedLocalDefaultDownMessage(
  config: Pick<CliConfig, 'localDefaultModel'>,
  failures: LocalModelsAttachment['serverFailures']
): string | null {
  const onServer = config.localDefaultModel ? defaultOnServer(config.localDefaultModel) : null;
  const failure = onServer ? failures.get(onServer.serverId) : undefined;
  return onServer && failure ? savedServerDownMessage(onServer.model, failure.name, failure.error) : null;
}

export interface AttachLocalModelsOptions {
  ollamaHost?: string;
  /** Asked for an Ollama base URL when no host is given, set in B4M_OLLAMA_HOST, or saved; no detection when absent. */
  detectOllama?: (signal: AbortSignal) => Promise<string | null>;
  /** Deadline for `detectOllama` (ms); defaults to `OLLAMA_DETECT_TIMEOUT_MS`. */
  detectTimeoutMs?: number;
  /** Deadline for listing a detected Ollama's models (ms); defaults to `DETECTED_OLLAMA_LISTING_TIMEOUT_MS`. */
  detectedListingTimeoutMs?: number;
  /** Deadline for a saved Ollama host, and for each saved model server other than the default model's (ms). */
  listingTimeoutMs?: number;
  /** Deadline for the default model's server to answer and list its models (ms). */
  defaultServerTimeoutMs?: number;
  /**
   * Which saved model servers to use: only the default model's, or all of them. Startup waits only for the default
   * model's; the others join `llm` as they answer.
   */
  servers?: 'all' | 'default';
  /** Says why a turn runs without tools and how to fix it; called once per cause. */
  onNotice?: (text: string) => void;
  /** Called with the full model list each time a server joins after startup. */
  onModelsAdded?: (models: ModelInfo[]) => void;
  /**
   * No Bike4Mind server to fall back on: with nothing else listed, startup waits for the other saved model
   * servers too, and finding no local model throws `NoLocalModelsError`.
   */
  signedOut?: boolean;
}

type LocalModelsDeps = Pick<
  BuildLlmBackendDeps,
  'createOllamaBackend' | 'createOpenAICompatibleBackend' | 'createMultiBackend' | 'loadModelServers'
>;

/**
 * Rejects after `ms`, so a saved host or server that is gone cannot hold up startup; undefined waits. `abort` is
 * aborted at the deadline so requests still in flight stop too.
 */
function withDeadline<T>(work: Promise<T>, ms: number | undefined, abort?: AbortController): Promise<T> {
  if (ms === undefined) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`no answer within ${ms / 1000}s`);
      abort?.abort(error);
      reject(error);
    }, ms);
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

/**
 * Probes one saved server with the CLI's credential and lists its models under server-scoped ids, all within
 * `timeoutMs`. Requests made while attaching stop at the deadline; chat requests made later have none.
 */
async function attachServer(
  server: CliModelServer,
  config: CliConfig,
  opts: AttachLocalModelsOptions,
  deps: LocalModelsDeps,
  timeoutMs: number
): Promise<LlmRoute> {
  const secret = config.modelServerCredentials?.[server.id]?.secret;
  if (needsCredential(server, secret))
    throw new Error(`${clean(server.name)} needs credentials. Run: ${loginHint(server)}`);
  const base = serverFetch(server, secret);
  const startup = new AbortController();
  let attaching = true;
  const fetch: FetchLike = (input, init = {}) =>
    attaching
      ? base(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, startup.signal]) : startup.signal })
      : base(input, init);
  const attach = async (): Promise<LlmRoute> => {
    const target = await resolveServerTarget(server, secret, fetch, timeoutMs);
    const baseUrl = target.runtime.baseUrl;
    const inner =
      target.runtime.kind === 'ollama'
        ? deps.createOllamaBackend(baseUrl, {
            fetch,
            redact: target.redact,
            requestSettings: desktopRequestSettings(serverRuntimeId(server.id)),
          })
        : deps.createOpenAICompatibleBackend({
            baseUrl,
            label: clean(server.name),
            product: target.product,
            fetch,
            redact: target.redact,
            onNotice: opts.onNotice,
            listingTimeoutMs: timeoutMs,
          });
    const backend = new ServerModelBackend(inner, {
      server: { id: server.id, name: server.name },
      onNotice: opts.onNotice,
      redact: target.redact,
    });
    return { backend, models: await backend.getModelInfo() };
  };
  try {
    return await withDeadline(attach(), timeoutMs, startup);
  } finally {
    attaching = false;
  }
}

type Settled = { route: LlmRoute; error: null } | { route: null; error: string };

function settle(work: Promise<LlmRoute>): Promise<Settled> {
  return work.then(
    route => ({ route, error: null }),
    (error: unknown) => ({ route: null, error: clean(extractErrorMessage(error)) })
  );
}

/**
 * Starts listing saved model servers in parallel. The default model's server must answer and list it, or startup
 * fails with the server's reason. The others are returned still settling, for the caller to add as they answer;
 * a server never logged into is skipped without a word, since most users save servers they do not chat with.
 */
async function attachServers(
  config: CliConfig,
  opts: AttachLocalModelsOptions,
  deps: LocalModelsDeps
): Promise<{
  owner: (LlmRoute & { name: string }) | null;
  others: { id: string; name: string; settled: Promise<Settled> }[];
  /** Servers left out for want of a credential, with how to log in. */
  skipped: { id: string; name: string; error: string }[];
  warnings: string[];
}> {
  const wanted = defaultOnServer(config.defaultModel);
  const all = (opts.servers ?? 'all') === 'all';
  if (!all && !wanted) return { owner: null, others: [], skipped: [], warnings: [] };
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

  const othersMs = opts.listingTimeoutMs ?? SAVED_OLLAMA_LISTING_TIMEOUT_MS;
  const candidates = (all ? loaded.servers : []).filter(server => server !== owner);
  const locked = (server: CliModelServer) =>
    needsCredential(server, config.modelServerCredentials?.[server.id]?.secret);
  const skipped = candidates.filter(locked).map(server => ({
    id: server.id,
    name: clean(server.name),
    error: `${clean(server.name)} needs credentials. Run: ${loginHint(server)}`,
  }));
  const others = candidates
    .filter(server => !locked(server))
    .map(server => ({
      id: server.id,
      name: clean(server.name),
      settled: settle(attachServer(server, config, opts, deps, othersMs)),
    }));
  if (!owner || !wanted) return { owner: null, others, skipped, warnings };

  const name = clean(owner.name);
  const result = await settle(
    attachServer(owner, config, opts, deps, opts.defaultServerTimeoutMs ?? DEFAULT_SERVER_TIMEOUT_MS)
  );
  if (!result.route) throw defaultUnusable(wanted.model, owner.name, result.error);
  if (!result.route.models.some(model => model.id === config.defaultModel)) {
    throw defaultUnusable(wanted.model, owner.name, `${name} does not serve it. See: b4m models ls --server ${name}`);
  }
  return { owner: { ...result.route, name }, others, skipped, warnings };
}

/** `host` is an Ollama that was configured or found running; `error` is why listing its models failed. */
export function noLocalModelsReason(host: string | null, error: string | undefined): string {
  if (host && error !== undefined) {
    return `No local model found: Ollama at ${clean(host)} is not answering (${clean(error)}). Start it (open the Ollama app or run "ollama serve").`;
  }
  if (host) return `No local model found: Ollama at ${clean(host)} has no models. Pull one with: ollama pull qwen3.5`;
  return `No local model found. ${INSTALL_OLLAMA_HINT}`;
}

/** The detected Ollama's base URL; null when detection is off, finds nothing, fails, or misses its deadline. */
async function detectOllamaHost(opts: AttachLocalModelsOptions): Promise<string | null> {
  if (!opts.detectOllama) return null;
  const abort = new AbortController();
  try {
    return await withDeadline(opts.detectOllama(abort.signal), opts.detectTimeoutMs ?? OLLAMA_DETECT_TIMEOUT_MS, abort);
  } catch (error: unknown) {
    logger.debug(`No local Ollama detected: ${extractErrorMessage(error)}`);
    return null;
  }
}

/**
 * Wraps the server backend with Ollama (when a host is given, set in B4M_OLLAMA_HOST, or saved by `b4m models`, or
 * else when `opts.detectOllama` finds one) and with Desktop's saved model servers, and lists the models of all of
 * them. Shared by interactive and headless (`-p`) startup.
 */
export async function attachLocalModels(
  llm: CliLlmBackend,
  config: CliConfig,
  opts: AttachLocalModelsOptions,
  deps: LocalModelsDeps
): Promise<LocalModelsAttachment> {
  const explicit = opts.ollamaHost ?? (process.env.B4M_OLLAMA_HOST || undefined);
  const rawHost = explicit ?? config.ollamaHost;
  // A down Ollama must not block startup on the server models. A saved host may be a machine that is
  // gone, so its listing also gets a deadline; a host passed for this run is waited on.
  const ollamaAttach = (async () => {
    const detected = rawHost ? null : await detectOllamaHost(opts);
    const host = rawHost ? withDefaultOllamaPort(rawHost) : detected;
    const deadlineMs = explicit
      ? undefined
      : detected
        ? (opts.detectedListingTimeoutMs ?? DETECTED_OLLAMA_LISTING_TIMEOUT_MS)
        : (opts.listingTimeoutMs ?? SAVED_OLLAMA_LISTING_TIMEOUT_MS);
    const runtimeId = host ? desktopRuntimeIdForHost(host) : null;
    const requestSettings = runtimeId ? desktopRequestSettings(runtimeId) : undefined;
    const backend = host
      ? requestSettings
        ? deps.createOllamaBackend(host, { requestSettings })
        : deps.createOllamaBackend(host)
      : null;
    const listing: { models: ModelInfo[]; error?: string } = backend
      ? await withDeadline(backend.getModelInfo(), deadlineMs).then(
          listed => ({ models: listed }),
          (error: unknown) => {
            const message = extractErrorMessage(error);
            if (detected) logger.debug(`Error fetching model info from Ollama: ${message}`);
            else logger.warn(`Error fetching model info from Ollama: ${message}`);
            return { models: [] as ModelInfo[], error: message };
          }
        )
      : { models: [] };
    // An Ollama the user never configured is attached only when it has models to offer; it never warns.
    if (detected && (listing.error !== undefined || listing.models.length === 0)) {
      logger.debug(`Detected Ollama at ${detected} not attached: ${listing.error ?? 'no models pulled'}`);
      const emptyHost = listing.error === undefined ? detected : null;
      return { host: null, backend: null, models: [] as ModelInfo[], detected: false, emptyHost, error: undefined };
    }
    return { host, backend, detected: detected !== null, emptyHost: null, ...listing };
  })();
  const [serverModels, ollama, servers] = await Promise.all([
    llm.getModelInfo(),
    ollamaAttach,
    attachServers(config, opts, deps),
  ]);
  // A detected host never shadows a server model that shares an id; a configured host still does.
  const serverIds = new Set(serverModels.map(m => m.id));
  const ollamaModels = ollama.detected ? ollama.models.filter(m => !serverIds.has(m.id)) : ollama.models;
  const dropDetected = ollama.detected && ollamaModels.length === 0;
  const ollamaHost = dropDetected ? null : ollama.host;
  const ollamaBackend = dropDetected ? null : ollama.backend;

  // Signed out there is no server to chat with meanwhile, so the other saved servers (each under its own
  // deadline) are waited for before deciding nothing local can chat.
  let others = servers.others;
  const joined: (LlmRoute & { name: string })[] = [];
  const serverFailures = new Map(servers.skipped.map(({ id, name, error }) => [id, { name, error }]));
  if (opts.signedOut && ollamaModels.length === 0 && !servers.owner && others.length > 0) {
    for (const { id, name, settled } of others) {
      const result = await settled;
      if (result.route) joined.push({ ...result.route, name });
      else {
        serverFailures.set(id, { name, error: result.error });
        logger.debug(`Model server ${name} skipped: ${result.error}`);
      }
    }
    others = [];
  }

  if (opts.signedOut && ollamaModels.length === 0 && !servers.owner && !joined.some(r => r.models.length > 0)) {
    throw new NoLocalModelsError(
      savedLocalDefaultDownMessage(config, serverFailures) ??
        noLocalModelsReason(ollamaHost ?? ollama.emptyHost, ollama.error)
    );
  }

  if (serverModels.length === 0 && ollamaModels.length === 0 && !servers.owner && joined.length === 0) {
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

  const listedServers = [...(servers.owner ? [servers.owner] : []), ...joined];
  const routes: LlmRoute[] = [
    ...(ollamaBackend ? [{ backend: ollamaBackend, models: ollamaModels }] : []),
    ...listedServers,
  ];
  const summary = {
    ollamaHost,
    ollamaModelCount: ollamaModels.length,
    ollamaModelIds: ollamaModels.map(m => m.id),
    ollamaListingFailed: ollama.error !== undefined,
    ollamaDetected: ollama.detected,
    servers: listedServers.map(server => ({ name: server.name, modelCount: server.models.length })),
    serverFailures,
    warnings,
  };
  if (routes.length === 0 && others.length === 0) {
    return { llm, models: serverModels, ...summary, later: Promise.resolve() };
  }
  const multi = deps.createMultiBackend(llm, serverModels, routes, config.defaultModel);
  const later = Promise.all(
    others.map(({ id, name, settled }) =>
      settled.then(async result => {
        if (!result.route) {
          serverFailures.set(id, { name, error: result.error });
          logger.debug(`Model server ${name} skipped: ${result.error}`);
          return;
        }
        multi.addRoute(result.route);
        logger.debug(`Model server ${name}: ${result.route.models.length} model(s) added to picker`);
        opts.onModelsAdded?.(await multi.getModelInfo());
      })
    )
  ).then(
    () => undefined,
    (error: unknown) => logger.debug(`Adding a model server's models failed: ${extractErrorMessage(error)}`)
  );
  return { llm: multi, models: await multi.getModelInfo(), ...summary, later };
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
  const signedOut = apiClient.signedOut === true;

  let serverLlm: CliLlmBackend;
  let wsManager: WebSocketConnectionManager | null = null;
  if (signedOut) {
    deps.clearWebSocketToolExecutor();
    serverLlm = new SignedOutCloudBackend(config.defaultModel);
  } else {
    const sse = await createSseBackend(
      { apiClient, model: config.defaultModel, getSessionId },
      { createServerBackend: deps.createServerBackend, clearWebSocketToolExecutor: deps.clearWebSocketToolExecutor }
    );
    serverLlm = sse.llm;
    wsManager = await connectFeatureEventSocket(config, sse.serverConfig.websocketUrl, deps, {
      tokenGetter,
      verifySession: () => apiClient.checkSessionValid(),
    });
  }

  const attached = await attachLocalModels(
    serverLlm,
    config,
    {
      signedOut,
      ollamaHost: input.ollamaHost,
      listingTimeoutMs: input.ollamaListingTimeoutMs,
      detectOllama: input.detectOllama ? deps.detectOllama : undefined,
      detectTimeoutMs: input.ollamaDetectTimeoutMs,
      detectedListingTimeoutMs: input.ollamaDetectedListingTimeoutMs,
      servers: input.servers ?? 'all',
      onNotice: input.onNotice ?? (text => logger.warn(`\u26a0\ufe0f  ${text}`)),
      onModelsAdded: input.onModelsAdded,
    },
    deps
  );
  const { llm, later } = attached;
  const models = signedOut ? await withSignedOutLocalDefault(attached, config) : attached.models;
  startupLog.push(...attached.warnings);
  if (attached.ollamaHost) {
    startupLog.push(`\u{1f999} Self-hosted Ollama: ${attached.ollamaModelCount} model(s) added to picker`);
  }
  for (const server of attached.servers) {
    startupLog.push(`\u{1f5a5}\ufe0f  Model server ${server.name}: ${server.modelCount} model(s) added to picker`);
  }

  logger.debug(`📋 Available models: ${models.map(m => m.id).join(', ')}`);

  requireLocalDefaultListed(models, config.defaultModel);
  const savedLocalDefault =
    signedOut && !models.some(m => m.id === config.defaultModel)
      ? models.find(m => m.id === config.localDefaultModel)
      : undefined;
  const modelInfo = savedLocalDefault ?? resolveModelInfo(models, config.defaultModel);

  if (signedOut && modelInfo.id !== config.defaultModel) {
    const serverDown = savedLocalDefault ? null : savedLocalDefaultDownMessage(config, attached.serverFailures);
    if (serverDown) startupLog.push(serverDown);
    startupLog.push(signedOutDefaultReplacedMessage(config.defaultModel, modelInfo.id));
  }

  // Log model selection
  if (modelInfo.id !== config.defaultModel) {
    logger.warn(`⚠️  Requested model '${config.defaultModel}' not available`);
    logger.warn(`🤖 Using fallback model: ${modelInfo.id}`);
  }

  // Update LLM backend with selected model
  llm.currentModel = modelInfo.id;

  return {
    llm,
    wsManager,
    models,
    modelInfo,
    later,
    detectedOllama:
      attached.ollamaDetected && attached.ollamaHost
        ? { host: attached.ollamaHost, modelIds: new Set(attached.ollamaModelIds) }
        : null,
  };
}
