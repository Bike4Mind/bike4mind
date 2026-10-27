import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseLocalContextSetting, type LocalContextSetting } from '@shared/localContextSetting';

/** The Settings choice of local model context size; app-wide, like approval-mode.json. */
export class LocalContextPreference {
  private setting: LocalContextSetting | null = null;

  constructor(private readonly filePath: string) {}

  async read(): Promise<LocalContextSetting> {
    if (this.setting) return this.setting;
    let stored: unknown;
    try {
      stored = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch {
      stored = undefined;
    }
    this.setting = parseLocalContextSetting(stored);
    return this.setting;
  }

  async record(next: unknown): Promise<LocalContextSetting> {
    const setting = parseLocalContextSetting(next);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(setting, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
    this.setting = setting;
    return setting;
  }
}
