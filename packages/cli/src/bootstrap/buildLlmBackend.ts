import type { ModelInfo } from '@bike4mind/common';
import { OllamaBackend } from '@bike4mind/llm-adapters';
import type { CliConfig } from '../storage';
import type { ApiClient } from '../auth/ApiClient';
import { logger } from '../utils/Logger';
import { ServerLlmBackend } from '../llm/ServerLlmBackend';
import { WebSocketLlmBackend } from '../llm/WebSocketLlmBackend';
import { MultiLlmBackend } from '../llm/MultiLlmBackend.js';
import { setWebSocketToolExecutor } from '../llm/ToolRouter';
import { WebSocketConnectionManager } from '../ws/WebSocketConnectionManager';
import { WebSocketToolExecutor } from '../ws/WebSocketToolExecutor';
import { registerKeepHandlers } from './registerKeepHandlers.js';

/** The concrete backend types this builder can produce. */
export type CliLlmBackend = ServerLlmBackend | WebSocketLlmBackend | MultiLlmBackend;

export interface BuildLlmBackendInput {
  config: CliConfig;
  apiClient: ApiClient;
  /** Token getter for WebSocket auth (shared by WS manager and backend). */
  tokenGetter: () => Promise<string | null>;
  /** Startup log collected for the two-column banner; pushed into, not owned. */
  startupLog: string[];
  /** Ollama endpoint; defaults to process.env.B4M_OLLAMA_HOST. Injectable for tests. */
  ollamaHost?: string;
}

export interface BuildLlmBackendResult {
  llm: CliLlmBackend;
  /** WebSocket connection manager (null if using SSE fallback). */
  wsManager: WebSocketConnectionManager | null;
  models: ModelInfo[];
  /** The resolved default model (falls back to models[0] if requested model is unavailable). */
  modelInfo: ModelInfo;
}

/**
 * Side-effecting collaborators, injected so the transport-selection and
 * fallback control flow can be unit-tested with fakes (no real WebSocket,
 * SSE, or Ollama). Production callers omit this - `defaultLlmBackendDeps` is
 * used, which wires the real classes and the `setWebSocketToolExecutor`
 * singleton exactly as before.
 */
export interface BuildLlmBackendDeps {
  /**
   * Create + connect a WebSocket manager. Rejects if the socket can't connect.
   * `verifySession` is called when a connect ATTEMPT fails to open (a 401 handshake
   * refusal never fires onopen) - see WebSocketConnectionManager for why this is the only
   * way to tell "session revoked" apart from "transient network issue" on a WS close.
   */
  connectWebSocket: (
    wsUrl: string,
    tokenGetter: () => Promise<string | null>,
    verifySession: () => Promise<boolean>
  ) => Promise<WebSocketConnectionManager>;
  /** Install the server-tool executor for the connected socket (sets the ToolRouter singleton). */
  installWebSocketToolExecutor: (ws: WebSocketConnectionManager, tokenGetter: () => Promise<string | null>) => void;
  /** Clear the server-tool executor (used on SSE fallback). */
  clearWebSocketToolExecutor: () => void;
  createWebSocketBackend: (opts: ConstructorParameters<typeof WebSocketLlmBackend>[0]) => CliLlmBackend;
  createServerBackend: (opts: ConstructorParameters<typeof ServerLlmBackend>[0]) => CliLlmBackend;
  /** Register the Keep command handler on the connected socket. */
  registerKeepHandlers: (ws: WebSocketConnectionManager) => void;
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
  installWebSocketToolExecutor: (ws, tokenGetter) => {
    setWebSocketToolExecutor(new WebSocketToolExecutor(ws, tokenGetter));
  },
  clearWebSocketToolExecutor: () => setWebSocketToolExecutor(null),
  createWebSocketBackend: opts => new WebSocketLlmBackend(opts),
  createServerBackend: opts => new ServerLlmBackend(opts),
  registerKeepHandlers,
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
 * Resolve the model to use from the available list: the requested default if
 * present, otherwise the first available model. Pure - exported for testing.
 */
export function resolveModelInfo(models: ModelInfo[], defaultModel: string): ModelInfo {
  return models.find(m => m.id === defaultModel) || models[0];
}

/**
 * Build the LLM backend: WebSocket transport first (bypasses CloudFront 20s
 * timeout), SSE fallback, optional Ollama multiplexing. Resolves the default
 * model and pins it on the backend.
 *
 * Pure bootstrap seam: no React hooks, no Zustand state. The WS path registers
 * the Keep command handler inline (inside the same try-block) so a registration
 * throw still triggers the SSE fallback, exactly as before. The tool-executor
 * install/clear ordering (set on connect, cleared on fallback) is preserved.
 */
export async function buildLlmBackend(
  input: BuildLlmBackendInput,
  deps: BuildLlmBackendDeps = defaultLlmBackendDeps
): Promise<BuildLlmBackendResult> {
  const { config, apiClient, tokenGetter, startupLog } = input;

  // Try WebSocket transport first (bypasses CloudFront 20s timeout)
  // Falls back to SSE if WebSocket is unavailable
  let wsManager: WebSocketConnectionManager | null = null;
  let llm: CliLlmBackend;
  let sseCompletionsUrl: string | undefined;

  try {
    const serverConfig = await apiClient.get<{
      websocketUrl?: string;
      wsCompletionUrl?: string;
      sseCompletionsUrl?: string;
    }>('/api/settings/serverConfig');
    const wsUrl = serverConfig?.websocketUrl;
    const wsCompletionUrl = serverConfig?.wsCompletionUrl;
    sseCompletionsUrl = serverConfig?.sseCompletionsUrl;

    if (wsUrl && wsCompletionUrl) {
      wsManager = await deps.connectWebSocket(wsUrl, tokenGetter, () => apiClient.checkSessionValid());

      // Set up WebSocket tool executor for server-side tools
      deps.installWebSocketToolExecutor(wsManager, tokenGetter);

      llm = deps.createWebSocketBackend({
        wsManager,
        apiClient,
        model: config.defaultModel,
        tokenGetter,
        wsCompletionUrl,
      });

      // Register Keep command handler - allows the web HUD to execute
      // commands on this machine via the B4M cloud relay.
      deps.registerKeepHandlers(wsManager);

      logger.debug('🔌 Using WebSocket transport (bypasses CloudFront timeout)');
    } else {
      throw new Error('No websocketUrl or wsCompletionUrl in server config');
    }
  } catch (wsError) {
    // Fall back to SSE transport - clean one-liner for users, full stack in debug logs
    logger.debug('⚠️  WebSocket unavailable, using SSE fallback');
    logger.debug(`[WebSocket] Fallback reason: ${wsError instanceof Error ? wsError.message : String(wsError)}`);
    if (wsError instanceof Error && wsError.stack) {
      logger.debug(`[WebSocket] Stack: ${wsError.stack}`);
    }
    wsManager = null;
    deps.clearWebSocketToolExecutor();
    llm = deps.createServerBackend({
      apiClient,
      model: config.defaultModel,
      sseCompletionsUrl,
    });
  }

  // Optionally wrap with Ollama backend if --ollama-host was provided
  const ollamaHost = input.ollamaHost ?? process.env.B4M_OLLAMA_HOST;
  let models: ModelInfo[];

  if (ollamaHost) {
    const ollamaBackend = deps.createOllamaBackend(ollamaHost);
    const [serverModels, ollamaModels] = await Promise.all([llm.getModelInfo(), ollamaBackend.getModelInfo()]);

    if (serverModels.length === 0 && ollamaModels.length === 0) {
      throw new Error(
        `No models available from server or Ollama at ${ollamaHost}.\n` + `Pull a model: ollama pull qwen3.5`
      );
    }
    if (ollamaModels.length === 0) {
      startupLog.push(`⚠️  No models found in Ollama at ${ollamaHost}. Pull one with: ollama pull qwen3.5`);
    }

    const serverBackend = llm;
    llm = deps.createMultiBackend(serverBackend, ollamaBackend, serverModels, ollamaModels, config.defaultModel);
    models = await llm.getModelInfo();
    startupLog.push(`🦙 Self-hosted Ollama: ${ollamaModels.length} model(s) added to picker`);
  } else {
    models = await llm.getModelInfo();
    if (models.length === 0) {
      throw new Error('No models available from server.');
    }
  }

  logger.debug(`📋 Available models: ${models.map(m => m.id).join(', ')}`);

  // Get LLM for default model
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
