import { randomBytes } from 'node:crypto';
import type {
  ModelServerAccess,
  ModelServerCredentialInput,
  ModelServerKind,
  ModelServerSpecs,
  ModelServerTransport,
} from '@shared/modelServers';
import { LOCAL_SERVER_NAME, readSpecsShape, specsProblem } from '@shared/modelServers';
import type { SecretCipher, StoreFile, StoreLogger } from '../chat/mcp/McpServerStore';

export type StoredAuth = { type: 'none' } | { type: 'bearer' } | { type: 'header'; name: string };

/** A saved server without its secret. */
export interface ModelServerRecord {
  id: string;
  name: string;
  kind: ModelServerKind;
  transport: ModelServerTransport;
  access: ModelServerAccess;
  auth: StoredAuth;
  /** Names from the last successful list. */
  models: string[];
  addedAt: string;
  specs: ModelServerSpecs | null;
}

/**
 * On disk, `model-servers.json`. Fields this version does not know (an SSH transport, per-server
 * settings, a companion) are kept as they are when a record is rewritten, so later versions add
 * fields without a migration. `secret` is base64 safeStorage ciphertext of the token or header value.
 */
interface StoredServer extends Record<string, unknown> {
  id: string;
  name: string;
  kind: ModelServerKind;
  transport: { type: string; baseUrl?: string };
  access: ModelServerAccess;
  auth: StoredAuth;
  secret?: string;
  models?: string[];
  addedAt?: string;
  specs?: ModelServerSpecs;
}

interface StoreDocument extends Record<string, unknown> {
  version: 1;
  servers: StoredServer[];
  /** This computer's entered hardware, which overrides its probe. */
  localSpecs?: ModelServerSpecs;
}

export const MAX_MODEL_SERVERS = 20;
const MAX_NAME_CHARS = 80;
export const MAX_SECRET_CHARS = 4_096;
export const MAX_HEADER_NAME_CHARS = 64;
const MAX_LISTED_MODELS = 200;

// RFC 9110 token characters.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
// Anything but tab, printable ASCII and Latin-1: what Node's http refuses in a header value.
const INVALID_HEADER_VALUE = /[^\t\x20-\x7e\x80-\xff]/;
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'connection',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-connection',
  'cookie',
]);

export function newServerId(): string {
  return randomBytes(6).toString('hex');
}

/** The headers a credential adds to each request; throws with a message naming the field, never the value. */
export function credentialHeaders(credential: ModelServerCredentialInput): Record<string, string> | null {
  if (credential.type === 'none') return null;
  if (credential.type === 'bearer') {
    const token = credential.token.trim();
    if (!token) throw new Error('Enter the token.');
    if (token.length > MAX_SECRET_CHARS) throw new Error(`The token is longer than ${MAX_SECRET_CHARS} characters.`);
    if (INVALID_HEADER_VALUE.test(token) || /\s/.test(token)) {
      throw new Error('The token contains a control character, a space or a character HTTP does not allow.');
    }
    return { authorization: `Bearer ${token}` };
  }
  const name = credential.name.trim();
  const value = credential.value.trim();
  if (!HEADER_NAME.test(name)) throw new Error('Enter a header name made of letters, digits and dashes.');
  if (RESERVED_HEADERS.has(name.toLowerCase())) throw new Error(`${name} cannot carry a credential.`);
  if (!value) throw new Error(`Enter the value for ${name}.`);
  if (value.length > MAX_SECRET_CHARS)
    throw new Error(`The value for ${name} is longer than ${MAX_SECRET_CHARS} characters.`);
  if (INVALID_HEADER_VALUE.test(value)) {
    throw new Error(`The value for ${name} contains a control character or a character HTTP does not allow.`);
  }
  return { [name.toLowerCase()]: value };
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

  async add(
    input: Omit<ModelServerRecord, 'id' | 'auth' | 'models' | 'addedAt' | 'specs'>,
    credential: ModelServerCredentialInput
  ): Promise<ModelServerRecord> {
    const document = await this.load();
    this.assertWritable();
    if (document.servers.length >= MAX_MODEL_SERVERS) {
      throw new Error(`You can add at most ${MAX_MODEL_SERVERS} model servers.`);
    }
    credentialHeaders(credential);
    const name = this.checkName(document, input.name, null);
    const id = newServerId();
    const stored: StoredServer = {
      id,
      name,
      kind: input.kind,
      transport: { ...input.transport },
      access: input.access,
      auth: storedAuth(credential),
      models: [],
      addedAt: new Date().toISOString(),
    };
    this.writeSecret(stored, secretOf(credential));
    document.servers.push(stored);
    await this.persist(document);
    return hydrate(stored) as ModelServerRecord;
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
    const document = await this.load();
    this.assertWritable();
    const stored = document.servers.find(server => server.id === id);
    if (!stored) throw new Error('That model server is no longer saved.');
    const specs = patch.specs === undefined ? undefined : checkedSpecs(patch.specs, false);
    if (patch.name !== undefined) stored.name = this.checkName(document, patch.name, id);
    if (specs === null) delete stored.specs;
    else if (specs) stored.specs = specs;
    if (patch.kind !== undefined) stored.kind = patch.kind;
    if (patch.access !== undefined) stored.access = patch.access;
    if (patch.credential) {
      credentialHeaders(patch.credential);
      stored.auth = storedAuth(patch.credential);
      this.writeSecret(stored, secretOf(patch.credential));
    }
    await this.persist(document);
    return hydrate(stored) as ModelServerRecord;
  }

  async setModels(id: string, names: readonly string[]): Promise<void> {
    const document = await this.load();
    if (this.readOnly) return;
    const stored = document.servers.find(server => server.id === id);
    const next = [...new Set(names)].slice(0, MAX_LISTED_MODELS);
    if (!stored || sameList(stored.models ?? [], next)) return;
    stored.models = next;
    await this.persist(document);
  }

  async localSpecs(): Promise<ModelServerSpecs | null> {
    return readSpecs((await this.load()).localSpecs);
  }

  async setLocalSpecs(specs: ModelServerSpecs | null): Promise<ModelServerSpecs | null> {
    const document = await this.load();
    this.assertWritable();
    const checked = checkedSpecs(specs, true);
    if (checked) document.localSpecs = checked;
    else delete document.localSpecs;
    await this.persist(document);
    return checked;
  }

  async remove(id: string): Promise<void> {
    const document = await this.load();
    this.assertWritable();
    const before = document.servers.length;
    document.servers = document.servers.filter(server => server.id !== id);
    this.secrets.delete(id);
    if (document.servers.length !== before) await this.persist(document);
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

  private writeSecret(stored: StoredServer, secret: string | null): void {
    delete stored.secret;
    if (secret === null) {
      this.secrets.delete(stored.id);
      return;
    }
    this.secrets.set(stored.id, secret);
    if (this.credentialPersisted()) stored.secret = this.cipher.encryptString(secret).toString('base64');
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
    if (this.document) return this.document;
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
    return document;
  }

  // Writes share one temp file, so overlapping ones would interleave and corrupt the list.
  private async persist(document: StoreDocument): Promise<void> {
    this.document = document;
    const write = this.writing.then(() =>
      this.file.write(JSON.stringify({ ...document, servers: [...document.servers, ...this.orphans] }, null, 2))
    );
    this.writing = write.catch(() => undefined);
    await write;
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

function isStored(value: unknown): value is StoredServer {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const transport = candidate.transport as Record<string, unknown> | undefined;
  const auth = candidate.auth as Record<string, unknown> | undefined;
  return (
    typeof candidate.id === 'string' &&
    /^[0-9a-z]{1,32}$/.test(candidate.id) &&
    typeof candidate.name === 'string' &&
    (candidate.kind === 'ollama' || candidate.kind === 'openai-compatible') &&
    typeof transport?.type === 'string' &&
    (candidate.access === 'chat' || candidate.access === 'manage') &&
    (auth?.type === 'none' || auth?.type === 'bearer' || (auth?.type === 'header' && typeof auth.name === 'string'))
  );
}

/** Null for a record this version cannot use (an unknown transport); it stays on disk untouched. */
function hydrate(stored: StoredServer): ModelServerRecord | null {
  if (stored.transport.type !== 'http' || typeof stored.transport.baseUrl !== 'string') return null;
  return {
    id: stored.id,
    name: stored.name,
    kind: stored.kind,
    transport: { type: 'http', baseUrl: stored.transport.baseUrl },
    access: stored.access,
    auth: stored.auth.type === 'header' ? { type: 'header', name: stored.auth.name } : { type: stored.auth.type },
    models: Array.isArray(stored.models)
      ? stored.models.filter((name): name is string => typeof name === 'string')
      : [],
    addedAt: typeof stored.addedAt === 'string' ? stored.addedAt : '',
    specs: readSpecs(stored.specs),
  };
}

/** Specs to store: null when every figure is blank; throws when Settings should not have sent them. */
function checkedSpecs(specs: ModelServerSpecs | null, local: boolean): ModelServerSpecs | null {
  if (!specs || (specs.ramGiB === null && specs.gpuMemoryGiB === null && specs.bandwidthGBps === null)) return null;
  const problem = specsProblem(specs, local);
  if (problem) throw new Error(problem);
  const { ramGiB, gpuMemoryGiB, bandwidthGBps, unified } = specs;
  return { ramGiB, gpuMemoryGiB, bandwidthGBps, unified: !local && unified };
}

/** Specs as stored; a hand-edited or newer shape that does not check out is ignored, so the server stays unrated. */
function readSpecs(value: unknown): ModelServerSpecs | null {
  const specs = readSpecsShape(value);
  if (!specs) return null;
  if (specs.ramGiB === null && specs.gpuMemoryGiB === null && specs.bandwidthGBps === null) return null;
  return specsProblem(specs, true) ? null : specs;
}
