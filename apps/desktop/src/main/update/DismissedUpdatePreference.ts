import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** The seam UpdateService remembers a dismissal through. */
export interface DismissedUpdateMemory {
  read(): Promise<string | null>;
  record(version: string): Promise<void>;
}

/**
 * The newer version whose "update available" notice the user closed.
 *
 * One version, not a list: dismissing is "not this one", so the next release replaces it and a
 * notice for that release shows again. Same file shape and atomic write as ModelPreference.
 */
export class DismissedUpdatePreference implements DismissedUpdateMemory {
  constructor(private readonly filePath: string) {}

  async read(): Promise<string | null> {
    let stored: unknown;
    try {
      stored = (JSON.parse(await readFile(this.filePath, 'utf8')) as { dismissedVersion?: unknown }).dismissedVersion;
    } catch {
      return null;
    }
    return typeof stored === 'string' && stored.trim() ? stored.trim() : null;
  }

  async record(version: string): Promise<void> {
    const dismissed = version.trim();
    if (!dismissed) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify({ dismissedVersion: dismissed }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
  }
}
