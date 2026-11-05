import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  emptyStoredModelSettings,
  parseModelSettingsFile,
  quotedForMessage,
  storedModelEntry,
  type InvalidModelSetting,
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

function invalidProblem({ modelId, field }: InvalidModelSetting): string {
  const model = quotedForMessage(modelId);
  return field === null
    ? `has an entry for ${model} that is not a set of settings`
    : `has an invalid ${field} for ${model}`;
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
  private readonly loggedUnsupported = new Set<string>();

  constructor(
    private readonly filePath: string,
    private readonly warn: (message: string) => void = () => {}
  ) {}

  private async stamp(): Promise<string | null> {
    const stats = await stat(this.filePath).catch(() => null);
    return stats ? `${stats.mtimeMs}:${stats.size}` : null;
  }

  /**
   * A missing file holds no defaults. Any other failure, an unparseable or wrong-shape file or a known
   * field of the wrong type included, rejects and is not cached, so a fixed or deleted file is read again
   * next time and set() never writes over a file it could not read.
   */
  private read(): Promise<Loaded> {
    if (this.loaded) return this.loaded;
    // Stamped before the read, so an edit landing between the two only makes set() read again.
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
          if ('invalid' in parsed) throw new ModelSettingsFileError(this.filePath, invalidProblem(parsed.invalid));
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
          this.logUnsupported(loaded.stored);
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

  private logUnsupported(stored: StoredModelSettings): void {
    for (const [modelId, values] of stored.unsupported) {
      for (const { field, value } of values) {
        const key = JSON.stringify([modelId, field, value]);
        if (this.loggedUnsupported.has(key)) continue;
        this.loggedUnsupported.add(key);
        this.warn(
          `MODEL SETTINGS: ${this.filePath} holds ${field} ${quotedForMessage(value)} for ${quotedForMessage(modelId)}, which this version of Desktop does not use; it is kept as written.`
        );
      }
    }
  }

  /** Rejects when the file cannot be read or parsed, so neither the Models screen nor a turn takes blanks for it. */
  async get(modelId: string): Promise<ModelSettings> {
    return (await this.read()).stored.settings.get(modelId) ?? {};
  }

  /** The model's stored values this version keeps in the file but does not use, for the Models screen to name. */
  async unsupported(modelId: string): Promise<UnsupportedModelSetting[]> {
    return (await this.read()).stored.unsupported.get(modelId) ?? [];
  }

  /**
   * Replaces one model's defaults; an empty set removes them. Fields and entries Desktop does not know
   * or support (a newer version's) are written back as they were. Writes run one at a time.
   */
  set(modelId: string, settings: ModelSettings): Promise<ModelSettings> {
    const done = this.writing.then(async () => {
      let loaded = await this.read();
      if ((await this.stamp()) !== loaded.stamp) {
        // Changed since it was read, such as by hand while Desktop runs: read it again, never write over it.
        this.loaded = null;
        loaded = await this.read();
      }
      const { stored } = loaded;
      const entries = new Map(stored.entries);
      const entry = storedModelEntry(entries.get(modelId), settings);
      if (entry) entries.set(modelId, entry);
      else entries.delete(modelId);
      const file = { ...stored.rest, models: Object.fromEntries(entries) };
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, this.filePath);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      const written = parseModelSettingsFile(file);
      const stamp = await this.stamp();
      this.loaded = written && !('invalid' in written) ? Promise.resolve({ stored: written, stamp }) : null;
      return settings;
    });
    this.writing = done.catch(() => undefined);
    return done;
  }
}
