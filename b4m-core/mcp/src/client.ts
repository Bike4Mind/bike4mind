import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Readable } from 'stream';
import path from 'path';
import { existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { assertMcpServerStartable, buildMcpChildEnv } from './childEnv';

const createSdkClient = () => new Client({ name: 'mcp-client-cli', version: '1.0.0' });

/**
 * The server no longer knows our session. The MCP spec (streamable HTTP, Session Management) says a
 * 404 to a request carrying `Mcp-Session-Id` means the session has ended, and the client MUST start a
 * new one with a fresh InitializeRequest. Servers expire idle sessions, so this is routine, not fatal.
 */
const isSessionExpired = (error: unknown): boolean => error instanceof StreamableHTTPError && error.code === 404;

export class MCPClient {
  private mcp: Client;
  // Either a stdio transport (spawned child process) or a streamable-HTTP transport.
  private transport: Transport | null = null;
  private envVariables: { key: string; value: string }[];
  private customCommand?: string;
  private customArgs?: string[];
  private suppressStderr: boolean;
  private onStderrLine?: (line: string) => void;
  // HTTP transport config (when set, connectToServer uses StreamableHTTPClientTransport
  // instead of spawning a stdio child process).
  private url?: string;
  private headers?: Record<string, string>;
  /** In flight while an expired HTTP session is being replaced; see renewHttpSession. */
  private renewing?: Promise<void>;
  /** The last renewal failed (e.g. the server was down), so the next call tries again first. */
  private renewFailed = false;
  /** Tool calls still waiting on each SDK client, so a replaced client is closed only once they settle. */
  private inFlight = new Map<Client, number>();
  /** Replaced clients that still had calls in flight; closed when their last call settles. */
  private retired = new Set<Client>();
  private disconnected = false;
  // Disconnect invalidates pending continuations even if connectToServer is called again.
  private connectionVersion = 0;
  public tools: Tool[] = [];
  public serverName: string;

  constructor({
    envVariables,
    name,
    command,
    args,
    suppressStderr = false,
    onStderrLine,
    url,
    headers,
  }: {
    envVariables: { key: string; value: string }[];
    name: string;
    command?: string;
    args?: string[];
    suppressStderr?: boolean;
    /** Callback for each line of stderr from the MCP server child process */
    onStderrLine?: (line: string) => void;
    /** When set, connect over streamable-HTTP to this URL instead of spawning a stdio child. */
    url?: string;
    /** HTTP headers (e.g. Authorization: Bearer <token>) sent on every request to `url`. */
    headers?: Record<string, string>;
  }) {
    this.mcp = createSdkClient();
    // Clone envVariables to avoid mutating caller's array
    this.envVariables = [...envVariables];
    this.serverName = name;
    // Store custom command and args for external MCP servers (e.g., Docker)
    this.customCommand = command;
    this.customArgs = args;
    this.suppressStderr = suppressStderr;
    this.onStderrLine = onStderrLine;
    this.url = url;
    this.headers = headers;
  }

  async connectToServer() {
    this.disconnected = false;
    try {
      // Streamable-HTTP transport: connect to a remote MCP endpoint over HTTP
      // (auth via headers). Skips the stdio child-process spawn entirely.
      if (this.url) {
        await this.connectHttp(this.url, this.mcp);
        return;
      }

      let command: string;
      let args: string[];
      const customCommand = this.customCommand?.trim() ? this.customCommand : undefined;

      // Check if custom command is provided (for external MCP servers like Docker)
      if (customCommand) {
        // Use external command (e.g., docker run)
        command = customCommand;
        args = this.customArgs ?? [];
        // Silently use external command - no console output during startup
      } else {
        assertMcpServerStartable(this.serverName, this.envVariables);

        // Resolve server script relative to this module - both this file and the
        // server scripts live in the same dist/ directory after building:
        //   dist/index.mjs        (this module)
        //   dist/github/index.mjs (server script)
        // Using import.meta.url makes this work regardless of working directory,
        // Lambda environment, or deployment structure.
        const moduleDir = path.dirname(fileURLToPath(import.meta.url));
        const serverScriptPath = path.join(moduleDir, this.serverName, 'index.mjs');

        if (!existsSync(serverScriptPath)) {
          const availableFiles = readdirSync(moduleDir, { withFileTypes: true }).map(d =>
            d.isDirectory() ? `${d.name}/` : d.name
          );

          console.error(`[MCP] Server script not found at: ${serverScriptPath}`);
          console.error(`[MCP] Module directory: ${moduleDir}`);
          console.error(`[MCP] Available in module dir:`, availableFiles);

          throw new Error(
            `MCP Server script not found for ${this.serverName} at ${serverScriptPath}. Module dir: ${moduleDir}`
          );
        }

        command = process.execPath;
        args = [serverScriptPath];
        console.log(`[MCP] Using server: ${this.serverName} at ${serverScriptPath}`);
      }

      // Determine stderr mode:
      // - 'ignore': suppress all stderr (CLI context)
      // - 'pipe': capture stderr for parsing (rate limit events, etc.)
      // - undefined: inherit to parent (default - shows in terminal)
      const stderrMode = this.suppressStderr ? ('ignore' as const) : this.onStderrLine ? ('pipe' as const) : undefined;

      // Built from an allowlist rather than inherited: this process holds platform credentials,
      // and the child is a Node runtime that would honour a stored NODE_OPTIONS. See childEnv.ts.
      const { env, droppedKeys } = buildMcpChildEnv({
        serverName: this.serverName,
        envVariables: this.envVariables,
        hasCustomCommand: Boolean(customCommand),
      });
      if (droppedKeys.length > 0) {
        // Key names only - the values are the user's provider credentials.
        console.warn(
          `[MCP] Withheld ${droppedKeys.length} undeclared env variable(s) from ${this.serverName}: ${droppedKeys.join(', ')}`
        );
      }

      const transportConfig = {
        command,
        args,
        env,
        ...(stderrMode && { stderr: stderrMode }),
      };

      const stdioTransport = new StdioClientTransport(transportConfig);
      this.transport = stdioTransport;

      // Add error handler for transport issues to prevent unhandled rejections
      stdioTransport.onerror = error => {
        console.error(`[MCP] Transport error for ${this.serverName}:`, error);
      };

      // Before connect, not after: the SDK returns the PassThrough immediately for exactly this
      // reason. A server that writes its reason to stderr and exits during the handshake - a
      // missing API key, an unsupported runtime - is the case where those lines are the only
      // explanation there will be, and attaching afterwards loses them.
      // transport.stderr is typed as Stream but is a Readable when stderr='pipe'.
      if (this.onStderrLine && stdioTransport.stderr) {
        this.readStderr(stdioTransport.stderr as unknown as Readable);
      }

      await this.mcp.connect(stdioTransport);

      // Wait a bit for connection to stabilize
      await new Promise(resolve => setTimeout(resolve, 100));

      const toolsResult = await this.mcp.listTools();
      this.tools = toolsResult.tools.map(tool => {
        return {
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        };
      });
    } catch (e) {
      // Clean up transport on connection failure
      if (this.transport) {
        try {
          await this.transport.close();
        } catch {}
        this.transport = null;
      }
      throw e;
    }
  }

  /** `client` is passed in, not read from `this.mcp`, so a connect can never pick up a client a later renewal created. */
  private async connectHttp(url: string, client: Client) {
    const version = this.connectionVersion;
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: this.headers ? { headers: this.headers } : undefined,
    });
    let sessionExpired = false;
    transport.onerror = error => {
      // Once the session is gone (or this transport has been replaced) the SDK keeps retrying the idle
      // GET stream and reports each 404 and the final "Maximum reconnection attempts" here. None of
      // it needs the user: the next tool call starts a new session (see callTool).
      if (sessionExpired || transport !== this.transport) return;
      if (transport.sessionId && isSessionExpired(error)) {
        sessionExpired = true;
        return;
      }
      // One line, no stack: this prints into an interactive terminal.
      console.error(`[MCP] Transport error for ${this.serverName}: ${error.message}`);
    };
    this.transport = transport;
    await client.connect(transport);
    this.assertConnection(version);

    const toolsResult = await client.listTools();
    this.assertConnection(version);
    this.tools = toolsResult.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }

  /**
   * Replace an expired HTTP session with a new one: a fresh SDK client and transport, re-initialized,
   * tools re-listed. `expired` is the client the failing call used. A renewal already in flight is
   * shared, and a successful replacement is reused, so calls that fail together open one new session.
   * A failed replacement can be retried even when the expired call used an older client.
   */
  private renewHttpSession(expired: Client, version: number): Promise<void> {
    this.assertConnection(version);
    if (this.renewing) return this.renewing;
    if (this.mcp !== expired && !this.renewFailed) return Promise.resolve();
    const url = this.url as string;
    const client = createSdkClient();
    this.mcp = client;
    this.transport = null;
    this.retire(expired);
    this.renewing = (async () => {
      try {
        await this.connectHttp(url, client);
        this.renewFailed = false;
      } catch (e) {
        if (this.connectionVersion === version) {
          this.renewFailed = true;
          if (this.transport) {
            try {
              await this.transport.close();
            } catch {}
            this.transport = null;
          }
        }
        throw e;
      }
    })().finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }

  private assertConnection(version: number) {
    if (this.disconnected || this.connectionVersion !== version) {
      throw new Error(`MCP client for ${this.serverName} is disconnected.`);
    }
  }

  /**
   * Close a replaced client, but not under a call still waiting on it: closing would fail that call
   * with "Connection closed" although the server may already be running it. It settles on its own
   * (a result, or the server's own error) and the client is closed after the last one.
   * Close, not terminate: the server has already forgotten the session, so a DELETE would 404 too.
   */
  private retire(client: Client) {
    if (this.inFlight.get(client)) {
      this.retired.add(client);
      return;
    }
    client.close().catch(() => {});
  }

  private async callOn(client: Client, name: string, args: Record<string, unknown> | undefined) {
    this.inFlight.set(client, (this.inFlight.get(client) ?? 0) + 1);
    try {
      return await client.callTool({ name, arguments: args });
    } finally {
      const left = (this.inFlight.get(client) ?? 1) - 1;
      if (left > 0) {
        this.inFlight.set(client, left);
      } else {
        this.inFlight.delete(client);
        if (this.retired.delete(client)) client.close().catch(() => {});
      }
    }
  }

  /**
   * Read lines from the child process stderr stream and dispatch to the callback.
   * Uses Node.js stream events; errors are silently caught (stream closes on disconnect).
   */
  private readStderr(stream: Readable) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) this.onStderrLine?.(trimmed);
      }
    });
    stream.on('end', () => {
      if (buffer.trim()) this.onStderrLine?.(buffer.trim());
    });
    stream.on('error', () => {
      // Stream closed (e.g., process exited) - expected during disconnect
    });
  }

  /**
   * The pid of the stdio child, or null for an HTTP server and before `connectToServer`.
   *
   * Exposed so an embedding process can guarantee no child outlives it. `disconnect()` is the
   * polite path and is async; a host that must tear down synchronously (Electron's `will-quit`
   * handler cannot await) needs the pid to signal directly.
   */
  get childPid(): number | null {
    const transport = this.transport;
    return transport instanceof StdioClientTransport ? transport.pid : null;
  }

  async callTool(toolName: string, toolArgs: unknown) {
    try {
      const version = this.connectionVersion;
      this.assertConnection(version);
      const args = toolArgs && typeof toolArgs === 'object' ? (toolArgs as Record<string, unknown>) : undefined;
      await this.renewing;
      this.assertConnection(version);
      if (this.renewFailed) await this.renewHttpSession(this.mcp, version);
      this.assertConnection(version);
      const client = this.mcp;
      const sessionId = this.transport instanceof StreamableHTTPClientTransport ? this.transport.sessionId : undefined;
      try {
        return await this.callOn(client, toolName, args);
      } catch (error) {
        // Retried only on the spec's "session ended" answer: a 404 to a request that carried a session
        // id. The server rejects an unknown session before running anything, so that retry cannot run
        // the tool twice. Any other error - including a call cut off mid-flight - may have reached the
        // tool, so it is thrown, never retried. The retry itself is not retried.
        if (!sessionId || !isSessionExpired(error)) throw error;
        await this.renewHttpSession(client, version);
        this.assertConnection(version);
        return await this.callOn(this.mcp, toolName, args);
      }
    } catch (error) {
      // Check if this is a connection closed error
      const isConnectionError =
        error instanceof Error &&
        (error.message.includes('Connection closed') ||
          error.message.includes('-32000') ||
          error.message.includes('EPIPE'));

      if (isConnectionError) {
        console.error(`[MCP] Connection lost while calling tool ${toolName} on ${this.serverName}`);
        throw new Error(`MCP connection lost for ${this.serverName}. Please retry the operation.`);
      }

      throw error;
    }
  }

  async disconnect() {
    this.disconnected = true;
    this.connectionVersion++;
    this.renewFailed = false;
    try {
      // Only attempt to close if transport exists and is connected
      for (const client of this.retired) client.close().catch(() => {});
      this.retired.clear();
      if (this.transport) {
        await this.mcp.close();
      }
    } catch (error) {
      const isConnectionClosedError =
        error instanceof Error &&
        (error.message.includes('Connection closed') ||
          error.message.includes('-32000') ||
          error.message.includes('EPIPE') ||
          error.message.includes('ECONNRESET'));

      if (!isConnectionClosedError) {
        console.error('Error during MCP disconnect:', error);
        throw error;
      }
      // Silently ignore connection-closed errors as they're expected
    } finally {
      // Clean up the transport reference
      this.transport = null;
    }
  }
}
