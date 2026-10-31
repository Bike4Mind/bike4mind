import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type ModelServerKind = 'ollama' | 'openai-compatible';
export type ModelServerAccess = 'chat' | 'manage';
export type ModelServerTransport = { type: 'http'; baseUrl: string };
export type StoredAuth = { type: 'none' } | { type: 'bearer' } | { type: 'header'; name: string };

export type ModelServerCredentialInput =
  { type: 'none' } | { type: 'bearer'; token: string } | { type: 'header'; name: string; value: string };

export interface ModelServerSpecs {
  ramGiB: number | null;
  gpuMemoryGiB: number | null;
  bandwidthGBps: number | null;
  unified: boolean;
}

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

export type SharedServerRecord = ModelServerRecord;

/**
 * On disk, `model-servers.json`. Fields this version does not know (an SSH transport, per-server
 * settings, a companion) are kept as they are when a record is rewritten, so later versions add
 * fields without a migration. `secret` is base64 safeStorage ciphertext of the token or header value.
 */
export interface StoredServer extends Record<string, unknown> {
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

export const MAX_SECRET_CHARS = 4_096;
export const MAX_HEADER_NAME_CHARS = 64;

// Must match MAX_SPEC_* in apps/desktop/src/shared/modelServers.ts; sharedCopies.test.ts there checks it.
const MAX_SPEC_MEMORY_GIB = 65_536;
const MAX_SPEC_BANDWIDTH_GBPS = 100_000;

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

export function isStored(value: unknown): value is StoredServer {
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
export function hydrate(stored: StoredServer): ModelServerRecord | null {
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

function readSpecsShape(value: unknown): ModelServerSpecs | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const figure = (field: unknown) => (typeof field === 'number' ? field : null);
  return {
    ramGiB: figure(raw.ramGiB),
    gpuMemoryGiB: figure(raw.gpuMemoryGiB),
    bandwidthGBps: figure(raw.bandwidthGBps),
    unified: raw.unified === true,
  };
}

function specsInRange(specs: ModelServerSpecs): boolean {
  const ok = (value: number | null, max: number) =>
    value === null || (Number.isFinite(value) && value > 0 && value <= max);
  return (
    ok(specs.ramGiB, MAX_SPEC_MEMORY_GIB) &&
    ok(specs.gpuMemoryGiB, MAX_SPEC_MEMORY_GIB) &&
    ok(specs.bandwidthGBps, MAX_SPEC_BANDWIDTH_GBPS)
  );
}

/** Specs as stored; a hand-edited or newer shape that does not check out is ignored, so the server stays unrated. */
export function readSpecs(value: unknown): ModelServerSpecs | null {
  const specs = readSpecsShape(value);
  if (!specs) return null;
  if (specs.ramGiB === null && specs.gpuMemoryGiB === null && specs.bandwidthGBps === null) return null;
  return specsInRange(specs) ? specs : null;
}

// The next four must match apps/desktop/src/shared/chat.ts and shared/modelServers.ts; the renderer cannot import a Node package.
// apps/desktop/src/main/modelServers/sharedCopies.test.ts fails when they drift.

export type ModelServerManagement = 'allowed' | 'chat-only' | 'unsupported';

export function serverManagement(server: {
  local?: boolean;
  kind: ModelServerKind;
  access: ModelServerAccess;
}): ModelServerManagement {
  if (server.local) return 'allowed';
  if (server.kind !== 'ollama') return 'unsupported';
  return server.access === 'manage' ? 'allowed' : 'chat-only';
}

export function serverRuntimeId(serverId: string): string {
  return `srv-${serverId}`;
}

export function localModelId(runtimeId: string, model: string): string {
  return `local:${encodeURIComponent(runtimeId)}:${model}`;
}

export function parseLocalModelId(id: string): { runtimeId: string; model: string } | null {
  const match = /^local:([^:]+):(.+)$/s.exec(id);
  if (!match) return null;
  try {
    return { runtimeId: decodeURIComponent(match[1]), model: match[2] };
  } catch {
    return null;
  }
}

export interface DesktopDirsOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  home?: string;
}

const FILE_NAME = 'model-servers.json';

/**
 * Where Desktop keeps its userData folder: `B4M_DESKTOP_USER_DATA` when set, else the packaged name
 * (package.json `name`) then the product name under the platform's app-data folder.
 */
export function desktopUserDataDirs(opts: DesktopDirsOptions = {}): string[] {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const override = env.B4M_DESKTOP_USER_DATA?.trim();
  if (override) return [override];
  const flavor = platform === 'win32' ? path.win32 : path.posix;
  let appData: string;
  if (platform === 'darwin') appData = flavor.join(home, 'Library', 'Application Support');
  else if (platform === 'win32') appData = env.APPDATA || flavor.join(home, 'AppData', 'Roaming');
  else appData = env.XDG_CONFIG_HOME || flavor.join(home, '.config');
  return [flavor.join(appData, '@bike4mind', 'desktop'), flavor.join(appData, 'Bike4Mind')];
}

export interface DesktopModelServers {
  servers: SharedServerRecord[];
  /** The file that was read; null when Desktop has none. */
  path: string | null;
  /** Why the file could not be used; never quotes its contents. */
  problem: string | null;
}

export interface ReadDesktopOptions extends DesktopDirsOptions {
  /** Folders to try in order, instead of the per-OS defaults. */
  dirs?: string[];
}

/** Without userinfo in the address: a credential has no place in a URL, and none is returned. */
function withoutUserinfo(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (!url.username && !url.password) return baseUrl;
    url.username = '';
    url.password = '';
    // toString() adds a slash after a bare origin; keep the stored form, which has none.
    const cleaned = url.toString();
    return !baseUrl.endsWith('/') && cleaned.endsWith('/') ? cleaned.slice(0, -1) : cleaned;
  } catch {
    return baseUrl;
  }
}

/**
 * Desktop's saved model servers, read once and never written. `secret` is dropped; a file from a newer
 * Desktop is read as it is. A missing file is not a problem: Desktop may not be installed.
 */
export async function readDesktopModelServers(opts: ReadDesktopOptions = {}): Promise<DesktopModelServers> {
  for (const dir of opts.dirs ?? desktopUserDataDirs(opts)) {
    const file = path.join(dir, FILE_NAME);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      return { servers: [], path: file, problem: `${FILE_NAME} could not be read (${code ?? 'error'}).` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { servers: [], path: file, problem: `${FILE_NAME} is not valid JSON.` };
    }
    const all = (parsed as { servers?: unknown } | null)?.servers;
    if (!Array.isArray(all)) return { servers: [], path: file, problem: `${FILE_NAME} has no server list.` };
    const servers = all.flatMap(value => {
      const record = isStored(value) ? hydrate(value) : null;
      if (!record) return [];
      return [{ ...record, transport: { type: 'http' as const, baseUrl: withoutUserinfo(record.transport.baseUrl) } }];
    });
    return { servers, path: file, problem: null };
  }
  return { servers: [], path: null, problem: null };
}
