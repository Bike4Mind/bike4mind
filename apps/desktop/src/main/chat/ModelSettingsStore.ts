import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  emptyStoredModelSettings,
  parseModelSettingsFile,
  changedJsonPath,
  quotedForMessage,
  storedModelEntry,
  type ModelSettings,
  type StoredModelSettings,
  type UnsupportedModelSetting,
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

function invalidProblem(modelId: string, field: string | null): string {
  const model = quotedForMessage(modelId);
  return field === null
    ? `has an entry for ${model} that is not a set of settings`
    : `has an invalid ${quotedForMessage(field)} for ${model}`;
}

/** `path` leads from the file's root to a value a JSON round trip changed, which only a non-finite number does. */
function unwritableProblem(path: string[]): string {
  const [top, modelId, ...field] = path;
  const where =
    top === 'models' && modelId !== undefined
      ? `${field.length > 0 ? `in ${quotedForMessage(field.join('.'))} ` : ''}for ${quotedForMessage(modelId)}`
      : `in ${quotedForMessage(path.join('.'))}`;
  return `has a number ${where} too large to save back as written`;
}

/** The file as read, with the size and modification time it had then, or null when it did not exist. */
interface Loaded {
  stored: StoredModelSettings;
  stamp: string | null;
}

/** Per-model defaults from the Models screen, by chat model id; per machine, like local-context.json. */
export class ModelSettingsStore {
  private loaded: Promise<Loaded> | null = null;
  private writing: Promise<unknown> = Promise.resolve();
  /** The last failure logged, so a file that stays unreadable is logged once rather than on every read. */
  private lastWarning: string | null = null;
  private readonly logged = new Set<string>();

  constructor(
    private readonly filePath: string,
    private readonly warn: (message: string) => void = () => {}
  ) {}

  /** Null for a missing file; a stat that fails otherwise gets a stamp nothing matches, so the file is read again. */
  private async stamp(path = this.filePath): Promise<string | null> {
    try {
      const stats = await stat(path);
      return `${stats.mtimeMs}:${stats.size}`;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : `unreadable:${randomUUID()}`;
    }
  }

  /**
   * A missing file holds no defaults. Any other failure, an unparseable or wrong-shape file, rejects and
   * is not cached, so a fixed or deleted file is read again next time and set() never writes over a file
   * it could not read. A model whose own entry is broken fails alone, in entryError.
   */
  private read(): Promise<Loaded> {
    if (this.loaded) return this.loaded;
    // Stamped before the read, so an edit landing between the two only makes current() read again.
    const loading: Promise<Loaded> = this.stamp()
      .then(async stamp => ({ stamp, text: await readFile(this.filePath, 'utf8') }))
      .then(
        ({ stamp, text }) => {
          let raw: unknown;
          try {
            raw = JSON.parse(text);
          } catch {
            throw new ModelSettingsFileError(this.filePath, 'is not valid JSON');
          }
          const parsed = parseModelSettingsFile(raw);
          if (!parsed) throw new ModelSettingsFileError(this.filePath, 'does not hold model settings');
          return { stored: parsed, stamp };
        },
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return { stored: emptyStoredModelSettings(), stamp: null };
          throw error;
        }
      )
      .then(
        loaded => {
          this.lastWarning = null;
          this.logEntries(loaded.stored);
          return loaded;
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

  private logOnce(key: string, message: string): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.warn(message);
  }

  private logEntries(stored: StoredModelSettings): void {
    for (const [modelId, field] of stored.invalid) {
      this.logOnce(
        JSON.stringify(['invalid', modelId, field]),
        `MODEL SETTINGS: ${this.entryError(stored, modelId)?.message}`
      );
    }
    for (const [modelId, values] of stored.unsupported) {
      for (const { field, value } of values) {
        this.logOnce(
          JSON.stringify(['unsupported', modelId, field, value]),
          `MODEL SETTINGS: ${this.filePath} holds ${field} ${quotedForMessage(value)} for ${quotedForMessage(modelId)}, which this version of Desktop does not use; it is kept as written.`
        );
      }
    }
  }

  private entryError(stored: StoredModelSettings, modelId: string): ModelSettingsFileError | null {
    const field = stored.invalid.get(modelId);
    return field === undefined ? null : new ModelSettingsFileError(this.filePath, invalidProblem(modelId, field));
  }

  /** The file as it is now: read again once when it changed since it was read, such as by hand while Desktop runs. */
  private async current(): Promise<Loaded> {
    const reading = this.read();
    const loaded = await reading;
    if ((await this.stamp()) === loaded.stamp) return loaded;
    if (this.loaded === reading) this.loaded = null;
    return this.read();
  }

  /** The model's entry as read, rejecting when the file or that model's entry cannot be used. */
  private async readEntry(modelId: string): Promise<StoredModelSettings> {
    const { stored } = await this.current();
    const error = this.entryError(stored, modelId);
    if (error) throw error;
    return stored;
  }

  /** Rejects when the file or this model's entry cannot be read, so neither the Models screen nor a turn takes blanks for it. */
  async get(modelId: string): Promise<ModelSettings> {
    return (await this.readEntry(modelId)).settings.get(modelId) ?? {};
  }

  /** The model's stored values this version keeps in the file but does not use, for the Models screen to name. */
  async unsupported(modelId: string): Promise<UnsupportedModelSetting[]> {
    return (await this.readEntry(modelId)).unsupported.get(modelId) ?? [];
  }

  /**
   * Replaces one model's defaults; an empty set removes them. Fields and entries Desktop does not know
   * or support (a newer version's), and other models' broken entries, are written back as they were.
   * Writes run one at a time.
   */
  set(modelId: string, settings: ModelSettings): Promise<ModelSettings> {
    const done = this.writing.then(async () => {
      const { stored } = await this.current();
      const entryError = this.entryError(stored, modelId);
      if (entryError) throw entryError;
      const entries = new Map(stored.entries);
      const entry = storedModelEntry(entries.get(modelId), settings);
      if (entry) entries.set(modelId, entry);
      else entries.delete(modelId);
      const file = { ...stored.rest, models: Object.fromEntries(entries) };
      const text = JSON.stringify(file, null, 2);
      const written: unknown = JSON.parse(text);
      const changed = changedJsonPath(file, written);
      if (changed) throw new ModelSettingsFileError(this.filePath, unwritableProblem(changed));
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      let stamp: string | null;
      try {
        await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
        // A rename keeps the size and modification time, and stamping the target after it could take in an edit.
        stamp = await this.stamp(temporary);
        await rename(temporary, this.filePath);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      const parsed = parseModelSettingsFile(written);
      this.loaded = parsed ? Promise.resolve({ stored: parsed, stamp }) : null;
      return settings;
    });
    this.writing = done.catch(() => undefined);
    return done;
  }
}
