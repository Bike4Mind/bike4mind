/**
 * Model servers saved in Desktop (read-only) and the CLI's own copy of their credentials. Shared by
 * `b4m models` (src/commands/modelsCommand.ts) and the MCP model tools (src/mcp/modelTools.ts).
 */

import { OllamaRuntime, type LocalRuntime } from '@bike4mind/local-models';
import {
  OpenAICompatibleRuntime,
  createServerFetch,
  createSshFetch,
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
  SSH_DEFAULT_PORT,
  SSH_PROBE_TIMEOUT_MS,
  sshServerUrl,
  type CredentialRedactor,
  type DesktopModelServers,
  type FetchLike,
  type OpenAICompatibleProduct,
  type SharedServerRecord,
  type SshEndpoint,
  type UnusableServerRecord,
} from '@bike4mind/local-models/servers';
import { clean, type RuntimeTarget } from './localModels.js';
import { shellWord } from '../utils/shellWord.js';

export type CliModelServer = SharedServerRecord & { source: 'desktop' | 'cli' };

/** Opens the SSH forward to a server on another machine's loopback; createSshFetch outside tests. */
export type SshFetchFor = (endpoint: SshEndpoint) => FetchLike;

export interface LoadedModelServers {
  servers: CliModelServer[];
  /** Why Desktop's list could not be read, when it could not. */
  problem: string | null;
  /** Saved SSH servers whose destination or port cannot be used: listed with why, never connected to. */
  unusable?: UnusableServerRecord[];
}

/** The CLI's saved credential for a server id, if any. */
export type SecretFor = (serverId: string) => string | undefined;

export async function loadModelServers(
  read: () => Promise<DesktopModelServers> = readDesktopModelServers
): Promise<LoadedModelServers> {
  const { servers, problem, unusable } = await read();
  return {
    servers: servers.map(server => ({ ...server, source: 'desktop' as const })),
    problem,
    ...(unusable?.length ? { unusable } : {}),
  };
}

export function findModelServer<T extends { name: string }>(servers: T[], name: string): T | undefined {
  const wanted = name.trim().toLowerCase();
  return servers.find(server => server.name === name) ?? servers.find(server => server.name.toLowerCase() === wanted);
}

export function unusableStatus(server: UnusableServerRecord): string {
  return `${server.problem} Remove it in Desktop and add it again.`;
}

export function unusableReason(server: UnusableServerRecord): string {
  return `${clean(server.name)} cannot be used: ${unusableStatus(server)}`;
}

export function findUnusableServer(loaded: LoadedModelServers, name: string): UnusableServerRecord | undefined {
  const wanted = name.trim().toLowerCase();
  return loaded.unusable?.find(server => server.name.toLowerCase() === wanted);
}

export function noSuchServer(loaded: LoadedModelServers, name: string): Error {
  const unusable = findUnusableServer(loaded, name);
  if (unusable) return new Error(unusableReason(unusable));
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
  return `b4m models servers login ${shellWord(clean(server.name))}`;
}

/** The address to show; one the CLI cannot parse is not echoed, since it may carry a secret in its query. */
export function serverAddressLabel(server: CliModelServer): string {
  const { transport } = server;
  if (transport.type === 'ssh') {
    return `ssh ${transport.destination}${transport.port === SSH_DEFAULT_PORT ? '' : ` port ${transport.port}`}`;
  }
  return parseServerAddress(transport.baseUrl)?.baseUrl ?? 'unusable address';
}

/** Where requests go: the address, or for SSH the port on the far end's loopback; null when unusable. */
export function serverBaseUrl(server: CliModelServer): string | null {
  const { transport } = server;
  if (transport.type === 'ssh') return sshServerUrl(transport.port);
  return parseServerAddress(transport.baseUrl)?.baseUrl ?? null;
}

/** Ends every request when `signal` aborts too, so a cancel stops an ssh already running. */
export const withSignal =
  (fetch: FetchLike, signal: AbortSignal): FetchLike =>
  (input, init) =>
    fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });

export function serverFetch(
  server: CliModelServer,
  secret: string | undefined,
  sshFetchFor: SshFetchFor = endpoint => createSshFetch(endpoint)
): FetchLike {
  const { transport } = server;
  if (transport.type === 'ssh') {
    return sshFetchFor({
      destination: transport.destination,
      port: transport.port,
      label: server.name,
      app: 'The CLI',
      // Ollama over SSH takes no credential; ssh signs in with the user's keys.
      credentialHeaders: () => (server.kind === 'ollama' ? null : serverCredential(server, secret)),
    });
  }
  const parsed = parseServerAddress(transport.baseUrl);
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
  const baseUrl = serverBaseUrl(server);
  if (!baseUrl) throw new Error(`${clean(server.name)} has an address the CLI cannot use.`);
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
  if (product === 'llama-swap') return 'llama-swap';
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
  fetch: FetchLike,
  probeTimeoutMs?: number
): Promise<RuntimeTarget & { product: OpenAICompatibleProduct | null }> {
  const name = clean(server.name);
  if (needsCredential(server, secret)) throw new Error(`${name} needs credentials. Run: ${loginHint(server)}`);
  const baseUrl = serverBaseUrl(server);
  if (!baseUrl) throw new Error(`${name} has an address the CLI cannot use.`);
  const timeout = probeTimeoutMs ?? (server.transport.type === 'ssh' ? SSH_PROBE_TIMEOUT_MS : undefined);
  const outcome = await probeServer(fetch, baseUrl, server.name, now, server.kind, timeout);
  if (!outcome.kind) {
    if (outcome.auth) {
      const refused = secret ? `${name} refused the saved credentials.` : `${name} needs credentials.`;
      throw new Error(`${refused} Run: ${loginHint(server)}`);
    }
    if (outcome.forbidden) throw new Error(clean(forbiddenMessage(server.name)));
    const redactor = serverRedactor(server, secret);
    const reason = outcome.error ?? `Could not reach ${server.name}.`;
    throw new Error(clean(redactor ? redactor.redact(reason) : reason));
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
