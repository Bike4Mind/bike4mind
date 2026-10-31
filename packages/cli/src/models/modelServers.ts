/**
 * Model servers saved in Desktop (read-only) and the CLI's own copy of their credentials. Shared by
 * `b4m models` (src/commands/modelsCommand.ts) and the MCP model tools (src/mcp/modelTools.ts).
 */

import { OllamaRuntime, type LocalRuntime } from '@bike4mind/local-models';
import {
  OpenAICompatibleRuntime,
  createServerFetch,
  credentialHeaders,
  credentialRedactor,
  forbiddenMessage,
  parseLocalModelId,
  parseServerAddress,
  probeServer,
  readDesktopModelServers,
  redactServerResponse,
  serverManagement,
  serverRuntimeId,
  type CredentialRedactor,
  type DesktopModelServers,
  type FetchLike,
  type OpenAICompatibleProduct,
  type SharedServerRecord,
} from '@bike4mind/local-models/servers';
import { clean, type RuntimeTarget } from './localModels.js';

export type CliModelServer = SharedServerRecord & { source: 'desktop' | 'cli' };

export interface LoadedModelServers {
  servers: CliModelServer[];
  /** Why Desktop's list could not be read, when it could not. */
  problem: string | null;
}

/** The CLI's saved credential for a server id, if any. */
export type SecretFor = (serverId: string) => string | undefined;

export async function loadModelServers(
  read: () => Promise<DesktopModelServers> = readDesktopModelServers
): Promise<LoadedModelServers> {
  const { servers, problem } = await read();
  return { servers: servers.map(server => ({ ...server, source: 'desktop' as const })), problem };
}

export function findModelServer(servers: CliModelServer[], name: string): CliModelServer | undefined {
  const wanted = name.trim().toLowerCase();
  return servers.find(server => server.name === name) ?? servers.find(server => server.name.toLowerCase() === wanted);
}

export function noSuchServer(loaded: LoadedModelServers, name: string): Error {
  const known = loaded.servers.map(server => clean(server.name)).join(', ');
  const detail = loaded.problem ?? (known ? `Saved servers: ${known}.` : 'No model servers are saved in Desktop.');
  return new Error(`No model server named ${clean(name)}. ${detail} See: b4m models servers`);
}

/** Headers for a server's credential; null when it needs none or the CLI has none yet. */
export function serverCredential(server: CliModelServer, secret: string | undefined): Record<string, string> | null {
  if (server.auth.type === 'none' || !secret) return null;
  try {
    return server.auth.type === 'bearer'
      ? credentialHeaders({ type: 'bearer', token: secret })
      : credentialHeaders({ type: 'header', name: server.auth.name, value: secret });
  } catch {
    return null;
  }
}

/** Throws the shared rule's message (it names the field, never the value) when the secret cannot be sent. */
export function validateSecret(server: CliModelServer, secret: string): string {
  const trimmed = secret.trim();
  if (server.auth.type === 'none') throw new Error(`${clean(server.name)} does not use credentials.`);
  if (server.auth.type === 'bearer') credentialHeaders({ type: 'bearer', token: trimmed });
  else credentialHeaders({ type: 'header', name: server.auth.name, value: trimmed });
  return trimmed;
}

export function needsCredential(server: CliModelServer, secret: string | undefined): boolean {
  return server.auth.type !== 'none' && !serverCredential(server, secret);
}

export function loginHint(server: CliModelServer): string {
  return `b4m models servers login ${clean(server.name)}`;
}

export function serverFetch(server: CliModelServer, secret: string | undefined): FetchLike {
  const parsed = parseServerAddress(server.transport.baseUrl);
  if (!parsed) throw new Error(`${clean(server.name)} has an address the CLI cannot use.`);
  return createServerFetch({
    origin: parsed.origin,
    label: server.name,
    app: 'The CLI',
    credentialHeaders: () => serverCredential(server, secret),
  });
}

export function serverRedactor(server: CliModelServer, secret: string | undefined): CredentialRedactor | null {
  return credentialRedactor(serverCredential(server, secret));
}

export function runtimeFor(
  server: CliModelServer,
  fetch: FetchLike,
  kind: CliModelServer['kind'] = server.kind,
  product: OpenAICompatibleProduct | null = null
): LocalRuntime {
  const baseUrl = parseServerAddress(server.transport.baseUrl)?.baseUrl ?? server.transport.baseUrl;
  const id = serverRuntimeId(server.id);
  return kind === 'ollama'
    ? new OllamaRuntime({ baseUrl, id, fetch, redact: redactServerResponse })
    : new OpenAICompatibleRuntime({ baseUrl, id, fetch, product });
}

export function productLabel(kind: CliModelServer['kind'] | null, product: OpenAICompatibleProduct | null): string {
  if (kind === 'ollama') return 'Ollama';
  if (product === 'vllm') return 'vLLM';
  if (product === 'llama-server') return 'llama-server';
  if (product === 'lmstudio') return 'LM Studio';
  return 'OpenAI-compatible';
}

/** Pull and remove only where Desktop lets this server be managed. */
export function requireManageable(server: CliModelServer): void {
  const management = serverManagement(server);
  if (management === 'allowed') return;
  const name = clean(server.name);
  if (management === 'chat-only') throw new Error(`${name} is set to Chat only in Desktop.`);
  throw new Error(
    `${name} is an OpenAI-compatible server; it serves the models it was started with and has no pull or remove.`
  );
}

/** The default model's name when it is one on this target's saved server, else the bare default. */
export function defaultOn(target: RuntimeTarget, defaultModel: string | undefined): string | undefined {
  if (!target.server) return defaultModel;
  const parsed = defaultModel ? parseLocalModelId(defaultModel) : null;
  return parsed?.runtimeId === serverRuntimeId(target.server.id) ? parsed.model : undefined;
}

const now = () => performance.now();

/** Probes the server with the CLI's credential and returns a runtime for it; throws a plain-language reason when it is not usable. */
export async function resolveServerTarget(
  server: CliModelServer,
  secret: string | undefined,
  fetchOverride?: FetchLike
): Promise<RuntimeTarget & { product: OpenAICompatibleProduct | null }> {
  const name = clean(server.name);
  if (needsCredential(server, secret)) throw new Error(`${name} needs credentials. Run: ${loginHint(server)}`);
  const fetch = fetchOverride ?? serverFetch(server, secret);
  const parsed = parseServerAddress(server.transport.baseUrl);
  const baseUrl = parsed?.baseUrl ?? server.transport.baseUrl;
  const outcome = await probeServer(fetch, baseUrl, server.name, now, server.kind);
  if (!outcome.kind) {
    if (outcome.auth) {
      const refused = secret ? `${name} refused the saved credentials.` : `${name} needs credentials.`;
      throw new Error(`${refused} Run: ${loginHint(server)}`);
    }
    if (outcome.forbidden) throw new Error(clean(forbiddenMessage(server.name)));
    throw new Error(clean(outcome.error ?? `Could not reach ${server.name}.`));
  }
  const redactor = serverRedactor(server, secret);
  return {
    runtime: runtimeFor(server, fetch, outcome.kind, outcome.product),
    source: 'server',
    server: { id: server.id, name: server.name },
    product: outcome.product,
    ...(redactor && { redact: (text: string) => redactor.redact(text) }),
  };
}
