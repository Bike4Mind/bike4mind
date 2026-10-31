import type { ModelInfo } from '@bike4mind/common';
import { OllamaBackend } from '@bike4mind/llm-adapters';
import { extractErrorMessage } from '@bike4mind/utils';
import type { CliConfig } from '../storage';
import type { ApiClient } from '../auth/ApiClient';
import { logger } from '../utils/Logger';
import { withDefaultOllamaPort } from '../utils/ollamaHost.js';
import { ServerLlmBackend } from '../llm/ServerLlmBackend';
import { WebSocketLlmBackend } from '../llm/WebSocketLlmBackend';
import { MultiLlmBackend } from '../llm/MultiLlmBackend.js';
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
}

export const SAVED_OLLAMA_LISTING_TIMEOUT_MS = 5_000;

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
  createOllamaBackend: (host: string) => OllamaBackend;
  createMultiBackend: (
    server: CliLlmBackend,
    ollama: OllamaBackend,
    serverModels: ModelInfo[],
    ollamaModels: ModelInfo[],
    defaultModel: string
  ) => CliLlmBackend;
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
  createOllamaBackend: host =>
    new OllamaBackend(host, {
      debug: (...args: unknown[]) => logger.debug(args.map(String).join(' ')),
      info: (...args: unknown[]) => logger.info(args.map(String).join(' ')),
      warn: (...args: unknown[]) => logger.warn(args.map(String).join(' ')),
      error: (...args: unknown[]) => logger.error(args.map(String).join(' ')),
    }),
  createMultiBackend: (server, ollama, serverModels, ollamaModels, defaultModel) =>
    new MultiLlmBackend(server, ollama, serverModels, ollamaModels, defaultModel),
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

/** A saved `local:` default that is not listed is never swapped for another model, hosted or not. */
export function requireLocalDefaultListed(models: ModelInfo[], defaultModel: string): void {
  if (!defaultModel.startsWith('local:') || models.some(m => m.id === defaultModel)) return;
  throw new Error(
    `Model "${defaultModel}" is on a local model server the CLI cannot chat with yet, so it was not replaced by another model. ` +
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
  ollama: Pick<OllamaAttachment, 'ollamaHost' | 'ollamaListingFailed'>
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

export interface OllamaAttachment {
  llm: CliLlmBackend;
  models: ModelInfo[];
  /** The Ollama host in use, or null when none is configured. */
  ollamaHost: string | null;
  ollamaModelCount: number;
  /** Ollama's model listing failed or timed out, so its models are unknown. */
  ollamaListingFailed: boolean;
  warnings: string[];
}

/**
 * Wraps the server backend with Ollama when a host is given, set in B4M_OLLAMA_HOST, or saved by `b4m models`,
 * and lists the models of both. Shared by interactive and headless (`-p`) startup.
 */
export async function attachOllama(
  llm: CliLlmBackend,
  config: CliConfig,
  opts: { ollamaHost?: string; listingTimeoutMs?: number },
  deps: Pick<BuildLlmBackendDeps, 'createOllamaBackend' | 'createMultiBackend'>
): Promise<OllamaAttachment> {
  const explicit = opts.ollamaHost ?? (process.env.B4M_OLLAMA_HOST || undefined);
  const rawHost = explicit ?? config.ollamaHost;
  if (!rawHost) {
    const models = await llm.getModelInfo();
    if (models.length === 0) throw new Error('No models available from server.');
    return { llm, models, ollamaHost: null, ollamaModelCount: 0, ollamaListingFailed: false, warnings: [] };
  }

  const ollamaHost = withDefaultOllamaPort(rawHost);
  const ollamaBackend = deps.createOllamaBackend(ollamaHost);
  // A down Ollama must not block startup on the server models. A saved host may be a machine that is
  // gone, so its listing also gets a deadline; a host passed for this run is waited on.
  const listing = ollamaBackend.getModelInfo();
  const deadlineMs = explicit ? undefined : (opts.listingTimeoutMs ?? SAVED_OLLAMA_LISTING_TIMEOUT_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded =
    deadlineMs === undefined
      ? listing
      : Promise.race([
          listing,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`no answer within ${deadlineMs / 1000}s`)), deadlineMs);
            timer.unref?.();
          }),
        ]);
  const ollamaListing = bounded.then(
    (listed): { models: ModelInfo[]; error?: string } => ({ models: listed }),
    (error: unknown) => {
      const message = extractErrorMessage(error);
      logger.warn(`Error fetching model info from Ollama: ${message}`);
      return { models: [] as ModelInfo[], error: message };
    }
  );
  const [serverModels, ollama] = await Promise.all([llm.getModelInfo(), ollamaListing]).finally(() =>
    clearTimeout(timer)
  );
  const ollamaModels = ollama.models;

  if (serverModels.length === 0 && ollamaModels.length === 0) {
    throw new Error(
      ollama.error !== undefined
        ? `No models available from server, and Ollama at ${ollamaHost} is unreachable: ${ollama.error}`
        : `No models available from server or Ollama at ${ollamaHost}.\n` + `Pull a model: ollama pull qwen3.5`
    );
  }
  const warnings: string[] = [];
  if (ollama.error !== undefined) {
    warnings.push(`\u26a0\ufe0f  Ollama at ${ollamaHost} is unreachable: ${ollama.error}`);
  } else if (ollamaModels.length === 0) {
    warnings.push(`\u26a0\ufe0f  No models found in Ollama at ${ollamaHost}. Pull one with: ollama pull qwen3.5`);
  }

  const multi = deps.createMultiBackend(llm, ollamaBackend, serverModels, ollamaModels, config.defaultModel);
  return {
    llm: multi,
    models: await multi.getModelInfo(),
    ollamaHost,
    ollamaModelCount: ollamaModels.length,
    ollamaListingFailed: ollama.error !== undefined,
    warnings,
  };
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

  const attached = await attachOllama(
    sse.llm,
    config,
    { ollamaHost: input.ollamaHost, listingTimeoutMs: input.ollamaListingTimeoutMs },
    deps
  );
  const { llm, models } = attached;
  startupLog.push(...attached.warnings);
  if (attached.ollamaHost) {
    startupLog.push(`\u{1f999} Self-hosted Ollama: ${attached.ollamaModelCount} model(s) added to picker`);
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
