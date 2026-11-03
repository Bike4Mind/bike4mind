import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseModelSettingsFile, type ModelSettings } from '@shared/modelSettings';

function isEmpty(settings: ModelSettings): boolean {
  return settings.generation === undefined && settings.effort === undefined;
}

/** Per-model defaults from the Models screen, by chat model id; per machine, like local-context.json. */
export class ModelSettingsStore {
  private loaded: Promise<Map<string, ModelSettings>> | null = null;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly warn: (message: string) => void = () => {}
  ) {}

  /** A missing or unreadable file holds no defaults, so chat goes on without them. */
  private read(): Promise<Map<string, ModelSettings>> {
    this.loaded ??= readFile(this.filePath, 'utf8').then(
      text => {
        try {
          return parseModelSettingsFile(JSON.parse(text));
        } catch (error) {
          this.warn(`MODEL SETTINGS: ignoring an unreadable ${this.filePath}: ${String(error)}`);
          return new Map<string, ModelSettings>();
        }
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') this.warn(`MODEL SETTINGS: could not read ${this.filePath}: ${String(error)}`);
        return new Map<string, ModelSettings>();
      }
    );
    return this.loaded;
  }

  async get(modelId: string): Promise<ModelSettings> {
    return (await this.read()).get(modelId) ?? {};
  }

  /** Replaces one model's defaults; an empty set removes them. Writes run one at a time. */
  set(modelId: string, settings: ModelSettings): Promise<ModelSettings> {
    const done = this.writing.then(async () => {
      const updated = new Map(await this.read());
      if (isEmpty(settings)) updated.delete(modelId);
      else updated.set(modelId, settings);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      const text = JSON.stringify({ models: Object.fromEntries(updated) }, null, 2);
      await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.filePath);
      this.loaded = Promise.resolve(updated);
      return settings;
    });
    this.writing = done.catch(() => undefined);
    return done;
  }
}
