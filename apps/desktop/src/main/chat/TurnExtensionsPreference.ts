import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseTurnExtensions } from '@shared/turnExtensionSetting';

/** The Settings cap on automatic turn extensions; app-wide, like auto-fix-attempts.json. */
export class TurnExtensionsPreference {
  private extensions: number | null = null;

  constructor(private readonly filePath: string) {}

  async read(): Promise<number> {
    if (this.extensions !== null) return this.extensions;
    let stored: unknown;
    try {
      stored = (JSON.parse(await readFile(this.filePath, 'utf8')) as { extensions?: unknown } | null)?.extensions;
    } catch {
      stored = undefined;
    }
    this.extensions = parseTurnExtensions(stored);
    return this.extensions;
  }

  async record(next: unknown): Promise<number> {
    const extensions = parseTurnExtensions(next);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ extensions }, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
    this.extensions = extensions;
    return extensions;
  }
}
