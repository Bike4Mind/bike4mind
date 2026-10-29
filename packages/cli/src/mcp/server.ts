import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { B4mApiClient } from './b4mApiClient.js';
import { registerTools } from './tools.js';
import { registerSolverTools } from './solverTools.js';
import { localModelToolsDeps, registerModelTools, type ModelToolsDeps } from './modelTools.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import type { ConfigStore } from '../storage/ConfigStore.js';

export interface BuildServerOptions {
  baseURL: string;
  apiKey?: string;
  configStore?: ConfigStore;
  version: string;
}

/**
 * Build a fully-configured Bike4Mind MCP server: the tools, the four resource
 * templates (`b4m://notebook/{id}`, `b4m://file/{id}`, `b4m://project/{id}`,
 * `b4m://artifact/{id}`) backed by a {@link B4mApiClient} bound to the given
 * endpoint and credentials, the credential-free `b4m://agent-quest` manifest, and
 * the Briefcase prompt catalog as MCP prompts. Tool listing never touches the
 * network - only tool/resource *calls* and prompt listing/gets hit the API - so a
 * server built with an unreachable endpoint still advertises its full capability set.
 */
export function buildMcpServer(
  options: BuildServerOptions,
  client = new B4mApiClient(options.baseURL, options.configStore, options.apiKey)
): McpServer {
  const server = new McpServer(
    { name: 'bike4mind', version: options.version },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  registerTools(server, client);
  registerResources(server, client);
  registerPrompts(server, client);

  return server;
}

/**
 * {@link buildMcpServer} plus the tools only an authenticated, entitled caller gets, which the server
 * reports at startup, and the local model tools. Stdio only: the HTTP transport trusts anything that
 * can reach its socket, so it uses the plain builder and never offers these.
 */
export async function buildStdioMcpServer(
  options: BuildServerOptions,
  modelTools: ModelToolsDeps = localModelToolsDeps(options.configStore)
): Promise<McpServer> {
  const client = new B4mApiClient(options.baseURL, options.configStore, options.apiKey);
  const server = buildMcpServer(options, client);
  await registerSolverTools(server, client);
  registerModelTools(server, modelTools);
  return server;
}

/**
 * `mcp serve --local`: only the local model tools, which need the model runtime and Hugging Face but
 * never a Bike4Mind backend, so it builds no API client. Stdio only, like {@link buildStdioMcpServer}.
 */
export function buildLocalMcpServer(
  options: Pick<BuildServerOptions, 'configStore' | 'version'>,
  modelTools: ModelToolsDeps = localModelToolsDeps(options.configStore)
): McpServer {
  const server = new McpServer({ name: 'bike4mind', version: options.version }, { capabilities: { tools: {} } });
  registerModelTools(server, modelTools);
  return server;
}
