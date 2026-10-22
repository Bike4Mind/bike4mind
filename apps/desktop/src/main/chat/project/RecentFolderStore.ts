import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { RecentFolder } from '@shared/chat';

/** About what fits in the folder menu before it needs to scroll. */
export const RECENT_FOLDER_LIMIT = 10;

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The folders Code sessions were recently grounded in, most recent first, for the folder chip's menu.
 *
 * A folder that has gone missing is hidden from `list` but kept on disk: an unmounted volume or
 * a branch switch that removed a directory is often temporary, and the entry comes back with it.
 * It still ages out under the cap like any other.
 *
 * App-wide rather than per account, like the other preference files beside it: the folders are
 * this machine's, whichever backend the session talks to.
 */
export class RecentFolderStore {
  /** undefined until the file has been read once. */
  private folders: string[] | undefined;
  /** Writes in call order, so a record racing a remove cannot land the older list last. */
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly limit = RECENT_FOLDER_LIMIT
  ) {}

  /** The remembered folders that still exist, most recent first. */
  async list(): Promise<RecentFolder[]> {
    const folders = await this.load();
    const present = await Promise.all(folders.map(isDirectory));
    return folders.filter((_, index) => present[index]).map(path => ({ path, name: basename(path) || path }));
  }

  /** Move `directory` to the front, deduplicated by its resolved path. */
  record(directory: string): Promise<void> {
    if (!directory.trim()) return this.pending;
    const path = resolve(directory);
    return this.update(folders => [path, ...folders.filter(entry => entry !== path)].slice(0, this.limit));
  }

  remove(directory: string): Promise<void> {
    if (!directory.trim()) return this.pending;
    const path = resolve(directory);
    return this.update(folders => folders.filter(entry => entry !== path));
  }

  private update(change: (folders: string[]) => string[]): Promise<void> {
    const write = this.pending.then(async () => {
      this.folders = change(await this.load());
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, JSON.stringify({ folders: this.folders }, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporary, this.filePath);
    });
    // A failed write must not wedge every later one behind it; the caller still sees the failure.
    this.pending = write.catch(() => undefined);
    return write;
  }

  private async load(): Promise<string[]> {
    if (this.folders) return this.folders;
    let stored: unknown;
    try {
      stored = (JSON.parse(await readFile(this.filePath, 'utf8')) as { folders?: unknown }).folders;
    } catch {
      stored = undefined;
    }
    const valid = Array.isArray(stored)
      ? stored.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
      : [];
    this.folders = [...new Set(valid.map(entry => resolve(entry)))].slice(0, this.limit);
    return this.folders;
  }
}
