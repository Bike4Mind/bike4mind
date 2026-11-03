import { randomBytes } from 'node:crypto';
import {
  credentialHeaders,
  hydrate,
  isStored,
  MAX_HEADER_NAME_CHARS,
  MAX_SECRET_CHARS,
  readSpecs,
  type ModelServerRecord,
  type StoredAuth,
  type StoredServer,
} from '@bike4mind/local-models/servers';
import type {
  ModelServerAccess,
  ModelServerCredentialInput,
  ModelServerKind,
  ModelServerSpecs,
} from '@shared/modelServers';
import { LOCAL_SERVER_NAME, specsProblem } from '@shared/modelServers';
import type { SecretCipher, StoreFile, StoreLogger } from '../chat/mcp/McpServerStore';

export { credentialHeaders, MAX_HEADER_NAME_CHARS, MAX_SECRET_CHARS };
export type { ModelServerRecord, StoredAuth };

interface StoreDocument extends Record<string, unknown> {
  version: 1;
  servers: StoredServer[];
  /** This computer's entered hardware, which overrides its probe. */
  localSpecs?: ModelServerSpecs;
}

export const MAX_MODEL_SERVERS = 20;
const MAX_NAME_CHARS = 80;
const MAX_LISTED_MODELS = 200;

export function newServerId(): string {
  return randomBytes(6).toString('hex');
}

function storedAuth(credential: ModelServerCredentialInput): StoredAuth {
  if (credential.type === 'header') return { type: 'header', name: credential.name.trim() };
  return { type: credential.type };
}

function secretOf(credential: ModelServerCredentialInput): string | null {
  if (credential.type === 'bearer') return credential.token.trim();
  if (credential.type === 'header') return credential.value.trim();
  return null;
}

function headersFor(auth: StoredAuth, secret: string): Record<string, string> | null {
  if (auth.type === 'bearer') return { authorization: `Bearer ${secret}` };
  if (auth.type === 'header') return { [auth.name.toLowerCase()]: secret };
  return null;
}

export function normalizeServerName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_CHARS);
}

/**
 * Saved model servers, per machine, with each credential in safeStorage like MCP secrets. Without a
 * keyring a credential is kept in memory for this run only; `credentialPersisted` says so. Nothing here
 * logs or returns a credential except `headers`, which only the server's own fetch calls.
 */
export class ModelServerStore {
  private document: StoreDocument | null = null;
  private loading: Promise<void> | null = null;
  /** Entries without a string id: kept on disk, never listed. */
  private orphans: unknown[] = [];
  /** The file came from a newer Desktop; nothing is written back. */
  private readOnly = false;

  private writing: Promise<void> = Promise.resolve();
  /** Decrypted secrets by server id; the only copy when encryption is unavailable. */
  private readonly secrets = new Map<string, string>();

  constructor(
    private readonly cipher: SecretCipher,
    private readonly file: StoreFile,
    private readonly logger: StoreLogger
  ) {}

  credentialPersisted(): boolean {
    return this.cipher.isEncryptionAvailable();
  }

  async list(): Promise<ModelServerRecord[]> {
    const document = await this.load();
    return document.servers.flatMap(server => {
      const record = isStored(server) ? hydrate(server) : null;
      return record ? [record] : [];
    });
  }

  async get(id: string): Promise<ModelServerRecord | null> {
    return (await this.list()).find(server => server.id === id) ?? null;
  }

  add(
    input: Omit<ModelServerRecord, 'id' | 'auth' | 'models' | 'addedAt' | 'specs'>,
    credential: ModelServerCredentialInput
  ): Promise<ModelServerRecord> {
    return this.commit(document => {
      this.assertWritable();
      if (document.servers.length >= MAX_MODEL_SERVERS) {
        throw new Error(`You can add at most ${MAX_MODEL_SERVERS} model servers.`);
      }
      credentialHeaders(credential);
      const name = this.checkName(document, input.name, null);
      const stored: StoredServer = {
        id: newServerId(),
        name,
        kind: input.kind,
        transport: { ...input.transport },
        access: input.access,
        auth: storedAuth(credential),
        models: [],
        addedAt: new Date().toISOString(),
      };
      const secret = secretOf(credential);
      this.sealSecret(stored, secret);
      return {
        document: { ...document, servers: [...document.servers, stored] },
        applied: () => this.cacheSecret(stored.id, secret),
        result: hydrate(stored) as ModelServerRecord,
      };
    });
  }

  async update(
    id: string,
    patch: {
      name?: string;
      kind?: ModelServerKind;
      access?: ModelServerAccess;
      credential?: ModelServerCredentialInput;
      specs?: ModelServerSpecs | null;
    }
  ): Promise<ModelServerRecord> {
    return this.commit(document => {
      this.assertWritable();
      const current = document.servers.find(server => server.id === id);
      if (!current) throw new Error('That model server is no longer saved.');
      const specs = patch.specs === undefined ? undefined : checkedSpecs(patch.specs, false);
      const stored: StoredServer = { ...current };
      if (patch.name !== undefined) stored.name = this.checkName(document, patch.name, id);
      if (specs === null) delete stored.specs;
      else if (specs) stored.specs = specs;
      if (patch.kind !== undefined) stored.kind = patch.kind;
      if (patch.access !== undefined) stored.access = patch.access;
      let applied: (() => void) | undefined;
      if (patch.credential) {
        credentialHeaders(patch.credential);
        stored.auth = storedAuth(patch.credential);
        const secret = secretOf(patch.credential);
        this.sealSecret(stored, secret);
        applied = () => this.cacheSecret(id, secret);
      }
      return {
        document: { ...document, servers: document.servers.map(server => (server.id === id ? stored : server)) },
        applied,
        result: hydrate(stored) as ModelServerRecord,
      };
    });
  }

  setModels(id: string, names: readonly string[]): Promise<void> {
    return this.commit(document => {
      const current = document.servers.find(server => server.id === id);
      const next = [...new Set(names)].slice(0, MAX_LISTED_MODELS);
      if (this.readOnly || !current || sameList(current.models ?? [], next)) return { document, result: undefined };
      const servers = document.servers.map(server => (server.id === id ? { ...server, models: next } : server));
      return { document: { ...document, servers }, result: undefined };
    });
  }

  async localSpecs(): Promise<ModelServerSpecs | null> {
    return readSpecs((await this.load()).localSpecs);
  }

  setLocalSpecs(specs: ModelServerSpecs | null): Promise<ModelServerSpecs | null> {
    return this.commit(document => {
      this.assertWritable();
      const checked = checkedSpecs(specs, true);
      const { localSpecs: _previous, ...rest } = document;
      return { document: checked ? { ...rest, localSpecs: checked } : rest, result: checked };
    });
  }

  remove(id: string): Promise<void> {
    return this.commit(document => {
      this.assertWritable();
      const servers = document.servers.filter(server => server.id !== id);
      if (servers.length === document.servers.length) return { document, result: undefined };
      return { document: { ...document, servers }, applied: () => this.secrets.delete(id), result: undefined };
    });
  }

  /** The credential headers for this server's own requests; null when it has none or it cannot be read. */
  headers(record: Pick<ModelServerRecord, 'id' | 'auth'>): Record<string, string> | null {
    if (record.auth.type === 'none') return null;
    const secret = this.readSecret(record.id);
    return secret === null ? null : headersFor(record.auth, secret);
  }

  /** A credential is configured but not available: lost keyring entry, or session-only and Desktop restarted. */
  credentialMissing(record: Pick<ModelServerRecord, 'id' | 'auth'>): boolean {
    return record.auth.type !== 'none' && this.readSecret(record.id) === null;
  }

  private checkName(document: StoreDocument, raw: string, id: string | null): string {
    const name = normalizeServerName(raw);
    if (!name) throw new Error('Give the server a name.');
    const taken = (other: unknown) => typeof other === 'string' && other.toLowerCase() === name.toLowerCase();
    if (taken(LOCAL_SERVER_NAME) || document.servers.some(server => server.id !== id && taken(server.name))) {
      throw new Error(`Another server is already called "${name}".`);
    }
    return name;
  }

  private sealSecret(stored: StoredServer, secret: string | null): void {
    delete stored.secret;
    if (secret !== null && this.credentialPersisted()) {
      stored.secret = this.cipher.encryptString(secret).toString('base64');
    }
  }

  private cacheSecret(id: string, secret: string | null): void {
    if (secret === null) this.secrets.delete(id);
    else this.secrets.set(id, secret);
  }

  private readSecret(id: string): string | null {
    const cached = this.secrets.get(id);
    if (cached !== undefined) return cached;
    const stored = this.document?.servers.find(server => server.id === id);
    if (!stored?.secret || !this.credentialPersisted()) return null;
    try {
      const secret = this.cipher.decryptString(Buffer.from(stored.secret, 'base64'));
      this.secrets.set(id, secret);
      return secret;
    } catch (err) {
      this.logger.warn(`MODEL SERVERS: could not decrypt the stored credential for "${stored.name}"`);
      this.logger.debug(`MODEL SERVERS: decrypt failed: ${err instanceof Error ? err.name : 'unknown'}`);
      return null;
    }
  }

  private async load(): Promise<StoreDocument> {
    await (this.loading ??= this.read());
    return this.document as StoreDocument;
  }

  private async read(): Promise<void> {
    let document: StoreDocument = { version: 1, servers: [] };
    try {
      const raw = await this.file.read();
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        // Records this version cannot read (a later kind, transport or auth) are carried through untouched.
        const all: unknown[] = Array.isArray(parsed.servers) ? parsed.servers : [];
        this.orphans = all.filter(value => !hasId(value));
        document = { ...parsed, version: 1, servers: all.filter(hasId) };
        if (typeof parsed.version === 'number' && parsed.version > 1) {
          this.readOnly = true;
          this.logger.warn(
            `MODEL SERVERS: server list is version ${parsed.version}, newer than this Desktop reads; using it read-only`
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `MODEL SERVERS: server list unreadable, starting empty: ${err instanceof Error ? err.message : 'unknown'}`
      );
    }
    this.document = document;
  }

  /**
   * Runs one change against the current list, one at a time since writes share a temp file. Memory
   * (the list and the secret cache) changes only after the write succeeds, so a failed write leaves no trace.
   */
  private commit<T>(
    change: (document: StoreDocument) => { document: StoreDocument; applied?: () => void; result: T }
  ): Promise<T> {
    const run = this.writing.then(async () => {
      const current = await this.load();
      const { document, applied, result } = change(current);
      if (document !== current) {
        await this.file.write(
          JSON.stringify({ ...document, servers: [...document.servers, ...this.orphans] }, null, 2)
        );
        this.document = document;
      }
      applied?.();
      return result;
    });
    this.writing = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private assertWritable(): void {
    if (this.readOnly) {
      throw new Error('The saved server list was written by a newer Desktop. Update Desktop to change it.');
    }
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

function hasId(value: unknown): value is StoredServer {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string';
}

/** Specs to store: null when every figure is blank; throws when Settings should not have sent them. */
function checkedSpecs(specs: ModelServerSpecs | null, local: boolean): ModelServerSpecs | null {
  if (!specs || (specs.ramGiB === null && specs.gpuMemoryGiB === null && specs.bandwidthGBps === null)) return null;
  const problem = specsProblem(specs, local);
  if (problem) throw new Error(problem);
  const { ramGiB, gpuMemoryGiB, bandwidthGBps, unified } = specs;
  return { ramGiB, gpuMemoryGiB, bandwidthGBps, unified: !local && unified };
}
