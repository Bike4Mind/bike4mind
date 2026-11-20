import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_NOTIFY_SCOPE, parseNotifyScope, type NotifyScope } from '@shared/attention';

/**
 * The needs-you notify scope (attention-preferences.json), written the way WatchPreferencesStore
 * writes its file: atomically, owner-only. Served from memory after `load`, so the monitor reads it
 * synchronously on every status event.
 */
export class NotifyScopeStore {
  private value: NotifyScope = DEFAULT_NOTIFY_SCOPE;
  // Serialised so two quick toggles land in order and never interleave two renames.
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<NotifyScope> {
    try {
      const stored: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      const record = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
      this.value = parseNotifyScope(record.notifyScope) ?? DEFAULT_NOTIFY_SCOPE;
    } catch {
      // Missing or unreadable: the default, as on a first launch.
      this.value = DEFAULT_NOTIFY_SCOPE;
    }
    return this.value;
  }

  current(): NotifyScope {
    return this.value;
  }

  set(scope: NotifyScope): Promise<NotifyScope> {
    this.value = scope;
    this.writes = this.writes
      .then(() => this.write(scope))
      .catch((error: unknown) => {
        console.warn(`ATTENTION: could not save the notify scope: ${String(error)}`);
      });
    return this.writes.then(() => scope);
  }

  private async write(scope: NotifyScope): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ notifyScope: scope }, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
