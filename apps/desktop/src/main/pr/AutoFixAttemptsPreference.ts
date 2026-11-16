import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseAutoFixAttempts } from '@shared/autoFixSetting';

/** The Settings choice of auto-fix attempts per PR; app-wide, like local-context.json. */
export class AutoFixAttemptsPreference {
  private attempts: number | null = null;

  constructor(private readonly filePath: string) {}

  async read(): Promise<number> {
    if (this.attempts !== null) return this.attempts;
    let stored: unknown;
    try {
      stored = (JSON.parse(await readFile(this.filePath, 'utf8')) as { attempts?: unknown } | null)?.attempts;
    } catch {
      stored = undefined;
    }
    this.attempts = parseAutoFixAttempts(stored);
    return this.attempts;
  }

  async record(next: unknown): Promise<number> {
    const attempts = parseAutoFixAttempts(next);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ attempts }, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
    this.attempts = attempts;
    return attempts;
  }
}
