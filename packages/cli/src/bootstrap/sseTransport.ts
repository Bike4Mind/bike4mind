import type { ApiClient } from '../auth/ApiClient';
import { logger } from '../utils/Logger';
import { ServerLlmBackend } from '../llm/ServerLlmBackend';
import { setWebSocketToolExecutor } from '../llm/ToolRouter';

/** The transport fields the CLI reads from `/api/settings/serverConfig`. */
export interface ServerTransportConfig {
  /** Absolute SSE completions endpoint; empty -> backend uses same-origin default. */
  sseCompletionsUrl?: string;
  /** Realtime relay url, used for feature-module events only (never completions). */
  websocketUrl?: string;
}

/**
 * `T` lets a caller with a wider backend union (buildLlmBackend's CliLlmBackend)
 * reuse its own factory here without a cast; it defaults to the real class.
 */
export interface SseTransportDeps<T = ServerLlmBackend> {
  createServerBackend: (opts: ConstructorParameters<typeof ServerLlmBackend>[0]) => T;
  /** Clear the WS server-tool executor so tools resolve to the local CLI executor. */
  clearWebSocketToolExecutor: () => void;
}

export const defaultSseTransportDeps: SseTransportDeps = {
  createServerBackend: opts => new ServerLlmBackend(opts),
  clearWebSocketToolExecutor: () => setWebSocketToolExecutor(null),
};

/**
 * Build the HTTP+SSE completion backend, the CLI's only completion transport.
 *
 * Shared by interactive bootstrap (`buildLlmBackend`) and headless (`-p`) runs so
 * both read the same server config, clear the same tool-executor singleton, and
 * construct the backend identically - headless previously duplicated this inline
 * and no test covered it.
 *
 * A failed serverConfig fetch is non-fatal: the backend falls back to its default
 * same-origin `/api/ai/v1/completions` path. The returned `serverConfig` is also
 * how callers learn the realtime `websocketUrl` for non-completion features.
 */
export async function createSseBackend<T = ServerLlmBackend>(
  input: { apiClient: ApiClient; model: string },
  deps: SseTransportDeps<T> = defaultSseTransportDeps as SseTransportDeps<T>
): Promise<{ llm: T; serverConfig: ServerTransportConfig }> {
  let serverConfig: ServerTransportConfig = {};
  try {
    serverConfig = (await input.apiClient.get<ServerTransportConfig>('/api/settings/serverConfig')) ?? {};
  } catch (err) {
    logger.debug(
      `[SSE] serverConfig fetch failed; using default completions endpoint: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Completions never travel over the socket now, so any executor installed by a
  // previous build must go - otherwise tools would route to a dead relay.
  deps.clearWebSocketToolExecutor();

  const llm = deps.createServerBackend({
    apiClient: input.apiClient,
    model: input.model,
    sseCompletionsUrl: serverConfig.sseCompletionsUrl,
  });
  logger.debug('Using SSE transport');

  return { llm, serverConfig };
}
