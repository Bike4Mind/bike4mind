import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** When this source was last checked, and how far back a fetched list may go; times are ms since the epoch. */
export interface CuratedCheckState {
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  /** Consecutive failed or rejected checks; drives the backoff. */
  failures: number;
  /** Highest accepted sequence per signer key id, so revoking a key also drops the floor its lists set. */
  floors: Record<string, number>;
}

export interface CuratedCopy {
  manifest: Uint8Array;
  signature: Uint8Array;
}

/** `intact` is false when revoked-keys.json exists but could not be read whole, so ids may be missing. */
export interface CuratedRevoked {
  ids: Set<string>;
  intact: boolean;
}

const EMPTY_STATE: CuratedCheckState = { lastSuccessAt: null, lastAttemptAt: null, failures: 0, floors: {} };
const MAX_REVOKED = 256;
const MAX_FLOORS = 16;
const KEY_ID = /^[0-9a-f]{16}$/;
const POINTER = 'pair.json';
const PAIR_DIR = /^pair-\d+-[0-9a-f]{12}$/;
const MANIFEST = 'curated-v2.json';
const SIGNATURE = 'curated-v2.json.sig';

const time = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const unique = () => `${process.pid}-${randomBytes(6).toString('hex')}`;

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

async function writeSynced(path: string, data: string | Uint8Array): Promise<void> {
  const handle = await open(path, 'w', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDir(dir: string): Promise<void> {
  // Windows cannot open a directory to flush it; NTFS journals the rename itself.
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** mkdir -p, then flushes the parent of every directory it created so the new entries survive a crash. */
async function makeDir(dir: string): Promise<void> {
  const created = await mkdir(dir, { recursive: true });
  if (!created) return;
  for (let current = dir; ; current = dirname(current)) {
    await syncDir(dirname(current));
    if (current === created || dirname(current) === current) return;
  }
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${unique()}.tmp`;
  try {
    await writeSynced(temporary, data);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await syncDir(dirname(path));
}

function floors(raw: unknown): Record<string, number> {
  const parsed: Record<string, number> = {};
  if (typeof raw !== 'object' || raw === null) return parsed;
  for (const [keyId, sequence] of Object.entries(raw).slice(0, MAX_FLOORS))
    if (KEY_ID.test(keyId) && typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence >= 1)
      parsed[keyId] = sequence;
  return parsed;
}

/**
 * The curated list's files under `userData/model-hub/curated/`: the sticky revoked-key set, the on/off setting,
 * and per source (`<sha256(url)[0:16]>/`) the check state and the last verified pair, behind a pointer file.
 */
export class CuratedStore {
  constructor(private readonly root: string) {}

  static sourceKey(url: string): string {
    return createHash('sha256').update(url).digest('hex').slice(0, 16);
  }

  #dir(source: string): string {
    return join(this.root, source);
  }

  async #pair(source: string): Promise<string | null> {
    const raw = await readJson(join(this.#dir(source), POINTER));
    const name = typeof raw === 'object' && raw !== null ? (raw as { dir?: unknown }).dir : null;
    return typeof name === 'string' && PAIR_DIR.test(name) ? name : null;
  }

  async #prune(source: string, keep: string | null): Promise<void> {
    const current = await this.#pair(source);
    const entries = await readdir(this.#dir(source)).catch(() => [] as string[]);
    for (const entry of entries)
      if (PAIR_DIR.test(entry) && entry !== keep && entry !== current)
        await rm(join(this.#dir(source), entry), { recursive: true, force: true });
  }

  async readCopy(source: string): Promise<CuratedCopy | null> {
    const pair = await this.#pair(source);
    if (!pair) return null;
    try {
      const [manifest, signature] = await Promise.all([
        readFile(join(this.#dir(source), pair, MANIFEST)),
        readFile(join(this.#dir(source), pair, SIGNATURE)),
      ]);
      return { manifest: new Uint8Array(manifest), signature: new Uint8Array(signature) };
    } catch {
      return null;
    }
  }

  /** Writes the pair into a new directory, then switches the pointer, so a crash leaves the old pair or the new. */
  async writeCopy(source: string, copy: CuratedCopy): Promise<void> {
    const pair = `pair-${unique()}`;
    const dir = join(this.#dir(source), pair);
    await makeDir(dir);
    try {
      await writeSynced(join(dir, MANIFEST), copy.manifest);
      await writeSynced(join(dir, SIGNATURE), copy.signature);
      await syncDir(dir);
      await writeAtomic(join(this.#dir(source), POINTER), JSON.stringify({ dir: pair }));
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    await this.#prune(source, pair);
  }

  async deleteCopy(source: string): Promise<void> {
    await rm(join(this.#dir(source), POINTER), { force: true });
    await this.#prune(source, null);
  }

  async readState(source: string): Promise<CuratedCheckState> {
    const raw = await readJson(join(this.#dir(source), 'state.json'));
    if (typeof raw !== 'object' || raw === null) return { ...EMPTY_STATE, floors: {} };
    const { lastSuccessAt, lastAttemptAt, failures } = raw as Record<string, unknown>;
    return {
      lastSuccessAt: time(lastSuccessAt),
      lastAttemptAt: time(lastAttemptAt),
      failures: typeof failures === 'number' && Number.isInteger(failures) && failures > 0 ? Math.min(failures, 64) : 0,
      floors: floors((raw as Record<string, unknown>).floors),
    };
  }

  async writeState(source: string, state: CuratedCheckState): Promise<void> {
    await makeDir(this.#dir(source));
    await writeAtomic(join(this.#dir(source), 'state.json'), JSON.stringify(state));
  }

  /** A missing file is an intact empty set; an unreadable one keeps whatever valid ids it still holds. */
  async readRevoked(): Promise<CuratedRevoked> {
    let text: string;
    try {
      text = await readFile(join(this.root, 'revoked-keys.json'), 'utf8');
    } catch (error) {
      return { ids: new Set(), intact: (error as NodeJS.ErrnoException).code === 'ENOENT' };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { ids: new Set(), intact: false };
    }
    if (!Array.isArray(raw)) return { ids: new Set(), intact: false };
    const ids = raw.filter((id): id is string => typeof id === 'string' && KEY_ID.test(id));
    return { ids: new Set(ids.slice(0, MAX_REVOKED)), intact: ids.length === raw.length && ids.length <= MAX_REVOKED };
  }

  /** Append-only: saves `ids` with the readable ids already on disk; a revocation is never undone. */
  async addRevoked(ids: Iterable<string>): Promise<Set<string>> {
    const { ids: revoked, intact } = await this.readRevoked();
    const before = revoked.size;
    for (const id of ids) if (revoked.size < MAX_REVOKED && KEY_ID.test(id)) revoked.add(id);
    if (revoked.size !== before || !intact) {
      await makeDir(this.root);
      await writeAtomic(join(this.root, 'revoked-keys.json'), JSON.stringify([...revoked]));
    }
    return revoked;
  }

  /** Whether the user lets Desktop check for an updated list; on unless turned off. */
  async readEnabled(): Promise<boolean> {
    const raw = await readJson(join(this.root, 'settings.json'));
    return !(typeof raw === 'object' && raw !== null && (raw as { enabled?: unknown }).enabled === false);
  }

  async writeEnabled(enabled: boolean): Promise<void> {
    await makeDir(this.root);
    await writeAtomic(join(this.root, 'settings.json'), JSON.stringify({ enabled }));
  }
}
