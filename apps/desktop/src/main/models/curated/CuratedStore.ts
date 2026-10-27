import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** When this source was last checked; times are ms since the epoch. */
export interface CuratedCheckState {
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  /** Consecutive failed or rejected checks; drives the backoff. */
  failures: number;
}

export interface CuratedCopy {
  manifest: Uint8Array;
  signature: Uint8Array;
}

const EMPTY_STATE: CuratedCheckState = { lastSuccessAt: null, lastAttemptAt: null, failures: 0 };
const MAX_REVOKED = 256;

const time = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * The curated list's files under `userData/model-hub/curated/`: the sticky revoked-key set, the on/off setting,
 * and per source (`<sha256(url)[0:16]>/`) the last verified bytes, their signature file and the check state.
 */
export class CuratedStore {
  constructor(private readonly root: string) {}

  static sourceKey(url: string): string {
    return createHash('sha256').update(url).digest('hex').slice(0, 16);
  }

  #dir(source: string): string {
    return join(this.root, source);
  }

  async readCopy(source: string): Promise<CuratedCopy | null> {
    try {
      const [manifest, signature] = await Promise.all([
        readFile(join(this.#dir(source), 'curated-v2.json')),
        readFile(join(this.#dir(source), 'curated-v2.json.sig')),
      ]);
      return { manifest: new Uint8Array(manifest), signature: new Uint8Array(signature) };
    } catch {
      return null;
    }
  }

  async writeCopy(source: string, copy: CuratedCopy): Promise<void> {
    await mkdir(this.#dir(source), { recursive: true });
    await writeAtomic(join(this.#dir(source), 'curated-v2.json'), copy.manifest);
    await writeAtomic(join(this.#dir(source), 'curated-v2.json.sig'), copy.signature);
  }

  async deleteCopy(source: string): Promise<void> {
    await rm(join(this.#dir(source), 'curated-v2.json'), { force: true });
    await rm(join(this.#dir(source), 'curated-v2.json.sig'), { force: true });
  }

  async readState(source: string): Promise<CuratedCheckState> {
    const raw = await readJson(join(this.#dir(source), 'state.json'));
    if (typeof raw !== 'object' || raw === null) return { ...EMPTY_STATE };
    const { lastSuccessAt, lastAttemptAt, failures } = raw as Record<string, unknown>;
    return {
      lastSuccessAt: time(lastSuccessAt),
      lastAttemptAt: time(lastAttemptAt),
      failures: typeof failures === 'number' && Number.isInteger(failures) && failures > 0 ? Math.min(failures, 64) : 0,
    };
  }

  async writeState(source: string, state: CuratedCheckState): Promise<void> {
    await mkdir(this.#dir(source), { recursive: true });
    await writeAtomic(join(this.#dir(source), 'state.json'), JSON.stringify(state));
  }

  async readRevoked(): Promise<Set<string>> {
    const raw = await readJson(join(this.root, 'revoked-keys.json'));
    const ids = Array.isArray(raw) ? raw.filter(id => typeof id === 'string' && /^[0-9a-f]{16}$/.test(id)) : [];
    return new Set(ids.slice(0, MAX_REVOKED));
  }

  /** Append-only: a revocation is never undone, whatever a later list says. */
  async addRevoked(ids: readonly string[]): Promise<Set<string>> {
    const revoked = await this.readRevoked();
    const before = revoked.size;
    for (const id of ids) if (revoked.size < MAX_REVOKED) revoked.add(id);
    if (revoked.size !== before) {
      await mkdir(this.root, { recursive: true });
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
    await mkdir(this.root, { recursive: true });
    await writeAtomic(join(this.root, 'settings.json'), JSON.stringify({ enabled }));
  }
}
