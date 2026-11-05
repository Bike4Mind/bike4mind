import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  emptyStoredModelSettings,
  isEmptyModelSettings,
  parseModelSettingsFile,
  storedModelEntry,
  type InvalidModelSetting,
  type ModelSettings,
  type StoredModelSettings,
} from '@shared/modelSettings';

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

function invalidProblem({ modelId, field }: InvalidModelSetting): string {
  return field === null
    ? `has an entry for ${modelId} that is not a set of settings`
    : `has an invalid ${field} for ${modelId}`;
}

/** Per-model defaults from the Models screen, by chat model id; per machine, like local-context.json. */
export class ModelSettingsStore {
  private loaded: Promise<StoredModelSettings> | null = null;
  private writing: Promise<unknown> = Promise.resolve();
  /** The last failure logged, so a file that stays unreadable is logged once rather than on every read. */
  private lastWarning: string | null = null;

  constructor(
    private readonly filePath: string,
    private readonly warn: (message: string) => void = () => {}
  ) {}

  /**
   * A missing file holds no defaults. Any other failure, an unparseable or wrong-shape file or a bad
   * known value included, rejects and is not cached, so a fixed or deleted file is read again next time
   * and set() never writes over a file it could not read.
   */
  private read(): Promise<StoredModelSettings> {
    if (this.loaded) return this.loaded;
    const loading: Promise<StoredModelSettings> = readFile(this.filePath, 'utf8')
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
          if ('invalid' in parsed) throw new ModelSettingsFileError(this.filePath, invalidProblem(parsed.invalid));
          return parsed;
        },
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return emptyStoredModelSettings();
          throw error;
        }
      )
      .then(
        stored => {
          this.lastWarning = null;
          return stored;
        },
        (error: unknown) => {
          const warning = `MODEL SETTINGS: could not read ${this.filePath}: ${String(error)}`;
          if (warning !== this.lastWarning) this.warn(warning);
          this.lastWarning = warning;
          if (this.loaded === loading) this.loaded = null;
          throw error;
        }
      );
    this.loaded = loading;
    return loading;
  }

  /** Rejects when the file cannot be read or parsed, so neither the Models screen nor a turn takes blanks for it. */
  async get(modelId: string): Promise<ModelSettings> {
    return (await this.read()).settings.get(modelId) ?? {};
  }

  /**
   * Replaces one model's defaults; an empty set removes them. Fields and entries Desktop does not know
   * (a newer version's) are written back as they were. Writes run one at a time.
   */
  set(modelId: string, settings: ModelSettings): Promise<ModelSettings> {
    const done = this.writing.then(async () => {
      const stored = await this.read();
      const updated = new Map(stored.settings);
      const entries = new Map(stored.entries);
      if (isEmptyModelSettings(settings)) updated.delete(modelId);
      else updated.set(modelId, settings);
      const entry = storedModelEntry(entries.get(modelId), settings);
      if (entry) entries.set(modelId, entry);
      else entries.delete(modelId);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      const text = JSON.stringify({ ...stored.rest, models: Object.fromEntries(entries) }, null, 2);
      try {
        await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, this.filePath);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      this.loaded = Promise.resolve({ settings: updated, entries, rest: stored.rest });
      return settings;
    });
    this.writing = done.catch(() => undefined);
    return done;
  }
}
