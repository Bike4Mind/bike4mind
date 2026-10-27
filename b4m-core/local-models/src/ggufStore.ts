import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { DownloadOptions } from './download';
import { LocalRuntimeError, ModelNotFoundError } from './errors';
import { ggufQuantLabel, type HubGgufFile, type HuggingFaceHub } from './huggingface';
import type { InstalledModel } from './types';

const RUNTIME_ID = 'llama-server';
const SHARD_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;
const GGUF_MAGIC = 'GGUF';

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

export interface GgufModelStoreOptions {
  /** Directory the caller owns; created on the first add or download. */
  dir: string;
}

function assertFileName(name: string): void {
  if (!/\.gguf$/i.test(name) || name.startsWith('.') || /[\\/\0]/.test(name) || name !== basename(name)) {
    throw new LocalRuntimeError(`${JSON.stringify(name)} is not a GGUF file name`, RUNTIME_ID);
  }
}

function shardNames(name: string): string[] {
  const shard = SHARD_RE.exec(name);
  if (!shard) return [name];
  const prefix = name.slice(0, shard.index);
  const total = shard[2] as string;
  return Array.from(
    { length: Number(total) },
    (_, i) => `${prefix}-${String(i + 1).padStart(5, '0')}-of-${total}.gguf`
  );
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  );
}

async function assertGguf(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4), 0, 4, 0);
    if (bytesRead < 4 || buffer.toString('latin1') !== GGUF_MAGIC) {
      throw new LocalRuntimeError(`${basename(path)} is not a GGUF file`, RUNTIME_ID);
    }
  } finally {
    await handle.close();
  }
}

/** GGUF files in one directory, as llama-server loads them. Split models are grouped under their first shard. */
export class GgufModelStore {
  readonly dir: string;
  readonly #downloading = new Set<string>();

  constructor(options: GgufModelStoreOptions) {
    this.dir = options.dir;
  }

  async list(): Promise<StoredGgufModel[]> {
    let names: string[];
    try {
      names = (await readdir(this.dir, { withFileTypes: true }))
        .filter(entry => (entry.isFile() || entry.isSymbolicLink()) && /\.gguf$/i.test(entry.name))
        .map(entry => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
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
          complete: expected.length === files.length && expected[0] === first,
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

  /**
   * Copies a GGUF file into the directory, with its sibling shards when it is one shard of a split model. Refuses
   * to overwrite; the copy appears in `list()` only once complete.
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
    for (const name of names) {
      if (await exists(join(this.dir, name))) {
        throw new LocalRuntimeError(`${name} already exists in the models directory`, RUNTIME_ID);
      }
    }
    await mkdir(this.dir, { recursive: true });
    for (const [index, name] of names.entries()) {
      const destination = join(this.dir, name);
      const partial = `${destination}.partial`;
      try {
        await pipeline(createReadStream(sources[index] as string), createWriteStream(partial), {
          signal: options.signal,
        });
        await rename(partial, destination);
      } catch (error) {
        await rm(partial, { force: true });
        options.signal?.throwIfAborted();
        throw error;
      }
    }
    return this.get(names[0] as string);
  }

  /** Deletes the model's files (every shard) and any partial download of them. */
  async remove(name: string): Promise<void> {
    const model = await this.get(name);
    const names = shardNames(model.name);
    for (const file of names.map(entry => join(this.dir, entry))) {
      await rm(file, { force: true });
      await rm(`${file}.partial`, { force: true });
    }
  }

  /**
   * Downloads a Hugging Face file, or every shard of a build, into the directory. Only an explicit call downloads;
   * nothing here fetches on its own. A file already present at the expected size is kept, so calling again after
   * a cancel or a failure resumes where it stopped. Progress covers all files.
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
    const busy = targets.find(({ destination }) => this.#downloading.has(destination));
    if (busy) throw new LocalRuntimeError(`${basename(busy.destination)} is already downloading`, RUNTIME_ID);
    for (const { destination } of targets) this.#downloading.add(destination);
    try {
      await mkdir(this.dir, { recursive: true });
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
      return await this.get(basename(first.path));
    } finally {
      for (const { destination } of targets) this.#downloading.delete(destination);
    }
  }
}
