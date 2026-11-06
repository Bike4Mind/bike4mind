import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isEmptyModelSettings, parseModelSettingsFile, type ModelSettings } from '@shared/modelSettings';

/** Per-model defaults from the Models screen, by chat model id; per machine, like local-context.json. */
export class ModelSettingsStore {
  private loaded: Promise<Map<string, ModelSettings>> | null = null;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly warn: (message: string) => void = () => {}
  ) {}

  /**
   * A missing file holds no defaults; an unparseable one is moved aside to .corrupt and holds none
   * either. Any other failure, including a failed move, rejects and is not cached, so a later read
   * retries and set() never overwrites a file that could not be set aside.
   */
  private read(): Promise<Map<string, ModelSettings>> {
    if (this.loaded) return this.loaded;
    const loading: Promise<Map<string, ModelSettings>> = readFile(this.filePath, 'utf8')
      .then(
        async text => {
          let parsed: Map<string, ModelSettings> | null = null;
          try {
            parsed = parseModelSettingsFile(JSON.parse(text));
          } catch {
            parsed = null;
          }
          if (parsed) return parsed;
          this.warn(`MODEL SETTINGS: moving aside an unreadable ${this.filePath}`);
          await rename(this.filePath, `${this.filePath}.corrupt`).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
          return new Map<string, ModelSettings>();
        },
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return new Map<string, ModelSettings>();
          throw error;
        }
      )
      .catch((error: unknown) => {
        this.warn(`MODEL SETTINGS: could not read ${this.filePath}: ${String(error)}`);
        if (this.loaded === loading) this.loaded = null;
        throw error;
      });
    this.loaded = loading;
    return loading;
  }

  /** For a turn's sampling and effort defaults: a file that cannot be read or parsed holds no defaults. */
  async get(modelId: string): Promise<ModelSettings> {
    return (await this.read().catch(() => new Map<string, ModelSettings>())).get(modelId) ?? {};
  }

  /**
   * For the Models screen and a request's load settings: rejects on an unreadable file, so the screen
   * can say so and a request does not reload the model at the wrong size.
   */
  async getStrict(modelId: string): Promise<ModelSettings> {
    return (await this.read()).get(modelId) ?? {};
  }

  /** Replaces one model's defaults; an empty set removes them. Writes run one at a time. */
  set(modelId: string, settings: ModelSettings): Promise<ModelSettings> {
    const done = this.writing.then(async () => {
      const updated = new Map(await this.read());
      if (isEmptyModelSettings(settings)) updated.delete(modelId);
      else updated.set(modelId, settings);
      await mkdir(dirname(this.filePath), { recursive: true });
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
