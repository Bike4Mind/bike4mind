import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ModelVersion, ModelVersionEntry } from '@shared/model3d';

/** How many versions a conversation keeps; recording past it prunes the oldest. */
export const MODEL_VERSION_CAP = 30;

/** Sources above this are not kept: a model file is a few KB, and the index is rewritten per build. */
export const MODEL_VERSION_MAX_SOURCE_BYTES = 512 * 1024;

/** A thumbnail above this is dropped (the version is still kept); the pane renders them at 192 px. */
export const MODEL_VERSION_MAX_THUMBNAIL_BYTES = 1024 * 1024;

const versionSchema = z.object({
  number: z.number().int().positive(),
  path: z.string().min(1),
  source: z.string(),
  jointAngles: z.record(z.string(), z.number()),
  createdAt: z.number(),
  note: z.string().optional(),
  restoredFrom: z.number().int().positive().optional(),
});

const indexSchema = z.object({
  /** The number the next version gets; kept apart from the list so pruning never reuses one. */
  next: z.number().int().positive(),
  versions: z.array(versionSchema),
});

type VersionIndex = z.infer<typeof indexSchema>;

const EMPTY_INDEX: VersionIndex = { next: 1, versions: [] };

export type ModelVersionInput = {
  path: string;
  source: string;
  jointAngles: Record<string, number>;
  thumbnail: Uint8Array | null;
  note?: string;
  restoredFrom?: number;
};

export type ModelVersionStoreOptions = {
  cap?: number;
  now?: () => number;
  warn?: (message: string) => void;
};

/** Session ids are app-made, but they still become a folder name: anything unusual is hashed. */
function folderName(sessionId: string): string {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return sessionId;
  return createHash('sha256').update(sessionId).digest('hex');
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Every conversation's kept model builds, under `<root>/<session>/`: `versions.json` (the list,
 * sources included) and one `v<n>.png` thumbnail per version. Written the way the rest of userData
 * is (temp file then rename, owner-only), and serialised per conversation so two windows reporting
 * the same build cannot interleave. History only grows: a restore is recorded as a new version by
 * whoever restored it (ModelLiveView), and only the cap removes old ones.
 */
export class ModelVersionStore {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly cap: number;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;

  constructor(
    private readonly root: string,
    options: ModelVersionStoreOptions = {}
  ) {
    this.cap = Math.max(1, options.cap ?? MODEL_VERSION_CAP);
    this.now = options.now ?? Date.now;
    this.warn = options.warn ?? (message => console.warn(message));
  }

  /** Oldest first. */
  list(sessionId: string): Promise<ModelVersion[]> {
    return this.serial(sessionId, async () => (await this.readIndex(sessionId)).versions);
  }

  /** Oldest first, each with its thumbnail. */
  listWithThumbnails(sessionId: string): Promise<ModelVersionEntry[]> {
    return this.serial(sessionId, async () => {
      const { versions } = await this.readIndex(sessionId);
      return Promise.all(
        versions.map(async version => ({
          ...version,
          thumbnail: await readFile(this.thumbnailPath(sessionId, version.number)).then(
            bytes => new Uint8Array(bytes),
            () => null
          ),
        }))
      );
    });
  }

  get(sessionId: string, number: number): Promise<ModelVersion | null> {
    return this.serial(
      sessionId,
      async () => (await this.readIndex(sessionId)).versions.find(version => version.number === number) ?? null
    );
  }

  /**
   * Keeps a build. Returns null, keeping nothing, when it is the same file and source as the newest
   * version (a window reopening the model, a second window reporting the same save) or the source is
   * too large to keep.
   */
  record(sessionId: string, input: ModelVersionInput): Promise<ModelVersion | null> {
    return this.serial(sessionId, async () => {
      if (Buffer.byteLength(input.source, 'utf8') > MODEL_VERSION_MAX_SOURCE_BYTES) return null;
      const index = await this.readIndex(sessionId);
      const newest = index.versions.at(-1);
      if (newest && newest.path === input.path && newest.source === input.source) return null;
      const version: ModelVersion = {
        number: index.next,
        path: input.path,
        source: input.source,
        jointAngles: { ...input.jointAngles },
        createdAt: this.now(),
        ...(input.note ? { note: input.note } : {}),
        ...(input.restoredFrom ? { restoredFrom: input.restoredFrom } : {}),
      };
      const kept = [...index.versions, version];
      const pruned = kept.splice(0, Math.max(0, kept.length - this.cap));
      await mkdir(this.folder(sessionId), { recursive: true, mode: 0o700 });
      if (input.thumbnail && input.thumbnail.length <= MODEL_VERSION_MAX_THUMBNAIL_BYTES) {
        await this.writeAtomic(this.thumbnailPath(sessionId, version.number), input.thumbnail);
      }
      await this.writeAtomic(this.indexPath(sessionId), JSON.stringify({ next: version.number + 1, versions: kept }));
      // After the index no longer lists them, so a failed delete leaves a stray file, never a hole.
      for (const old of pruned) {
        await rm(this.thumbnailPath(sessionId, old.number), { force: true }).catch(error =>
          this.warn(`MODEL: could not remove the thumbnail of ${old.number}: ${String(error)}`)
        );
      }
      return version;
    });
  }

  /** Drops a deleted conversation's history. */
  remove(sessionId: string): Promise<void> {
    return this.serial(sessionId, () => rm(this.folder(sessionId), { recursive: true, force: true }));
  }

  private folder(sessionId: string): string {
    return join(this.root, folderName(sessionId));
  }

  private indexPath(sessionId: string): string {
    return join(this.folder(sessionId), 'versions.json');
  }

  private thumbnailPath(sessionId: string, number: number): string {
    return join(this.folder(sessionId), `v${number}.png`);
  }

  private async readIndex(sessionId: string): Promise<VersionIndex> {
    let text: string;
    try {
      text = await readFile(this.indexPath(sessionId), 'utf8');
    } catch (error) {
      if (isMissing(error)) return EMPTY_INDEX;
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
    const parsed = indexSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    // Unreadable history is set aside rather than overwritten, so it can still be recovered by hand.
    const aside = `${this.indexPath(sessionId)}.corrupt-${this.now()}`;
    await rename(this.indexPath(sessionId), aside).catch(() => undefined);
    this.warn(`MODEL: version history was unreadable and was moved to ${aside}`);
    return EMPTY_INDEX;
  }

  private async writeAtomic(target: string, contents: string | Uint8Array): Promise<void> {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private serial<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(sessionId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.catch(() => undefined);
    this.chains.set(sessionId, settled);
    void settled.then(() => {
      if (this.chains.get(sessionId) === settled) this.chains.delete(sessionId);
    });
    return run;
  }
}
