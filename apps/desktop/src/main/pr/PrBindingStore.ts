import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PrBinding } from '@shared/pullRequest';

/** Fingerprints kept per PR. Old ones only stop a re-trigger for a failure that cannot recur. */
const MAX_HANDLED = 200;

function normalize(value: unknown): PrBinding | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<PrBinding>;
  if (typeof raw.owner !== 'string' || typeof raw.repo !== 'string' || typeof raw.number !== 'number') return null;
  if (typeof raw.url !== 'string') return null;
  return {
    ...raw,
    owner: raw.owner,
    repo: raw.repo,
    number: raw.number,
    url: raw.url,
    source: raw.source === 'manual' || raw.source === 'branch' ? raw.source : 'shell',
    boundAt: typeof raw.boundAt === 'string' ? raw.boundAt : new Date(0).toISOString(),
    ...(Array.isArray(raw.autoFixHandled) ? { autoFixHandled: raw.autoFixHandled.slice(-MAX_HANDLED) } : {}),
  };
}

/**
 * Each conversation's pull request, in one small file beside the sessions directory.
 *
 * Not in the session file itself, on purpose. A session file is rewritten whole on every change
 * and has no lock (see SessionStore.appendMessage), so a poll updating `lastState` or an
 * auto-fix counter mid-turn could drop a message the turn was appending - and would rewrite
 * hundreds of messages to change one field. Keyed by session id, which is a UUID, so the
 * per-account session scopes cannot collide here.
 *
 * Writes are serialized through one chain so two quick changes cannot interleave their
 * read-modify-write the way two session writes can.
 */
export class PrBindingStore {
  private cache: Map<string, PrBinding> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async all(): Promise<Map<string, PrBinding>> {
    if (this.cache) return this.cache;
    const loaded = new Map<string, PrBinding>();
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, unknown>;
      for (const [sessionId, value] of Object.entries(parsed ?? {})) {
        const binding = normalize(value);
        if (binding) loaded.set(sessionId, binding);
      }
    } catch {
      // Missing or unreadable: no conversation has a PR, which is the safe reading.
    }
    this.cache ??= loaded;
    return this.cache;
  }

  async get(sessionId: string): Promise<PrBinding | null> {
    return (await this.all()).get(sessionId) ?? null;
  }

  async set(sessionId: string, binding: PrBinding | null): Promise<void> {
    const all = await this.all();
    if (binding) {
      const handled = binding.autoFixHandled;
      all.set(
        sessionId,
        handled && handled.length > MAX_HANDLED ? { ...binding, autoFixHandled: handled.slice(-MAX_HANDLED) } : binding
      );
    } else {
      all.delete(sessionId);
    }
    await this.flush();
  }

  async update(sessionId: string, change: (binding: PrBinding) => PrBinding): Promise<PrBinding | null> {
    const current = await this.get(sessionId);
    if (!current) return null;
    const next = change(current);
    await this.set(sessionId, next);
    return next;
  }

  private flush(): Promise<void> {
    const snapshot = JSON.stringify(Object.fromEntries(this.cache ?? []), null, 2);
    this.writing = this.writing
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.tmp`;
        await writeFile(temporary, snapshot, 'utf8');
        await rename(temporary, this.path);
      });
    return this.writing;
  }
}
