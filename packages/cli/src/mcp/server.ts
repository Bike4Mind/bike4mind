import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { B4mApiClient } from './b4mApiClient.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import type { ConfigStore } from '../storage/ConfigStore.js';

export interface BuildServerOptions {
  baseURL: string;
  apiKey?: string;
  configStore?: ConfigStore;
  version: string;
}

/**
 * Build a fully-configured Bike4Mind MCP server: the 7 tools plus the four
 * resource templates (`b4m://notebook/{id}`, `b4m://file/{id}`,
 * `b4m://project/{id}`, `b4m://artifact/{id}`), backed by a {@link B4mApiClient}
 * bound to the given endpoint and credentials. Tool listing never touches the
 * network - only tool/resource *calls* hit the API - so a server built with an
 * unreachable endpoint still advertises its full capability set.
 */
export function buildMcpServer(options: BuildServerOptions): McpServer {
  const client = new B4mApiClient(options.baseURL, options.configStore, options.apiKey);

  const server = new McpServer(
    { name: 'bike4mind', version: options.version },
    { capabilities: { tools: {}, resources: {} } }
  );

  registerTools(server, client);
  registerResources(server, client);

  return server;
}
