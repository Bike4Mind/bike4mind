import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseModelSettingsFile, type ModelSettings } from '@shared/modelSettings';

function isEmpty(settings: ModelSettings): boolean {
  return settings.generation === undefined && settings.effort === undefined;
}

/** Per-model defaults from the Models screen, by chat model id; per machine, like local-context.json. */
export class ModelSettingsStore {
  private loaded: Promise<Map<string, ModelSettings>> | null = null;
  private writing: Promise<unknown> = Promise.resolve();
  private corrupt = false;

  constructor(
    private readonly filePath: string,
    private readonly warn: (message: string) => void = () => {}
  ) {}

  /**
   * A missing or unparseable file holds no defaults. Any other read failure rejects and is not
   * cached, so a later read retries and set() never rewrites the file from a partial view.
   */
  private read(): Promise<Map<string, ModelSettings>> {
    if (this.loaded) return this.loaded;
    const loading: Promise<Map<string, ModelSettings>> = readFile(this.filePath, 'utf8').then(
      text => {
        try {
          const parsed = parseModelSettingsFile(JSON.parse(text));
          if (!parsed) throw new Error('not a model settings file');
          return parsed;
        } catch (error) {
          this.warn(`MODEL SETTINGS: ignoring an unreadable ${this.filePath}: ${String(error)}`);
          this.corrupt = true;
          return new Map<string, ModelSettings>();
        }
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return new Map<string, ModelSettings>();
        this.warn(`MODEL SETTINGS: could not read ${this.filePath}: ${String(error)}`);
        if (this.loaded === loading) this.loaded = null;
        throw error;
      }
    );
    this.loaded = loading;
    return loading;
  }

  /** For chat turns: a file that cannot be read or parsed holds no defaults. */
  async get(modelId: string): Promise<ModelSettings> {
    return (await this.read().catch(() => new Map<string, ModelSettings>())).get(modelId) ?? {};
  }

  /** For the Models screen: rejects on an unreadable or corrupt file so it can say so instead of showing blanks. */
  async getStrict(modelId: string): Promise<ModelSettings> {
    const settings = await this.read();
    if (this.corrupt) throw new Error(`${this.filePath} is not a valid model settings file`);
    return settings.get(modelId) ?? {};
  }

  /** Replaces one model's defaults; an empty set removes them. Writes run one at a time. */
  set(modelId: string, settings: ModelSettings): Promise<ModelSettings> {
    const done = this.writing.then(async () => {
      const updated = new Map(await this.read());
      if (isEmpty(settings)) updated.delete(modelId);
      else updated.set(modelId, settings);
      await mkdir(dirname(this.filePath), { recursive: true });
      if (this.corrupt) {
        await rename(this.filePath, `${this.filePath}.corrupt`);
        this.corrupt = false;
      }
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      const text = JSON.stringify({ models: Object.fromEntries(updated) }, null, 2);
      try {
        await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, this.filePath);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      this.loaded = Promise.resolve(updated);
      return settings;
    });
    this.writing = done.catch(() => undefined);
    return done;
  }
}
