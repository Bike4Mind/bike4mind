import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { type DownloadOptions, PARTIAL_RECORD_SUFFIX, PARTIAL_SUFFIX, SOURCE_SUFFIX } from './download';
import {
  InvalidModelNameError,
  LocalRuntimeError,
  ModelFileConflictError,
  ModelIncompleteError,
  ModelNotFoundError,
} from './errors';
import { type FileLock, type LockOptions, lockFile, onDisk, storageError } from './fileLock';
import { headerCapabilities, readCapabilityInfo } from './ggufCapabilities';
import { ggufQuantLabel, type HubGgufFile, type HuggingFaceHub } from './huggingface';
import type { InstalledModel } from './types';

const RUNTIME_ID = 'llama-server';
const SHARD_RE = /-(\d{5})-of-(\d{5})(\.gguf)$/i;
const GGUF_MAGIC = 'GGUF';
/** Leaves room for the `.partial`, `.lock` and `.source.json` suffixes under the usual 255-byte name limit. */
const MAX_NAME_LENGTH = 200;
const MAX_DEPTH = 8;
const NAME_CHARS = /^[A-Za-z0-9 ._+\-()[\]]+$/;
// Windows ignores spaces before the extension when matching device names, so `nul .gguf` is NUL too.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]) *(\.|$)/i;

/** Where a downloaded file came from, kept beside it as `<file>.source.json`. */
export interface GgufFileSource {
  repo: string;
  revision: string;
  sha256: string | null;
  sizeBytes: number;
}

export interface StoredGgufModel extends InstalledModel {
  /** The file, or the first shard present: what llama-server's `--model` takes. */
  path: string;
  /** Every file of the model, shards in order. */
  files: string[];
  /** A vision projector (`mmproj*.gguf`), passed with `--mmproj` rather than served on its own. */
  projector: boolean;
  /** False for a split model with shards missing. */
  complete: boolean;
  /** File names of the shards a split model lacks. */
  missingShards: string[];
  /** The Hugging Face file it was downloaded from; null for a copied or hand-placed file. */
  source: GgufFileSource | null;
}

/** A download that stopped before it finished; calling `download` again resumes it. */
export interface PartialGgufFile {
  /** The model name the file will have once complete. */
  name: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
}

/** Files of one Hugging Face build at a pinned revision, stored under `<repo>/<path in repo>`. */
export interface GgufDownloadSource {
  repo: string;
  revision: string;
  files: readonly HubGgufFile[];
}

export interface GgufModelStoreOptions {
  /** Directory the caller owns; created on the first add or download. */
  dir: string;
}

function validSegment(segment: string): boolean {
  return (
    segment.length <= MAX_NAME_LENGTH &&
    NAME_CHARS.test(segment) &&
    !/^[ .]|[ .]$/.test(segment) &&
    !WINDOWS_RESERVED.test(segment)
  );
}

/**
 * A file name of letters, digits, space and `._+-()[]` ending in `.gguf`: portable, no path, and safe in
 * llama-server's comma-separated `--alias`.
 */
export function assertFileName(name: string): void {
  if (!validSegment(name) || !/\.gguf$/i.test(name)) throw new InvalidModelNameError(RUNTIME_ID, name);
}

/** A model name: a file name, or `/`-separated directories under the models directory ending in one. */
export function assertModelName(name: string): void {
  const segments = name.split('/');
  const file = segments.pop() as string;
  if (segments.length >= MAX_DEPTH || !segments.every(validSegment)) throw new InvalidModelNameError(RUNTIME_ID, name);
  if (!validSegment(file) || !/\.gguf$/i.test(file)) throw new InvalidModelNameError(RUNTIME_ID, name);
}

function isModelName(name: string): boolean {
  try {
    assertModelName(name);
    return true;
  } catch {
    return false;
  }
}

/** Shard names of a model name, in order, in its own directory. */
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
      throw storageError(RUNTIME_ID, path, error, 'read');
    }
  );
}

async function assertGguf(path: string): Promise<void> {
  const handle = await onDisk(RUNTIME_ID, path, () => open(path, 'r'), 'read');
  try {
    const { buffer, bytesRead } = await onDisk(RUNTIME_ID, path, () => handle.read(Buffer.alloc(4), 0, 4, 0), 'read');
    if (bytesRead < 4 || buffer.toString('latin1') !== GGUF_MAGIC) {
      throw new LocalRuntimeError(`${basename(path)} is not a GGUF file`, RUNTIME_ID);
    }
  } finally {
    await handle.close();
  }
}

async function readSource(path: string): Promise<GgufFileSource | null> {
  try {
    const parsed = JSON.parse(await readFile(`${path}${SOURCE_SUFFIX}`, 'utf8')) as Partial<GgufFileSource>;
    const valid =
      typeof parsed.repo === 'string' &&
      typeof parsed.revision === 'string' &&
      (typeof parsed.sha256 === 'string' || parsed.sha256 === null) &&
      typeof parsed.sizeBytes === 'number';
    return valid ? (parsed as GgufFileSource) : null;
  } catch {
    return null;
  }
}

async function sha256Of(path: string, signal: AbortSignal | undefined, onBytes: (bytes: number) => void) {
  const hash = createHash('sha256');
  let hashed = 0;
  try {
    for await (const chunk of createReadStream(path, { signal })) {
      hash.update(chunk as Buffer);
      hashed += (chunk as Buffer).length;
      onBytes(hashed);
    }
  } catch (error) {
    signal?.throwIfAborted();
    throw storageError(RUNTIME_ID, path, error, 'read');
  }
  return hash.digest('hex');
}

/** Locks every path or none: one busy path releases the locks already taken and rethrows. */
async function lockAll(paths: readonly string[], options: LockOptions = {}): Promise<FileLock> {
  const held: FileLock[] = [];
  const release = async () => {
    for (const lock of held.splice(0)) await lock.release();
  };
  try {
    for (const path of paths) held.push(await lockFile(path, RUNTIME_ID, options));
  } catch (error) {
    await release();
    throw error;
  }
  return {
    release,
    assertHeld: () => held.forEach(lock => lock.assertHeld()),
    check: async () => {
      for (const lock of held) await lock.check();
    },
    verify: async () => {
      for (const lock of held) await lock.verify();
    },
  };
}

/**
 * GGUF files under one directory, as llama-server loads them; downloads sit under `<owner>/<repo>/`, copies at the
 * top. Split models are grouped under their first shard. Writes hold `<file>.lock` (see `lockFile`).
 */
export class GgufModelStore {
  readonly dir: string;

  constructor(options: GgufModelStoreOptions) {
    this.dir = options.dir;
  }

  #path(name: string): string {
    return join(this.dir, ...name.split('/'));
  }

  async #names(): Promise<string[]> {
    const walk = async (segments: string[]): Promise<string[]> => {
      const dir = join(this.dir, ...segments);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw storageError(RUNTIME_ID, dir, error, 'read');
      }
      const names: string[] = [];
      for (const entry of entries) {
        const name = [...segments, entry.name];
        if (entry.isDirectory() && name.length < MAX_DEPTH) names.push(...(await walk(name)));
        else if (entry.isFile() || entry.isSymbolicLink()) names.push(name.join('/'));
      }
      return names;
    };
    return (await walk([])).sort();
  }

  /** Removes directories left empty below the models directory, from `name`'s up. */
  async #prune(name: string): Promise<void> {
    const segments = name.split('/').slice(0, -1);
    while (segments.length > 0) {
      const removed = await rmdir(join(this.dir, ...segments)).then(
        () => true,
        () => false
      );
      if (!removed) return;
      segments.pop();
    }
  }

  async list(): Promise<StoredGgufModel[]> {
    const names = (await this.#names()).filter(name => /\.gguf$/i.test(name) && isModelName(name));
    const groups = new Map<string, string[]>();
    for (const name of names) {
      const shard = SHARD_RE.exec(name);
      const key = shard ? `${name.slice(0, shard.index)}\0${shard[2]}` : name;
      groups.set(key, [...(groups.get(key) ?? []), name]);
    }
    const models = await Promise.all(
      [...groups.values()].map(async files => {
        const paths = files.map(file => this.#path(file));
        const stats = await Promise.all(paths.map(path => stat(path).catch(() => null)));
        if (stats.some(entry => !entry?.isFile())) return null;
        const first = files[0] as string;
        const expected = shardNames(first);
        const named = /mmproj/i.test(basename(first));
        const header = named ? null : await readCapabilityInfo(paths[0] as string);
        const projector = named || header?.architecture === 'clip';
        const model: StoredGgufModel = {
          name: first,
          path: paths[0] as string,
          files: paths,
          sizeBytes: stats.reduce((sum, entry) => sum + (entry?.size ?? 0), 0),
          quantization: ggufQuantLabel(basename(first)),
          family: null,
          parameterSize: null,
          modifiedAt: stats[0]?.mtime.toISOString() ?? null,
          capabilities: {
            ...(header === null
              ? { tools: false, thinking: false, embeddings: false, completion: false }
              : headerCapabilities(header)),
            vision: false,
          },
          projector,
          complete: expected.length === files.length && expected.every((name, i) => name === files[i]),
          missingShards: expected.filter(name => !files.includes(name)).map(name => basename(name)),
          source: await readSource(paths[0] as string),
        };
        return model;
      })
    );
    return models.filter((model): model is StoredGgufModel => model !== null);
  }

  /** `name` is a name from `list()`. */
  async get(name: string): Promise<StoredGgufModel> {
    const model = (await this.list()).find(entry => entry.name === name);
    if (!model) throw new ModelNotFoundError(RUNTIME_ID, name);
    return model;
  }

  /** Downloads that stopped part way, one entry per file (a split model has one per unfinished shard). */
  async partials(): Promise<PartialGgufFile[]> {
    const all = await this.#names();
    const present = new Set(all);
    // A download creates its partial before the record, so a record alone is a crash leftover.
    const records = all.filter(name => name.toLowerCase().endsWith(`.gguf${PARTIAL_SUFFIX}${PARTIAL_RECORD_SUFFIX}`));
    for (const record of records) {
      const owner = record.slice(0, -PARTIAL_RECORD_SUFFIX.length);
      if (present.has(owner) || !isModelName(owner.slice(0, -PARTIAL_SUFFIX.length))) continue;
      await rm(this.#path(record), { force: true }).catch(() => undefined);
      await this.#prune(record);
    }
    const names = all
      .filter(name => name.toLowerCase().endsWith(`.gguf${PARTIAL_SUFFIX}`))
      .map(name => name.slice(0, -PARTIAL_SUFFIX.length))
      .filter(isModelName);
    const partials = await Promise.all(
      names.map(async name => {
        const path = `${this.#path(name)}${PARTIAL_SUFFIX}`;
        const entry = await stat(path).catch(() => null);
        if (!entry?.isFile()) return null;
        const partial: PartialGgufFile = { name, path, sizeBytes: entry.size, modifiedAt: entry.mtime.toISOString() };
        return partial;
      })
    );
    return partials.filter((partial): partial is PartialGgufFile => partial !== null);
  }

  /** Deletes the partial download of `name`; `force` overrides a lock another writer holds. */
  async discardPartial(name: string, options: { force?: boolean } = {}): Promise<void> {
    assertModelName(name);
    const destination = this.#path(name);
    const partial = `${destination}${PARTIAL_SUFFIX}`;
    if (!(await exists(partial))) throw new ModelNotFoundError(RUNTIME_ID, name);
    const lock = await lockFile(destination, RUNTIME_ID, options);
    try {
      if (!(await exists(partial))) throw new ModelNotFoundError(RUNTIME_ID, name);
      for (const file of [partial, `${partial}${PARTIAL_RECORD_SUFFIX}`])
        await onDisk(RUNTIME_ID, file, () => rm(file, { force: true }));
    } finally {
      await lock.release();
    }
    await this.#prune(name);
  }

  /**
   * Copies a GGUF file to the top of the directory, with its sibling shards when it is one shard of a split model.
   * Never overwrites a model; on failure removes what it copied.
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
    const missing = [];
    for (const path of sources) if (!(await exists(path))) missing.push(basename(path));
    if (missing.length > 0) {
      if (!split) throw new ModelNotFoundError(RUNTIME_ID, source);
      throw new ModelIncompleteError(RUNTIME_ID, sourceName, missing);
    }
    for (const path of sources) await assertGguf(path);
    await onDisk(RUNTIME_ID, this.dir, () => mkdir(this.dir, { recursive: true }));
    const destinations = names.map(name => join(this.dir, name));
    const lock = await lockAll(destinations);
    const created: string[] = [];
    try {
      for (const destination of destinations) {
        if (await exists(destination)) throw new ModelFileConflictError(RUNTIME_ID, basename(destination), 'exists');
      }
      for (const [index, destination] of destinations.entries()) {
        const from = sources[index] as string;
        const partial = `${destination}${PARTIAL_SUFFIX}`;
        try {
          lock.assertHeld();
          await pipeline(createReadStream(from), createWriteStream(partial), { signal: options.signal });
          const [copied, original] = await Promise.all([stat(partial), stat(from)]);
          if (copied.size !== original.size) {
            throw new LocalRuntimeError(
              `Copy of ${basename(from)} stopped at ${copied.size} of ${original.size} bytes`,
              RUNTIME_ID
            );
          }
          await lock.verify();
          await rename(partial, destination);
          created.push(destination);
        } catch (error) {
          await rm(partial, { force: true }).catch(() => undefined);
          options.signal?.throwIfAborted();
          const fromSource = (error as NodeJS.ErrnoException | null)?.path === from;
          throw storageError(RUNTIME_ID, fromSource ? from : partial, error, fromSource ? 'read' : 'write');
        }
      }
    } catch (error) {
      for (const path of created) await rm(path, { force: true });
      throw error;
    } finally {
      await lock.release();
    }
    return this.get(names[0] as string);
  }

  /**
   * Deletes the model's files (every shard present) and any partial download of them, or a name that has only a
   * partial download. `force` overrides a lock another writer holds.
   */
  async remove(name: string, options: { force?: boolean } = {}): Promise<void> {
    const model = (await this.list()).find(entry => entry.name === name) ?? null;
    if (!model) {
      assertModelName(name);
      if (!(await exists(`${this.#path(name)}${PARTIAL_SUFFIX}`))) throw new ModelNotFoundError(RUNTIME_ID, name);
    }
    const files = model ? model.files : [];
    const paths = [...new Set([...files, ...shardNames(model?.name ?? name).map(entry => this.#path(entry))])];
    const lock = await lockAll(paths, options);
    try {
      for (const path of paths) {
        const partial = `${path}${PARTIAL_SUFFIX}`;
        for (const file of [path, partial, `${partial}${PARTIAL_RECORD_SUFFIX}`, `${path}${SOURCE_SUFFIX}`]) {
          await onDisk(RUNTIME_ID, file, () => rm(file, { force: true }));
        }
      }
    } finally {
      await lock.release();
    }
    await this.#prune(name);
  }

  /**
   * Downloads every file of a build to `<repo>/<path in repo>`, resuming partial files. A file already present is
   * kept only when its sha256 matches (its size, when none is published); otherwise `ModelFileConflictError`.
   */
  async download(
    hub: Pick<HuggingFaceHub, 'download'>,
    source: GgufDownloadSource,
    options: DownloadOptions = {}
  ): Promise<StoredGgufModel> {
    const targets = source.files.map(file => {
      const name = `${source.repo}/${file.path}`;
      assertModelName(name);
      return { file, name, destination: this.#path(name) };
    });
    const first = targets[0];
    if (!first) throw new LocalRuntimeError('Nothing to download', RUNTIME_ID);
    const totalBytes = source.files.reduce((sum, file) => sum + file.sizeBytes, 0);
    const report = (status: string, completedBytes: number) =>
      options.onProgress?.({ status, completedBytes, totalBytes });
    let doneBytes = 0;
    for (const { file, name, destination } of targets) {
      const record = (sha256: string | null): GgufFileSource => ({
        repo: source.repo,
        revision: source.revision,
        sha256,
        sizeBytes: file.sizeBytes,
      });
      const expectedSha = file.sha256?.toLowerCase() ?? null;
      await onDisk(RUNTIME_ID, dirname(destination), () => mkdir(dirname(destination), { recursive: true }));
      if (await exists(destination)) {
        const size = (await onDisk(RUNTIME_ID, destination, () => stat(destination), 'read')).size;
        if (size !== file.sizeBytes) throw new ModelFileConflictError(RUNTIME_ID, name, 'size');
        const known = await readSource(destination);
        if (expectedSha && known?.sha256?.toLowerCase() !== expectedSha) {
          const actual = await sha256Of(destination, options.signal, bytes => report('verifying', doneBytes + bytes));
          if (actual !== expectedSha) throw new ModelFileConflictError(RUNTIME_ID, name, 'sha256');
        }
        if (!known || (expectedSha && known.sha256 !== expectedSha)) {
          await this.#writeSource(destination, record(expectedSha));
        }
      } else {
        const result = await hub.download(file, destination, {
          ...options,
          onProgress: progress => {
            if (progress.status !== 'success') report(progress.status, doneBytes + progress.completedBytes);
          },
        });
        await this.#writeSource(destination, record(result.sha256 ?? expectedSha));
      }
      doneBytes += file.sizeBytes;
    }
    report('success', totalBytes);
    return this.get(first.name);
  }

  async #writeSource(path: string, source: GgufFileSource): Promise<void> {
    const file = `${path}${SOURCE_SUFFIX}`;
    await onDisk(RUNTIME_ID, file, () => writeFile(file, `${JSON.stringify(source, null, 2)}\n`));
  }
}
