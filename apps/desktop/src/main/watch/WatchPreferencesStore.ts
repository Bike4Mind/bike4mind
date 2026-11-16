import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_WATCH_PREFERENCES, parseWatchPreferences, type WatchPreferences } from '@shared/watch';

/**
 * The menu-bar toggle and the mini Tavern's bounds and visibility (watch-preferences.json), written
 * the way LocalContextPreference writes its file: atomically, owner-only. Reads are served from
 * memory after `load`, so the window can ask for its bounds synchronously while it is created.
 */
export class WatchPreferencesStore {
  private value: WatchPreferences = DEFAULT_WATCH_PREFERENCES;
  // Serialised so a burst of bound saves lands in order and never interleaves two renames.
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<WatchPreferences> {
    let stored: unknown;
    try {
      stored = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch {
      stored = undefined;
    }
    this.value = parseWatchPreferences(stored);
    return this.value;
  }

  current(): WatchPreferences {
    return this.value;
  }

  update(patch: Partial<WatchPreferences>): Promise<WatchPreferences> {
    this.value = parseWatchPreferences({ ...this.value, ...patch });
    const snapshot = this.value;
    this.writes = this.writes
      .then(() => this.write(snapshot))
      .catch((error: unknown) => {
        console.warn(`WATCH: could not save preferences: ${String(error)}`);
      });
    return this.writes.then(() => snapshot);
  }

  private async write(value: WatchPreferences): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
