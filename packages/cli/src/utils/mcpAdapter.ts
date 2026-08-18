import { createHash } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { MCPClient } from '@bike4mind/mcp';
import { generateMcpTools, generateMcpToolsFromCache } from '@bike4mind/services/llm/tools/cliTools';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { CliConfig } from '../storage/types';
import { logger } from './Logger';

// ─── Cache types ──────────────────────────────────────────────────────────────

interface McpServerCacheEntry {
  configHash: string;
  tools: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>;
  cachedAt: string;
}

interface McpSchemaCache {
  version: number;
  servers: Record<string, McpServerCacheEntry>;
}

const CACHE_VERSION = 1;
const CACHE_FILE = join(homedir(), '.bike4mind', 'mcp-schema-cache.json');

// ─── Server instance ──────────────────────────────────────────────────────────

interface McpServerInstance {
  name: string;
  /** null while a background connection is still in progress */
  client: MCPClient | null;
  tools: Array<{ name: string } & ICompletionOptionTools>;
}

// ─── McpManager ───────────────────────────────────────────────────────────────

/**
 * Manages MCP servers for the CLI.
 *
 * On subsequent startups, servers whose config hasn't changed are loaded
 * from the on-disk schema cache and tool stubs are available instantly.
 * The real server processes are spawned in the background; any tool call
 * that arrives before a connection is ready waits for it.
 *
 * On the first run (no cache) or when a server config changes, the server
 * is connected eagerly.
 *
 * Cache freshness: there is intentionally no TTL. The background connection
 * always refreshes the cache after connecting, so schemas stay current across
 * restarts. A TTL would degrade to eager-connect on expiry, defeating the
 * performance goal for users with stable configs.
 */
export class McpManager {
  private servers: Map<string, McpServerInstance> = new Map();
  private connectionStates: Map<string, 'connecting' | 'connected' | 'failed'> = new Map();
  /** Per-server deferred promise resolved once the background connection is ready */
  private connectionReady: Map<
    string,
    { resolve: () => void; reject: (err: unknown) => void; promise: Promise<void> }
  > = new Map();
  private config: CliConfig;
  /**
   * Fired whenever a background connection state changes (connected or failed).
   * Single-subscriber contract: only one callback is active at a time.
   * McpViewer is the sole consumer and clears the callback on unmount.
   */
  private onStateChange?: () => void;
  /**
   * Serializes background cache saves so concurrent writes don't race.
   * JSON.stringify is evaluated at run-time, always capturing the latest cache state.
   */
  private backgroundSaveQueue: Promise<void> = Promise.resolve();

  constructor(config: CliConfig) {
    this.config = config;
  }

  /** Subscribe to background connection state changes for live UI updates. */
  setOnStateChange(callback: () => void): void {
    this.onStateChange = callback;
  }

  /**
   * Initialize MCP servers with schema caching.
   *
   * - Cache hit  -> tools registered immediately from cache; server connected in background
   * - Cache miss -> server connected eagerly (blocks); result cached for next run
   */
  async initialize(): Promise<void> {
    const enabledServers = this.config.mcpServers.filter(s => s.enabled);

    if (enabledServers.length === 0) {
      logger.debug('📡 No MCP servers enabled');
      return;
    }

    logger.debug(`📡 Initializing ${enabledServers.length} MCP server(s)...`);

    const cache = await this.loadCache();

    // Prune cache entries for servers that are no longer in config.
    const configuredNames = new Set(this.config.mcpServers.map(s => s.name));
    let pruned = false;
    for (const name of Object.keys(cache.servers)) {
      if (!configuredNames.has(name)) {
        delete cache.servers[name];
        pruned = true;
      }
    }

    const eagerConnections: Promise<void>[] = [];

    for (const serverConfig of enabledServers) {
      const configHash = this.hashServerConfig(serverConfig);
      const cachedEntry = cache.servers[serverConfig.name];

      if (cachedEntry && cachedEntry.configHash === configHash) {
        // Cache hit: register stubs immediately, connect in background.
        this.registerFromCache(serverConfig, cachedEntry);
        this.connectBackground(serverConfig, cache);
      } else {
        // Cache miss: connect eagerly, then cache for next time.
        eagerConnections.push(this.connectEager(serverConfig, cache));
      }
    }

    if (eagerConnections.length > 0) {
      await Promise.allSettled(eagerConnections);
      await this.saveCache(cache);
    } else if (pruned) {
      await this.saveCache(cache);
    }

    const connected = [...this.connectionStates.values()].filter(s => s === 'connected').length;
    const pending = [...this.connectionStates.values()].filter(s => s === 'connecting').length;
    if (connected > 0 || pending > 0) {
      logger.debug(`✅ ${connected} MCP server(s) ready${pending > 0 ? `, ${pending} connecting in background` : ''}`);
    }
  }

  // ─── Private: connection strategies ────────────────────────────────────────

  /**
   * Register tool stubs from cache immediately. callTool lazily awaits the
   * background connection before forwarding to the real client.
   */
  private registerFromCache(serverConfig: CliConfig['mcpServers'][0], entry: McpServerCacheEntry): void {
    this.connectionStates.set(serverConfig.name, 'connecting');

    let resolveReady!: () => void;
    let rejectReady!: (err: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    // Suppress unhandled rejection when the background connection fails but no
    // tool call is pending yet. Any active callTool await will receive the error.
    promise.catch(() => {});
    this.connectionReady.set(serverConfig.name, { resolve: resolveReady, reject: rejectReady, promise });

    const callTool = async (name: string, args: unknown): Promise<unknown> => {
      // Waits for background connection; re-throws the original connection error on failure.
      // If we reach this point after the await, client is guaranteed to be set - connectBackground
      // assigns instance.client before calling resolve(), so there's no null-client success path.
      await promise;
      return this.servers.get(serverConfig.name)!.client!.callTool(name, args);
    };

    const tools = generateMcpToolsFromCache(serverConfig.name, entry.tools, callTool);
    this.servers.set(serverConfig.name, { name: serverConfig.name, client: null, tools });
    logger.debug(`📋 ${entry.tools.length} tools for ${serverConfig.name} loaded from cache`);
  }

  /**
   * Spawn the server process in the background. Resolves the per-server
   * deferred promise when ready so pending callTool invocations can proceed.
   */
  private connectBackground(serverConfig: CliConfig['mcpServers'][0], cache: McpSchemaCache): void {
    this.doConnect(serverConfig)
      .then(({ client }) => {
        const instance = this.servers.get(serverConfig.name);
        if (instance) {
          // Set client before resolving so callTool sees a non-null client immediately.
          instance.client = client;
        }
        this.connectionStates.set(serverConfig.name, 'connected');
        this.connectionReady.get(serverConfig.name)?.resolve();
        this.onStateChange?.();
        logger.debug(`✅ Background connection to ${serverConfig.name} established`);
        // Refresh cache with latest schemas (serialized to prevent concurrent write races).
        this.writeCacheEntry(cache, serverConfig, client.tools);
        this.scheduleBackgroundSave(cache);
      })
      .catch(err => {
        this.connectionStates.set(serverConfig.name, 'failed');
        this.connectionReady.get(serverConfig.name)?.reject(err);
        this.onStateChange?.();
        logger.debug(`❌ Background connection to ${serverConfig.name} failed: ${err}`);
      });
  }

  /**
   * Connect eagerly (blocks initialize). Populates servers map and updates cache.
   */
  private async connectEager(serverConfig: CliConfig['mcpServers'][0], cache: McpSchemaCache): Promise<void> {
    this.connectionStates.set(serverConfig.name, 'connecting');
    logger.debug(`🔄 Connecting to ${serverConfig.name}...`);

    try {
      const { client, tools } = await this.doConnect(serverConfig);
      this.servers.set(serverConfig.name, { name: serverConfig.name, client, tools });
      this.connectionStates.set(serverConfig.name, 'connected');
      this.writeCacheEntry(cache, serverConfig, client.tools);
      logger.debug(`✅ Connected to ${serverConfig.name} (${tools.length} tools)`);
    } catch (error) {
      this.connectionStates.set(serverConfig.name, 'failed');
      logger.debug(`❌ Failed to connect to ${serverConfig.name}: ${error}`);
    }
  }

  /**
   * Shared: spawn and handshake with an MCP server process.
   */
  private async doConnect(serverConfig: CliConfig['mcpServers'][0]): Promise<{
    client: MCPClient;
    tools: Array<{ name: string } & ICompletionOptionTools>;
  }> {
    const envVariables = Object.entries(serverConfig.env).map(([key, value]) => ({ key, value }));

    const client = new MCPClient({
      envVariables,
      name: serverConfig.name,
      command: serverConfig.command,
      args: serverConfig.args,
      url: serverConfig.url,
      headers: serverConfig.headers,
      suppressStderr: true,
    });

    await client.connectToServer();

    const mcpData = {
      serverName: serverConfig.name,
      getTools: async () => client.tools,
      // any: generateMcpTools accepts a loose duck-type; MCPClient.callTool return type
      // doesn't match the internal interface exactly, but runtime behaviour is correct.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callTool: async (name: string, args: any) => client.callTool(name, args),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = await generateMcpTools(mcpData as any);
    return { client, tools };
  }

  // ─── Private: cache helpers ──────────────────────────────────────────────────

  private async loadCache(): Promise<McpSchemaCache> {
    try {
      const raw = await readFile(CACHE_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as McpSchemaCache;
      if (parsed.version === CACHE_VERSION) {
        return parsed;
      }
    } catch {
      // File doesn't exist or is malformed - start fresh.
    }
    return { version: CACHE_VERSION, servers: {} };
  }

  private async saveCache(cache: McpSchemaCache): Promise<void> {
    try {
      await mkdir(dirname(CACHE_FILE), { recursive: true });
      await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
    } catch (error) {
      logger.debug(`⚠️  Failed to save MCP schema cache: ${error}`);
    }
  }

  /**
   * Enqueue a background cache save. Saves are serialized so concurrent background
   * connections can't interleave writes and lose each other's entries. JSON.stringify
   * is evaluated when the queued write runs, so it always captures the latest state.
   */
  private scheduleBackgroundSave(cache: McpSchemaCache): void {
    this.backgroundSaveQueue = this.backgroundSaveQueue.then(() => this.saveCache(cache)).catch(() => {});
  }

  private writeCacheEntry(
    cache: McpSchemaCache,
    serverConfig: CliConfig['mcpServers'][0],
    rawTools: MCPClient['tools']
  ): void {
    cache.servers[serverConfig.name] = {
      configHash: this.hashServerConfig(serverConfig),
      tools: rawTools.map(t => {
        const tool = t as unknown as Record<string, unknown>;
        return {
          name: t.name,
          description: tool.description as string | undefined,
          // Normalize both MCP SDK casing variants to input_schema for storage
          input_schema: (tool.inputSchema ?? tool.input_schema) as Record<string, unknown> | undefined,
        };
      }),
      cachedAt: new Date().toISOString(),
    };
  }

  private hashServerConfig(serverConfig: CliConfig['mcpServers'][0]): string {
    const key = JSON.stringify({
      command: serverConfig.command,
      args: serverConfig.args,
      // Hash the HTTP endpoint but NOT headers - the Bearer token rotates every
      // launch; hashing it would force an eager reconnect each time, defeating the cache.
      url: serverConfig.url,
      env: serverConfig.env,
    });
    // 16 hex chars = 64 bits of entropy - intentional truncation, not a security context.
    return createHash('sha256').update(key).digest('hex').slice(0, 16);
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  getTools(): ICompletionOptionTools[] {
    const allTools: ICompletionOptionTools[] = [];
    for (const server of this.servers.values()) {
      allTools.push(...server.tools);
    }
    return allTools;
  }

  getToolCount(): { serverName: string; count: number }[] {
    return Array.from(this.servers.values()).map(server => ({
      serverName: server.name,
      count: server.tools.length,
    }));
  }

  async disconnect(): Promise<void> {
    if (this.servers.size === 0) return;

    logger.debug(`🔌 Disconnecting from ${this.servers.size} MCP server(s)...`);

    const disconnectPromises = Array.from(this.servers.values()).map(async server => {
      if (!server.client) return; // Background connection never completed
      try {
        await server.client.disconnect();
        logger.debug(`✅ Disconnected from ${server.name}`);
      } catch (error) {
        logger.error(`⚠️  Error disconnecting from ${server.name}:`, error);
      }
    });

    await Promise.allSettled(disconnectPromises);
    this.servers.clear();
    this.connectionReady.clear();
  }

  hasServers(): boolean {
    return this.servers.size > 0;
  }

  getServerNames(): string[] {
    return Array.from(this.servers.keys());
  }

  getConnectionState(serverName: string): 'connecting' | 'connected' | 'failed' | 'disabled' {
    const serverConfig = this.config.mcpServers.find(s => s.name === serverName);
    if (!serverConfig?.enabled) return 'disabled';
    return this.connectionStates.get(serverName) || 'connecting';
  }
}
