import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { DownloadOptions } from './download';
import { LocalRuntimeError, ModelNotFoundError } from './errors';
import { type FileLock, lockFile, onDisk, storageError } from './fileLock';
import { ggufQuantLabel, type HubGgufFile, type HuggingFaceHub } from './huggingface';
import type { InstalledModel } from './types';

const RUNTIME_ID = 'llama-server';
const SHARD_RE = /-(\d{5})-of-(\d{5})(\.gguf)$/i;
const GGUF_MAGIC = 'GGUF';
const PARTIAL_SUFFIX = '.partial';
/** Leaves room for the `.partial` and `.lock` suffixes under the usual 255-byte file name limit. */
const MAX_NAME_LENGTH = 200;
const NAME_CHARS = /^[A-Za-z0-9 ._+\-()[\]]+$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

export interface StoredGgufModel extends InstalledModel {
  /** The file, or the first shard present: what llama-server's `--model` takes. */
  path: string;
  /** Every file of the model, shards in order. */
  files: string[];
  /** A vision projector (`mmproj*.gguf`), passed with `--mmproj` rather than served on its own. */
  projector: boolean;
  /** False for a split model with shards missing. */
  complete: boolean;
}

/** A download that stopped before it finished; calling `download` again resumes it. */
export interface PartialGgufFile {
  /** The file name the download will have once complete. */
  name: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface GgufModelStoreOptions {
  /** Directory the caller owns; created on the first add or download. */
  dir: string;
}

/**
 * File names are limited to letters, digits, space and `._+-()[]`, so they are portable, cannot carry a path, and
 * survive llama-server's comma-separated `--alias`.
 */
export function assertFileName(name: string): void {
  const valid =
    name.length <= MAX_NAME_LENGTH &&
    NAME_CHARS.test(name) &&
    /\.gguf$/i.test(name) &&
    !/^[ .]/.test(name) &&
    !WINDOWS_RESERVED.test(name);
  if (!valid) throw new LocalRuntimeError(`${JSON.stringify(name)} is not a usable GGUF file name`, RUNTIME_ID);
}

function shardNames(name: string): string[] {
  const shard = SHARD_RE.exec(name);
  if (!shard) return [name];
  const prefix = name.slice(0, shard.index);
  const total = shard[2] as string;
  const extension = shard[3] as string;
  return Array.from(
    { length: Number(total) },
    (_, i) => `${prefix}-${String(i + 1).padStart(5, '0')}-of-${total}${extension}`
  );
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw storageError(RUNTIME_ID, path, error);
    }
  );
}

async function assertGguf(path: string): Promise<void> {
  const handle = await onDisk(RUNTIME_ID, path, () => open(path, 'r'));
  try {
    const { buffer, bytesRead } = await onDisk(RUNTIME_ID, path, () => handle.read(Buffer.alloc(4), 0, 4, 0));
    if (bytesRead < 4 || buffer.toString('latin1') !== GGUF_MAGIC) {
      throw new LocalRuntimeError(`${basename(path)} is not a GGUF file`, RUNTIME_ID);
    }
  } finally {
    await handle.close();
  }
}

/** Locks every path or none: one busy path releases the locks already taken and rethrows. */
async function lockAll(paths: readonly string[]): Promise<FileLock> {
  const held: FileLock[] = [];
  const release = async () => {
    for (const lock of held.splice(0)) await lock.release();
  };
  try {
    for (const path of paths) held.push(await lockFile(path, RUNTIME_ID));
  } catch (error) {
    await release();
    throw error;
  }
  return { release };
}

/**
 * GGUF files in one directory, as llama-server loads them. Split models are grouped under their first shard.
 * Writes to a file (add, download, remove) hold `<file>.lock`, so they exclude each other across processes and a
 * conflicting one throws `ModelFileBusyError`. File errors throw `RuntimeStorageError`.
 */
export class GgufModelStore {
  readonly dir: string;

  constructor(options: GgufModelStoreOptions) {
    this.dir = options.dir;
  }

  async #entries(): Promise<string[]> {
    try {
      return (await readdir(this.dir, { withFileTypes: true }))
        .filter(entry => entry.isFile() || entry.isSymbolicLink())
        .map(entry => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw storageError(RUNTIME_ID, this.dir, error);
    }
  }

  async list(): Promise<StoredGgufModel[]> {
    const names = (await this.#entries()).filter(name => /\.gguf$/i.test(name));
    const groups = new Map<string, string[]>();
    for (const name of names.sort()) {
      const shard = SHARD_RE.exec(name);
      const key = shard ? `${name.slice(0, shard.index)}/${shard[2]}` : name;
      groups.set(key, [...(groups.get(key) ?? []), name]);
    }
    const models = await Promise.all(
      [...groups.values()].map(async files => {
        const stats = await Promise.all(files.map(file => stat(join(this.dir, file)).catch(() => null)));
        if (stats.some(entry => !entry?.isFile())) return null;
        const first = files[0] as string;
        const expected = shardNames(first);
        const model: StoredGgufModel = {
          name: first,
          path: join(this.dir, first),
          files: files.map(file => join(this.dir, file)),
          sizeBytes: stats.reduce((sum, entry) => sum + (entry?.size ?? 0), 0),
          quantization: ggufQuantLabel(first),
          family: null,
          parameterSize: null,
          modifiedAt: stats[0]?.mtime.toISOString() ?? null,
          capabilities: { tools: false, vision: false, thinking: false, embeddings: false, completion: false },
          projector: /mmproj/i.test(first),
          complete: expected.length === files.length && expected.every((name, i) => name === files[i]),
        };
        return model;
      })
    );
    return models.filter((model): model is StoredGgufModel => model !== null);
  }

  /** `name` is a file name from `list()`. */
  async get(name: string): Promise<StoredGgufModel> {
    const model = (await this.list()).find(entry => entry.name === name);
    if (!model) throw new ModelNotFoundError(RUNTIME_ID, name);
    return model;
  }

  /** Downloads that stopped part way, one entry per file (a split model has one per unfinished shard). */
  async partials(): Promise<PartialGgufFile[]> {
    const names = (await this.#entries()).filter(name => name.toLowerCase().endsWith(`.gguf${PARTIAL_SUFFIX}`));
    const partials = await Promise.all(
      names.sort().map(async file => {
        const path = join(this.dir, file);
        const entry = await stat(path).catch(() => null);
        if (!entry?.isFile()) return null;
        const partial: PartialGgufFile = {
          name: file.slice(0, -PARTIAL_SUFFIX.length),
          path,
          sizeBytes: entry.size,
          modifiedAt: entry.mtime.toISOString(),
        };
        return partial;
      })
    );
    return partials.filter((partial): partial is PartialGgufFile => partial !== null);
  }

  /** Deletes the partial download of `name` (a `PartialGgufFile.name`). */
  async discardPartial(name: string): Promise<void> {
    assertFileName(name);
    const destination = join(this.dir, name);
    const lock = await lockFile(destination, RUNTIME_ID);
    try {
      const partial = `${destination}${PARTIAL_SUFFIX}`;
      if (!(await exists(partial))) throw new ModelNotFoundError(RUNTIME_ID, name);
      await onDisk(RUNTIME_ID, partial, () => rm(partial, { force: true }));
    } finally {
      await lock.release();
    }
  }

  /**
   * Copies a GGUF file into the directory, with its sibling shards when it is one shard of a split model. Refuses
   * to overwrite a model; replaces a partial download of the same name. The copy appears in `list()` only once
   * complete.
   */
  async add(source: string, options: { name?: string; signal?: AbortSignal } = {}): Promise<StoredGgufModel> {
    const sourceName = basename(source);
    const split = SHARD_RE.test(sourceName);
    if (split && options.name !== undefined) {
      throw new LocalRuntimeError('A split model keeps its shard file names', RUNTIME_ID);
    }
    const names = split ? shardNames(sourceName) : [options.name ?? sourceName];
    names.forEach(assertFileName);
    const sources = split ? names.map(name => join(dirname(source), name)) : [source];
    for (const path of sources) await assertGguf(path);
    await onDisk(RUNTIME_ID, this.dir, () => mkdir(this.dir, { recursive: true }));
    const destinations = names.map(name => join(this.dir, name));
    const lock = await lockAll(destinations);
    try {
      for (const destination of destinations) {
        if (await exists(destination)) {
          throw new LocalRuntimeError(`${basename(destination)} already exists in the models directory`, RUNTIME_ID);
        }
      }
      for (const [index, destination] of destinations.entries()) {
        const from = sources[index] as string;
        const partial = `${destination}${PARTIAL_SUFFIX}`;
        try {
          await pipeline(createReadStream(from), createWriteStream(partial), { signal: options.signal });
          const [copied, original] = await Promise.all([stat(partial), stat(from)]);
          if (copied.size !== original.size) {
            throw new LocalRuntimeError(
              `Copy of ${basename(from)} stopped at ${copied.size} of ${original.size} bytes`,
              RUNTIME_ID
            );
          }
          await rename(partial, destination);
        } catch (error) {
          await rm(partial, { force: true });
          options.signal?.throwIfAborted();
          throw storageError(RUNTIME_ID, destination, error);
        }
      }
    } finally {
      await lock.release();
    }
    return this.get(names[0] as string);
  }

  /**
   * Deletes the model's files (every shard present) and any partial download of them; for a name with only a
   * partial download, deletes that. Throws `ModelNotFoundError` only when neither exists.
   */
  async remove(name: string): Promise<void> {
    const model = (await this.list()).find(entry => entry.name === name) ?? null;
    if (!model) {
      assertFileName(name);
      if (!(await exists(join(this.dir, `${name}${PARTIAL_SUFFIX}`)))) throw new ModelNotFoundError(RUNTIME_ID, name);
    }
    const files = model ? model.files : [];
    const paths = [...new Set([...files, ...shardNames(model?.name ?? name).map(entry => join(this.dir, entry))])];
    const lock = await lockAll(paths);
    try {
      for (const path of paths) {
        await onDisk(RUNTIME_ID, path, () => rm(path, { force: true }));
        await onDisk(RUNTIME_ID, path, () => rm(`${path}${PARTIAL_SUFFIX}`, { force: true }));
      }
    } finally {
      await lock.release();
    }
  }

  /**
   * Downloads a Hugging Face file, or every shard of a build, into the directory. Only an explicit call downloads;
   * nothing here fetches on its own. A file already present at the expected size is kept, so calling again after
   * a cancel or a failure resumes where it stopped. Progress covers all files. A second download of the same file
   * while one runs throws `ModelFileBusyError`.
   */
  async download(
    hub: Pick<HuggingFaceHub, 'download'>,
    source: HubGgufFile | { files: readonly HubGgufFile[] },
    options: DownloadOptions = {}
  ): Promise<StoredGgufModel> {
    const files = 'files' in source ? source.files : [source];
    const first = files[0];
    if (!first) throw new LocalRuntimeError('Nothing to download', RUNTIME_ID);
    const targets = files.map(file => {
      const name = basename(file.path);
      assertFileName(name);
      return { file, destination: join(this.dir, name) };
    });
    await onDisk(RUNTIME_ID, this.dir, () => mkdir(this.dir, { recursive: true }));
    const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
    let doneBytes = 0;
    for (const { file, destination } of targets) {
      const present = await stat(destination).catch(() => null);
      if (present && present.size !== file.sizeBytes) {
        throw new LocalRuntimeError(`${basename(destination)} already exists with a different size`, RUNTIME_ID);
      }
      if (!present) {
        await hub.download(file, destination, {
          ...options,
          onProgress: progress => {
            if (progress.status === 'success') return;
            options.onProgress?.({
              status: progress.status,
              completedBytes: doneBytes + progress.completedBytes,
              totalBytes,
            });
          },
        });
      }
      doneBytes += file.sizeBytes;
    }
    options.onProgress?.({ status: 'success', completedBytes: totalBytes, totalBytes });
    return this.get(basename(first.path));
  }
}
