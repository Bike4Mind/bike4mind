import { Tool } from '@anthropic-ai/sdk/resources/messages';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Readable } from 'stream';
import path from 'path';
import { existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';

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
    this.mcp = new Client({ name: 'mcp-client-cli', version: '1.0.0' });
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
    try {
      // Streamable-HTTP transport: connect to a remote MCP endpoint over HTTP
      // (auth via headers). Skips the stdio child-process spawn entirely.
      if (this.url) {
        const transport = new StreamableHTTPClientTransport(new URL(this.url), {
          requestInit: this.headers ? { headers: this.headers } : undefined,
        });
        transport.onerror = error => {
          console.error(`[MCP] Transport error for ${this.serverName}:`, error);
        };
        this.transport = transport;
        await this.mcp.connect(transport);

        const toolsResult = await this.mcp.listTools();
        this.tools = toolsResult.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        }));
        return;
      }

      const envVarsObject = this.envVariables.reduce(
        (acc, env) => ({
          ...acc,
          [env.key]: env.value,
        }),
        {} as Record<string, string>
      );

      let command: string;
      let args: string[];

      // Check if custom command is provided (for external MCP servers like Docker)
      if (this.customCommand && this.customCommand.trim() !== '') {
        // Use external command (e.g., docker run)
        command = this.customCommand;
        args = this.customArgs ?? [];
        // Silently use external command - no console output during startup
      } else {
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

      const transportConfig = {
        command,
        args,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
          ),
          ...envVarsObject,
        },
        ...(stderrMode && { stderr: stderrMode }),
      };

      const stdioTransport = new StdioClientTransport(transportConfig);
      this.transport = stdioTransport;

      // Add error handler for transport issues to prevent unhandled rejections
      stdioTransport.onerror = error => {
        console.error(`[MCP] Transport error for ${this.serverName}:`, error);
      };

      await this.mcp.connect(stdioTransport);

      // Start reading stderr if callback provided and stream available.
      // transport.stderr is typed as Stream but is a Readable when stderr='pipe'.
      if (this.onStderrLine && stdioTransport.stderr) {
        this.readStderr(stdioTransport.stderr as unknown as Readable);
      }

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

  async callTool(toolName: string, toolArgs: unknown) {
    try {
      const args = toolArgs && typeof toolArgs === 'object' ? (toolArgs as Record<string, unknown>) : undefined;
      const result = await this.mcp.callTool({
        name: toolName,
        arguments: args,
      });
      return result;
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
    try {
      // Only attempt to close if transport exists and is connected
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
