import { randomUUID } from 'node:crypto';
import type { McpServerInput, McpTransport } from '@shared/mcp';

/**
 * The slice of Electron's `safeStorage` this module needs, narrowed to a port for the same
 * reasons as auth/tokenVault.ts: testable without an Electron app, and the "only after the
 * app ready event" rule stays the caller's problem rather than an import-time landmine.
 */
export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface StoreFile {
  read(): Promise<string | null>;
  write(contents: string): Promise<void>;
}

export interface StoreLogger {
  debug(message: string): void;
  warn(message: string): void;
}

/** A server config with its secrets resolved, which only the main process ever holds. */
export interface McpServerRecord {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  command?: string;
  args: string[];
  url?: string;
  env: Record<string, string>;
  headers: Record<string, string>;
}

/**
 * On-disk shape. Everything that is not a secret stays plaintext, INCLUDING the env variable
 * and header NAMES: the dialog has to be able to say "GITHUB_TOKEN is set" on a machine whose
 * keychain is locked, and a variable name is not a credential. `secrets` is one safeStorage
 * blob per server holding `{ env, headers }` - the values.
 */
interface StoredServer {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
  headerKeys?: string[];
  /** base64 safeStorage ciphertext of {@link StoredSecrets}. Absent when there are none. */
  secrets?: string;
}

interface StoredSecrets {
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

interface StoreDocument {
  version: 1;
  servers: StoredServer[];
}

const EMPTY: StoreDocument = { version: 1, servers: [] };

const MAX_SERVERS = 20;
const MAX_ARGS = 64;
const MAX_FIELD_CHARS = 2_000;

function trimmed(value: unknown, max = MAX_FIELD_CHARS): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const name = trimmed(key, 256);
    // A key with no name cannot be passed to a child, and the three prototype keys must not be
    // assignable through an object literal built from caller data.
    if (!name || name === '__proto__' || name === 'constructor' || name === 'prototype') continue;
    if (typeof entry === 'string') out[name] = entry.slice(0, MAX_FIELD_CHARS);
  }
  return out;
}

/**
 * The user's MCP server configs, per machine, with the secrets in the OS keychain.
 *
 * Secrets NEVER reach the JSON file in plaintext. When `safeStorage` reports no encryption
 * (Linux with no keyring), this keeps them in memory for the run and writes only the metadata,
 * exactly as TokenVault does with access tokens - see {@link secretsPersisted}, which the
 * dialog surfaces so the user is told rather than finding out on the next launch.
 */
export class McpServerStore {
  private document: StoreDocument | null = null;
  /** Decrypted secrets by server id; the only copy when encryption is unavailable. */
  private readonly cache = new Map<string, StoredSecrets>();

  constructor(
    private readonly cipher: SecretCipher,
    private readonly file: StoreFile,
    private readonly logger: StoreLogger
  ) {}

  secretsPersisted(): boolean {
    return this.cipher.isEncryptionAvailable();
  }

  async list(): Promise<McpServerRecord[]> {
    const document = await this.load();
    return document.servers.map(server => this.hydrate(server));
  }

  async get(id: string): Promise<McpServerRecord | null> {
    return (await this.list()).find(server => server.id === id) ?? null;
  }

  async add(input: McpServerInput): Promise<McpServerRecord> {
    const document = await this.load();
    if (document.servers.length >= MAX_SERVERS) {
      throw new Error(`You can configure at most ${MAX_SERVERS} MCP servers.`);
    }
    const id = randomUUID();
    const record = normalize({ ...input, id });
    assertUsable(record, document.servers);

    document.servers.push(this.dehydrate(record));
    await this.persist(document);
    return record;
  }

  /**
   * Replace a server's config. `env` and `headers` are REPLACED when present and kept when
   * omitted, so the dialog can save a renamed server without the user retyping its API key -
   * which it could not do anyway, having never been given the value.
   */
  async update(id: string, input: McpServerInput): Promise<McpServerRecord> {
    const document = await this.load();
    const index = document.servers.findIndex(server => server.id === id);
    if (index < 0) throw new Error('That MCP server is no longer configured.');

    const existing = this.hydrate(document.servers[index]);
    const record = normalize({
      ...input,
      id,
      env: input.env ?? existing.env,
      headers: input.headers ?? existing.headers,
      enabled: input.enabled ?? existing.enabled,
    });
    assertUsable(
      record,
      document.servers.filter(server => server.id !== id)
    );

    document.servers[index] = this.dehydrate(record);
    await this.persist(document);
    return record;
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpServerRecord | null> {
    const document = await this.load();
    const stored = document.servers.find(server => server.id === id);
    if (!stored) return null;
    stored.enabled = enabled;
    await this.persist(document);
    return this.hydrate(stored);
  }

  async remove(id: string): Promise<void> {
    const document = await this.load();
    const before = document.servers.length;
    document.servers = document.servers.filter(server => server.id !== id);
    this.cache.delete(id);
    if (document.servers.length !== before) await this.persist(document);
  }

  private hydrate(stored: StoredServer): McpServerRecord {
    return {
      id: stored.id,
      name: stored.name,
      transport: stored.transport,
      enabled: stored.enabled,
      ...(stored.command ? { command: stored.command } : {}),
      args: stored.args ?? [],
      ...(stored.url ? { url: stored.url } : {}),
      ...this.readSecrets(stored),
    };
  }

  private readSecrets(stored: StoredServer): { env: Record<string, string>; headers: Record<string, string> } {
    const cached = this.cache.get(stored.id);
    if (cached) return { env: cached.env ?? {}, headers: cached.headers ?? {} };
    if (!stored.secrets || !this.secretsPersisted()) return { env: {}, headers: {} };

    try {
      const parsed = JSON.parse(this.cipher.decryptString(Buffer.from(stored.secrets, 'base64'))) as StoredSecrets;
      const secrets = { env: stringMap(parsed.env), headers: stringMap(parsed.headers) };
      this.cache.set(stored.id, secrets);
      return secrets;
    } catch (err) {
      // A blob written under a different OS user or a rotated keychain entry. The server is
      // kept and its secrets are dropped, so the user sees a connection fail with a readable
      // reason instead of the whole list disappearing.
      this.logger.warn(`MCP: could not decrypt the stored secrets for "${stored.name}"`);
      this.logger.debug(`MCP: decrypt failed: ${err instanceof Error ? err.name : 'unknown'}`);
      return { env: {}, headers: {} };
    }
  }

  private dehydrate(record: McpServerRecord): StoredServer {
    const secrets: StoredSecrets = { env: record.env, headers: record.headers };
    const hasSecrets = Object.keys(record.env).length > 0 || Object.keys(record.headers).length > 0;
    this.cache.set(record.id, secrets);

    return {
      id: record.id,
      name: record.name,
      transport: record.transport,
      enabled: record.enabled,
      ...(record.command ? { command: record.command } : {}),
      ...(record.args.length > 0 ? { args: record.args } : {}),
      ...(record.url ? { url: record.url } : {}),
      envKeys: Object.keys(record.env),
      headerKeys: Object.keys(record.headers),
      ...(hasSecrets && this.secretsPersisted()
        ? { secrets: this.cipher.encryptString(JSON.stringify(secrets)).toString('base64') }
        : {}),
    };
  }

  private async load(): Promise<StoreDocument> {
    if (this.document) return this.document;

    let document: StoreDocument = { ...EMPTY, servers: [] };
    try {
      const raw = await this.file.read();
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<StoreDocument>;
        document = { version: 1, servers: Array.isArray(parsed.servers) ? parsed.servers.filter(isStored) : [] };
      }
    } catch (err) {
      this.logger.warn(
        `MCP: server list unreadable, starting empty: ${err instanceof Error ? err.message : 'unknown'}`
      );
    }

    this.document = document;
    return document;
  }

  private async persist(document: StoreDocument): Promise<void> {
    this.document = document;
    await this.file.write(JSON.stringify(document, null, 2));
  }
}

function isStored(value: unknown): value is StoredServer {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    (candidate.transport === 'stdio' || candidate.transport === 'http')
  );
}

function normalize(input: McpServerInput & { id: string }): McpServerRecord {
  const transport: McpTransport = input.transport === 'http' ? 'http' : 'stdio';
  return {
    id: input.id,
    name: trimmed(input.name, 80),
    transport,
    enabled: input.enabled !== false,
    ...(transport === 'stdio' ? { command: trimmed(input.command) } : {}),
    args: Array.isArray(input.args)
      ? input.args
          .slice(0, MAX_ARGS)
          .map(arg => trimmed(arg))
          .filter(arg => arg.length > 0)
      : [],
    ...(transport === 'http' ? { url: trimmed(input.url) } : {}),
    env: stringMap(input.env),
    headers: stringMap(input.headers),
  };
}

/**
 * Refuse a config that cannot work, at the point the user can still fix it.
 *
 * The URL check is the one with teeth: an `http` server is fetched by the main process, so a
 * `file:` URL would be a local read and a bare hostname would be ambiguous. Only http(s) is
 * accepted, and a non-loopback URL must be https so a bearer token in a header is not sent in
 * the clear.
 */
function assertUsable(record: McpServerRecord, others: readonly StoredServer[]): void {
  if (!record.name) throw new Error('Give the server a name.');
  if (others.some(server => server.name.toLowerCase() === record.name.toLowerCase())) {
    throw new Error(`Another server is already called "${record.name}".`);
  }

  if (record.transport === 'stdio') {
    if (!record.command) throw new Error('Give the command that starts the server.');
    return;
  }

  if (!record.url) throw new Error('Give the server URL.');
  let parsed: URL;
  try {
    parsed = new URL(record.url);
  } catch {
    throw new Error('That is not a valid URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('An MCP server URL must be http or https.');
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  if (parsed.protocol === 'http:' && !loopback) {
    throw new Error('Use https for a remote server; http would send your headers in the clear.');
  }
}
