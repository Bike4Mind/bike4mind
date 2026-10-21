import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import { SSEClientTransport, SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode, McpError, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { PinnedFetchError, createPinnedFetch } from '@bike4mind/fab-pipeline/ssrf';
import {
  RemoteMcpAuthFailedError,
  RemoteMcpAuthRequiredError,
  RemoteMcpError,
  RemoteMcpProtocolError,
  RemoteMcpSizeCapError,
  RemoteMcpSsrfBlockedError,
  RemoteMcpTimeoutError,
  RemoteMcpUpstreamError,
} from './errors';
import { validateRemoteMcpUrl } from './validateRemoteMcpUrl';

export type RemoteMcpTransportKind = 'streamable-http' | 'sse';

export interface RemoteMcpLimits {
  /** Connect plus initialize, ms. */
  connectTimeoutMs: number;
  /** One tools/call after initialize, ms. */
  callTimeoutMs: number;
  /** tools/list (all pages) after initialize, ms. */
  listToolsTimeoutMs: number;
  /** Decoded bytes per HTTP response. */
  maxBodyBytes: number;
  /** Redirects per operation, all same-origin. */
  maxRedirects: number;
  maxTools: number;
  /** Longer descriptions are truncated. */
  maxDescriptionChars: number;
  /** Serialized input schema bytes per tool; a larger tool is dropped. */
  maxToolSchemaBytes: number;
  /** Serialized input schema bytes across the list; tools past it are dropped. */
  maxTotalSchemaBytes: number;
}

export const DEFAULT_REMOTE_MCP_LIMITS: Readonly<RemoteMcpLimits> = Object.freeze({
  connectTimeoutMs: 10_000,
  callTimeoutMs: 60_000,
  listToolsTimeoutMs: 15_000,
  maxBodyBytes: 2 * 1024 * 1024,
  maxRedirects: 3,
  maxTools: 100,
  maxDescriptionChars: 1024,
  maxToolSchemaBytes: 16 * 1024,
  maxTotalSchemaBytes: 256 * 1024,
});

export interface RemoteMcpClientConfig {
  url: string;
  /** `auto` tries Streamable HTTP and falls back to legacy SSE on an initialize 400/404/405. */
  transport?: 'auto' | RemoteMcpTransportKind;
  /** Sent on every request, e.g. `Authorization`. Header-name policy is the caller's job. */
  headers?: Record<string, string>;
  limits?: Partial<RemoteMcpLimits>;
  /** Self-host opt-in only; see `PinnedFetchOptions.allowPrivateCidrs`. */
  allowPrivateCidrs?: string[];
  /** Self-host opt-in only. */
  allowHttp?: boolean;
  /** This deployment's own hosts, refused as targets. */
  ownHosts?: string[];
}

/**
 * TEST ONLY. Deliberately not part of `RemoteMcpClientConfig`, so no stored or deployed config can carry it,
 * and `createPinnedFetch` additionally refuses it outside vitest.
 *
 * @internal
 */
export interface RemoteMcpTestOnlyOptions {
  allowLoopback: true;
}

export interface RemoteMcpToolDescriptor {
  name: string;
  title?: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  annotations?: Tool['annotations'];
}

export interface RemoteMcpDroppedTool {
  name: string;
  reason: 'max_tools' | 'schema_too_large' | 'total_schema_too_large';
}

export interface RemoteMcpListToolsResult {
  tools: RemoteMcpToolDescriptor[];
  dropped: RemoteMcpDroppedTool[];
  serverInfo?: { name: string; version: string };
  protocolVersion?: string;
  detectedTransport: RemoteMcpTransportKind;
}

export interface RemoteMcpCallToolResult {
  result: CallToolResult;
  detectedTransport: RemoteMcpTransportKind;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FALLBACK_STATUSES = new Set([400, 404, 405]);
const MAX_LIST_PAGES = 20;
const SESSION_DELETE_TIMEOUT_MS = 2_000;
const CLIENT_INFO = { name: 'bike4mind-remote-mcp', version: '1.0.0' };

/** Per-operation state: one abort signal, and the first classified failure seen at the HTTP layer. */
class Operation {
  readonly controller = new AbortController();
  failure?: RemoteMcpError;
  authChallenge?: { resourceMetadataUrl?: string; scope?: string; wwwAuthenticate?: string };
  private rejectFailure?: (error: RemoteMcpError) => void;
  readonly failed = new Promise<never>((_, reject) => {
    this.rejectFailure = reject;
  });

  constructor() {
    // Only ever consumed through Promise.race; this keeps an unraced rejection from being reported.
    this.failed.catch(() => undefined);
  }

  fail(error: RemoteMcpError): void {
    if (this.failure) return;
    this.failure = error;
    this.rejectFailure?.(error);
    this.controller.abort(error);
  }
}

function fromPinnedFetchError(error: PinnedFetchError): RemoteMcpError {
  switch (error.code) {
    case 'ssrf_blocked':
    case 'scheme_blocked':
      return new RemoteMcpSsrfBlockedError(error.message, { cause: error });
    case 'size_cap':
      return new RemoteMcpSizeCapError(error.message, { cause: error });
    case 'timeout':
      return new RemoteMcpTimeoutError(error.message, { cause: error });
    case 'redirect_blocked':
    case 'too_many_redirects':
      return new RemoteMcpProtocolError(error.message, { cause: error });
  }
}

function findPinnedFetchError(error: unknown): PinnedFetchError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof PinnedFetchError) return current;
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

function httpStatusOf(error: unknown): number | undefined {
  if (error instanceof StreamableHTTPError || error instanceof SseError) {
    return typeof error.code === 'number' && error.code >= 100 ? error.code : undefined;
  }
  return undefined;
}

/**
 * A client for a user-supplied remote MCP server. Stateless per operation: every `listTools` or `callTool`
 * validates the URL, connects, initializes, does its one thing, terminates the session and closes.
 *
 * Kept separate from `MCPClient` because that class is a long-lived, stateful connection owned by trusted
 * callers (built-in stdio servers, the CLI); this one treats the server as hostile on every axis - network
 * target, response size, time, redirects, and what it claims about its tools.
 */
export class RemoteMcpClient {
  private readonly config: RemoteMcpClientConfig;
  private readonly limits: RemoteMcpLimits;
  private readonly testOnly?: RemoteMcpTestOnlyOptions;
  /** The transport the last successful connect used; reused by later operations on this instance. */
  detectedTransport?: RemoteMcpTransportKind;

  constructor(config: RemoteMcpClientConfig, testOnly?: RemoteMcpTestOnlyOptions) {
    this.config = config;
    this.limits = { ...DEFAULT_REMOTE_MCP_LIMITS, ...config.limits };
    this.testOnly = testOnly;
  }

  /** Lists the server's tools, applying the count, description and schema-size limits. */
  async listTools(): Promise<RemoteMcpListToolsResult> {
    return this.run(this.limits.listToolsTimeoutMs, async (client, transport) => {
      const raw: Tool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES && raw.length <= this.limits.maxTools; page++) {
        const result = await client.listTools(cursor ? { cursor } : undefined);
        raw.push(...result.tools);
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      const { tools, dropped } = this.applyToolLimits(raw);
      return {
        tools,
        dropped,
        serverInfo: client.getServerVersion(),
        protocolVersion: transport.protocolVersion,
        detectedTransport: transport.kind,
      };
    });
  }

  /** Calls one tool. A tool-level failure comes back as a result with `isError`, not as a throw. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<RemoteMcpCallToolResult> {
    return this.run(this.limits.callTimeoutMs, async (client, transport, signal) => {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        signal,
        timeout: this.limits.callTimeoutMs,
      });
      // `callTool` is typed as a union with the pre-2024 `toolResult` shape, which no current server sends.
      if (!('content' in result) || !Array.isArray(result.content)) {
        throw new RemoteMcpProtocolError('Tool result has no content array');
      }
      return { result: result as CallToolResult, detectedTransport: transport.kind };
    });
  }

  private applyToolLimits(raw: Tool[]): { tools: RemoteMcpToolDescriptor[]; dropped: RemoteMcpDroppedTool[] } {
    const tools: RemoteMcpToolDescriptor[] = [];
    const dropped: RemoteMcpDroppedTool[] = [];
    let totalSchemaBytes = 0;
    for (const tool of raw) {
      if (tools.length >= this.limits.maxTools) {
        dropped.push({ name: tool.name, reason: 'max_tools' });
        continue;
      }
      const schemaBytes = Buffer.byteLength(JSON.stringify(tool.inputSchema ?? {}), 'utf8');
      if (schemaBytes > this.limits.maxToolSchemaBytes) {
        dropped.push({ name: tool.name, reason: 'schema_too_large' });
        continue;
      }
      if (totalSchemaBytes + schemaBytes > this.limits.maxTotalSchemaBytes) {
        dropped.push({ name: tool.name, reason: 'total_schema_too_large' });
        continue;
      }
      totalSchemaBytes += schemaBytes;
      tools.push({
        name: tool.name,
        ...(tool.title !== undefined && { title: tool.title }),
        description: (tool.description ?? '').slice(0, this.limits.maxDescriptionChars),
        inputSchema: tool.inputSchema,
        ...(tool.annotations !== undefined && { annotations: tool.annotations }),
      });
    }
    return { tools, dropped };
  }

  private transportOrder(): RemoteMcpTransportKind[] {
    const configured = this.config.transport ?? 'auto';
    if (configured !== 'auto') return [configured];
    return this.detectedTransport ? [this.detectedTransport] : ['streamable-http', 'sse'];
  }

  private async run<T>(
    opTimeoutMs: number,
    body: (
      client: Client,
      transport: { kind: RemoteMcpTransportKind; protocolVersion?: string },
      signal: AbortSignal
    ) => Promise<T>
  ): Promise<T> {
    const url = validateRemoteMcpUrl(this.config.url, {
      allowHttp: this.config.allowHttp,
      allowPrivateCidrs: this.config.allowPrivateCidrs,
      ownHosts: this.config.ownHosts,
    });
    const op = new Operation();
    const pinned = createPinnedFetch({
      allowPrivateCidrs: this.config.allowPrivateCidrs,
      allowHttp: this.config.allowHttp,
      maxBodyBytes: this.limits.maxBodyBytes,
      timeoutMs: this.limits.connectTimeoutMs + opTimeoutMs,
      maxRedirects: this.limits.maxRedirects,
      sameOriginRedirectsOnly: true,
      onViolation: error => op.fail(fromPinnedFetchError(error)),
      testOnlyAllowLoopback: this.testOnly?.allowLoopback === true,
    });
    const fetchFn = this.instrumentFetch(pinned, op);

    try {
      const connecting = this.connect(url, fetchFn, op);
      let connected: Awaited<typeof connecting>;
      try {
        connected = await this.withDeadline(op, this.limits.connectTimeoutMs, 'connect', () => connecting);
      } catch (error) {
        // The connect can still settle after the deadline, and it may already hold a session the server
        // issued on initialize. Wait for it to settle and close it here, inside the `try`, so the session
        // DELETE (which travels through the same pinned fetch) is dispatched before the outer `finally`
        // closes the connection pool out from under it.
        await connecting.then(
          late => late.close(),
          () => undefined
        );
        throw this.classify(error, op);
      }
      try {
        const kind = connected.kind;
        return await this.withDeadline(op, opTimeoutMs, 'operation', () =>
          body(connected.client, { kind, protocolVersion: connected.protocolVersion() }, op.controller.signal)
        );
      } catch (error) {
        throw this.classify(error, op);
      } finally {
        await connected.close();
      }
    } finally {
      await pinned.close().catch(() => undefined);
    }
  }

  private instrumentFetch(pinned: FetchLike, op: Operation): FetchLike {
    let consecutiveRedirects = 0;
    return async (input, init) => {
      const isSessionDelete = init?.method?.toUpperCase() === 'DELETE';
      const signal = isSessionDelete
        ? AbortSignal.timeout(SESSION_DELETE_TIMEOUT_MS)
        : init?.signal
          ? AbortSignal.any([init.signal, op.controller.signal])
          : op.controller.signal;
      const response = await pinned(input, { ...init, signal });
      // The SDK follows same-origin redirects itself, hop by hop, up to 5; this holds a chain to the limit.
      if (REDIRECT_STATUSES.has(response.status) && response.headers.has('location')) {
        consecutiveRedirects += 1;
        if (consecutiveRedirects > this.limits.maxRedirects) {
          op.fail(new RemoteMcpProtocolError(`More than ${this.limits.maxRedirects} redirects`));
        }
      } else {
        consecutiveRedirects = 0;
      }
      if (response.status === 401 || response.status === 403) {
        const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
        op.authChallenge = {
          resourceMetadataUrl: resourceMetadataUrl?.href,
          scope,
          wwwAuthenticate: response.headers.get('www-authenticate') ?? undefined,
        };
      }
      return response;
    };
  }

  private async connect(
    url: URL,
    fetchFn: FetchLike,
    op: Operation
  ): Promise<{
    client: Client;
    kind: RemoteMcpTransportKind;
    protocolVersion: () => string | undefined;
    close: () => Promise<void>;
  }> {
    const order = this.transportOrder();
    let lastError: unknown;
    for (const kind of order) {
      // Empty capabilities: no sampling, roots or elicitation, so the server cannot drive the model.
      const client = new Client(CLIENT_INFO, { capabilities: {} });
      const requestInit: RequestInit | undefined = this.config.headers ? { headers: this.config.headers } : undefined;
      const transport =
        kind === 'streamable-http'
          ? new StreamableHTTPClientTransport(url, {
              fetch: fetchFn,
              redirectPolicy: 'same-origin',
              requestInit,
              reconnectionOptions: {
                initialReconnectionDelay: 1000,
                maxReconnectionDelay: 1000,
                reconnectionDelayGrowFactor: 1,
                maxRetries: 0,
              },
            })
          : new SSEClientTransport(url, { fetch: fetchFn, redirectPolicy: 'same-origin', requestInit });

      const close = async (): Promise<void> => {
        if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
          const deadline = AbortSignal.timeout(SESSION_DELETE_TIMEOUT_MS);
          await Promise.race([
            transport.terminateSession().catch(() => undefined),
            new Promise(resolve => deadline.addEventListener('abort', resolve, { once: true })),
          ]);
        }
        await client.close().catch(() => undefined);
      };

      try {
        await client.connect(transport, { signal: op.controller.signal, timeout: this.limits.connectTimeoutMs });
        this.detectedTransport = kind;
        return {
          client,
          kind,
          protocolVersion: () =>
            transport instanceof StreamableHTTPClientTransport ? transport.protocolVersion : undefined,
          close,
        };
      } catch (error) {
        await close();
        lastError = error;
        const status = httpStatusOf(error);
        const canFallBack = kind === 'streamable-http' && status !== undefined && FALLBACK_STATUSES.has(status);
        if (!canFallBack || op.failure) break;
      }
    }
    throw this.classify(lastError, op);
  }

  private async withDeadline<T>(
    op: Operation,
    timeoutMs: number,
    phase: 'connect' | 'operation',
    task: () => Promise<T>
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new RemoteMcpTimeoutError(`MCP ${phase} exceeded ${timeoutMs} ms`);
        op.fail(error);
        reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([task(), timedOut, op.failed]);
    } finally {
      clearTimeout(timer);
    }
  }

  private classify(error: unknown, op: Operation): RemoteMcpError {
    if (op.failure) return op.failure;
    if (error instanceof RemoteMcpError) return error;
    const pinnedError = findPinnedFetchError(error);
    if (pinnedError) return fromPinnedFetchError(pinnedError);

    const status = httpStatusOf(error);
    if (status === 401) return new RemoteMcpAuthRequiredError(op.authChallenge ?? {});
    if (status === 403)
      return new RemoteMcpAuthFailedError('The MCP server refused the credentials', op.authChallenge?.scope);
    if (status !== undefined && status >= 500) return new RemoteMcpUpstreamError(status, { cause: error });
    if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
      return new RemoteMcpTimeoutError('The MCP server did not answer in time', { cause: error });
    }
    const message = error instanceof Error ? error.message : 'Unknown MCP failure';
    return new RemoteMcpProtocolError(message, { cause: error });
  }
}
