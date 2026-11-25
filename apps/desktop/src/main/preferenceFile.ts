import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * A small JSON preference file owned by main, written atomically and owner-only. Reads are served
 * from memory after `load`, so a window can ask for its bounds synchronously while it is created.
 * `parse` must accept anything (a missing file, a hand edit, an older shape) and fall back field by
 * field rather than throwing.
 */
export class PreferenceFile<T> {
  private value: T;
  // Serialised so a burst of bound saves lands in order and never interleaves two renames.
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly parse: (value: unknown) => T,
    private readonly logLabel: string
  ) {
    this.value = parse(undefined);
  }

  async load(): Promise<T> {
    let stored: unknown;
    try {
      stored = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch {
      stored = undefined;
    }
    this.value = this.parse(stored);
    return this.value;
  }

  current(): T {
    return this.value;
  }

  update(patch: Partial<T>): Promise<T> {
    this.value = this.parse({ ...this.value, ...patch });
    const snapshot = this.value;
    this.writes = this.writes
      .then(() => this.write(snapshot))
      .catch((error: unknown) => {
        console.warn(`${this.logLabel}: could not save preferences: ${String(error)}`);
      });
    return this.writes.then(() => snapshot);
  }

  private async write(value: T): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
