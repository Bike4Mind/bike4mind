import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isEmptyModelSettings, parseModelSettingsFile, type ModelSettings } from '@shared/modelSettings';

/** A settings file that exists but cannot be used; the message names it and says how to recover. */
export class ModelSettingsFileError extends Error {
  constructor(
    readonly filePath: string,
    problem: string
  ) {
    super(
      `The model settings file ${filePath} ${problem}. Fix it, or delete it to clear the saved settings of every model.`
    );
    this.name = 'ModelSettingsFileError';
  }
}

/** Per-model defaults from the Models screen, by chat model id; per machine, like local-context.json. */
export class ModelSettingsStore {
  private loaded: Promise<Map<string, ModelSettings>> | null = null;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly warn: (message: string) => void = () => {}
  ) {}

  /**
   * A missing file holds no defaults. Any other failure, an unparseable or wrong-shape file included,
   * rejects and is not cached, so a fixed or deleted file is read again next time and set() never
   * writes over a file it could not read.
   */
  private read(): Promise<Map<string, ModelSettings>> {
    if (this.loaded) return this.loaded;
    const loading: Promise<Map<string, ModelSettings>> = readFile(this.filePath, 'utf8')
      .then(
        text => {
          let raw: unknown;
          try {
            raw = JSON.parse(text);
          } catch {
            throw new ModelSettingsFileError(this.filePath, 'is not valid JSON');
          }
          const parsed = parseModelSettingsFile(raw);
          if (!parsed) throw new ModelSettingsFileError(this.filePath, 'does not hold model settings');
          return parsed;
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

  /** Rejects when the file cannot be read or parsed, so neither the Models screen nor a turn takes blanks for it. */
  async get(modelId: string): Promise<ModelSettings> {
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
