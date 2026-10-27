import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DownloadOptions } from './download';
import { LocalRuntimeError, ModelNotFoundError } from './errors';
import { GgufModelStore } from './ggufStore';
import type { HubGgufFile, HuggingFaceHub } from './huggingface';
import type { PullProgress } from './types';

const gguf = (size = 64) => Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(size - 4, 1)]);

let root: string;
let count = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gguf-store-test-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function freshStore(): GgufModelStore {
  return new GgufModelStore({ dir: join(root, `store-${++count}`, 'models') });
}

async function sourceFile(name: string, bytes: Buffer = gguf()): Promise<string> {
  const dir = join(root, `src-${++count}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

/** A Hub whose download writes the file and reports two progress events, recording each call. */
function fakeHub() {
  const calls: string[] = [];
  const hub: Pick<HuggingFaceHub, 'download'> = {
    async download(file: HubGgufFile, destination: string, options: DownloadOptions = {}) {
      calls.push(file.path);
      options.onProgress?.({ status: 'downloading', completedBytes: file.sizeBytes / 2, totalBytes: file.sizeBytes });
      await writeFile(destination, gguf(file.sizeBytes));
      options.onProgress?.({ status: 'success', completedBytes: file.sizeBytes, totalBytes: file.sizeBytes });
      return { path: destination, sizeBytes: file.sizeBytes, sha256: null, resumedBytes: 0 };
    },
  };
  return { hub, calls };
}

const hubFile = (path: string, sizeBytes = 64): HubGgufFile => ({
  path,
  sizeBytes,
  sha256: null,
  url: `https://huggingface.co/acme/x/resolve/main/${path}`,
});

describe('GgufModelStore', () => {
  it('lists nothing for a directory that does not exist yet', async () => {
    expect(await freshStore().list()).toEqual([]);
  });

  it('groups shards under the first, flags projectors and incomplete splits, and skips partial files', async () => {
    const store = freshStore();
    await mkdir(store.dir, { recursive: true });
    for (const name of [
      'qwen-Q4_K_M.gguf',
      'big-Q8_0-00001-of-00002.gguf',
      'big-Q8_0-00002-of-00002.gguf',
      'half-00002-of-00003.gguf',
      'mmproj-qwen-F16.gguf',
      'loading.gguf.partial',
      'notes.txt',
    ]) {
      await writeFile(join(store.dir, name), gguf());
    }
    await mkdir(join(store.dir, 'folder.gguf'));

    const models = await store.list();
    expect(
      models.map(({ name, files, projector, complete, quantization, sizeBytes }) => ({
        name,
        files: files.length,
        projector,
        complete,
        quantization,
        sizeBytes,
      }))
    ).toEqual([
      {
        name: 'big-Q8_0-00001-of-00002.gguf',
        files: 2,
        projector: false,
        complete: true,
        quantization: 'Q8_0',
        sizeBytes: 128,
      },
      {
        name: 'half-00002-of-00003.gguf',
        files: 1,
        projector: false,
        complete: false,
        quantization: null,
        sizeBytes: 64,
      },
      { name: 'mmproj-qwen-F16.gguf', files: 1, projector: true, complete: true, quantization: 'F16', sizeBytes: 64 },
      { name: 'qwen-Q4_K_M.gguf', files: 1, projector: false, complete: true, quantization: 'Q4_K_M', sizeBytes: 64 },
    ]);
    expect(models[3]?.path).toBe(join(store.dir, 'qwen-Q4_K_M.gguf'));
    expect(models[3]?.modifiedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('copies a GGUF file in and refuses to overwrite, rename unsafely or take a non-GGUF file', async () => {
    const store = freshStore();
    const source = await sourceFile('tiny-Q4_K_M.gguf');
    const added = await store.add(source);
    expect(added.name).toBe('tiny-Q4_K_M.gguf');
    expect((await readFile(added.path)).equals(gguf())).toBe(true);
    expect((await store.add(source, { name: 'copy.gguf' })).name).toBe('copy.gguf');

    await expect(store.add(source)).rejects.toThrow('tiny-Q4_K_M.gguf already exists in the models directory');
    await expect(store.add(source, { name: '../escape.gguf' })).rejects.toThrow('is not a GGUF file name');
    await expect(store.add(source, { name: 'model.bin' })).rejects.toThrow('is not a GGUF file name');
    await expect(store.add(await sourceFile('fake.gguf', Buffer.from('PK\x03\x04 not gguf')))).rejects.toThrow(
      'fake.gguf is not a GGUF file'
    );
    expect(await readdir(store.dir)).toEqual(['copy.gguf', 'tiny-Q4_K_M.gguf']);
  });

  it('copies every shard of a split model and keeps their names', async () => {
    const first = await sourceFile('m-00001-of-00002.gguf');
    await writeFile(first.replace('00001-of', '00002-of'), gguf());
    const store = freshStore();
    const added = await store.add(first);
    expect(added).toMatchObject({ name: 'm-00001-of-00002.gguf', complete: true, sizeBytes: 128 });
    await expect(store.add(first, { name: 'other.gguf' })).rejects.toThrow('A split model keeps its shard file names');
  });

  it('stops a copy on abort and leaves nothing behind', async () => {
    const store = freshStore();
    const controller = new AbortController();
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(store.add(await sourceFile('a.gguf'), { signal: controller.signal })).rejects.toBe(reason);
    expect(await readdir(store.dir)).toEqual([]);
  });

  it('removes every shard and partial download of a model', async () => {
    const store = freshStore();
    await mkdir(store.dir, { recursive: true });
    for (const name of ['s-00001-of-00002.gguf', 's-00002-of-00002.gguf.partial', 'keep.gguf']) {
      await writeFile(join(store.dir, name), gguf());
    }
    await store.remove('s-00001-of-00002.gguf');
    expect(await readdir(store.dir)).toEqual(['keep.gguf']);
    await expect(store.remove('s-00001-of-00002.gguf')).rejects.toBeInstanceOf(ModelNotFoundError);
  });

  it('downloads every shard of a build with progress over all of them, skipping shards already present', async () => {
    const store = freshStore();
    const { hub, calls } = fakeHub();
    const build = { files: [hubFile('Q8/b-00001-of-00002.gguf', 100), hubFile('Q8/b-00002-of-00002.gguf', 300)] };
    await mkdir(store.dir, { recursive: true });
    await writeFile(join(store.dir, 'b-00001-of-00002.gguf'), gguf(100));

    const progress: PullProgress[] = [];
    const model = await store.download(hub, build, { onProgress: event => progress.push(event) });
    expect(calls).toEqual(['Q8/b-00002-of-00002.gguf']);
    expect(model).toMatchObject({ name: 'b-00001-of-00002.gguf', complete: true, sizeBytes: 400 });
    expect(progress).toEqual([
      { status: 'downloading', completedBytes: 250, totalBytes: 400 },
      { status: 'success', completedBytes: 400, totalBytes: 400 },
    ]);
  });

  it('refuses a file that exists at another size, unsafe names, and a second download of the same file', async () => {
    const store = freshStore();
    const { hub } = fakeHub();
    await mkdir(store.dir, { recursive: true });
    await writeFile(join(store.dir, 'x.gguf'), gguf(10));
    await expect(store.download(hub, hubFile('x.gguf', 64))).rejects.toThrow(
      'x.gguf already exists with a different size'
    );
    await expect(store.download(hub, hubFile('weights.safetensors'))).rejects.toBeInstanceOf(LocalRuntimeError);

    let release: () => void = () => undefined;
    const slow: Pick<HuggingFaceHub, 'download'> = {
      download: async (file, destination) => {
        await new Promise<void>(done => (release = done));
        await writeFile(destination, gguf(file.sizeBytes));
        return { path: destination, sizeBytes: file.sizeBytes, sha256: null, resumedBytes: 0 };
      },
    };
    const first = store.download(slow, hubFile('y.gguf'));
    await expect(store.download(slow, hubFile('y.gguf'))).rejects.toThrow('y.gguf is already downloading');
    await new Promise(done => setTimeout(done, 10));
    release();
    expect((await first).name).toBe('y.gguf');
    expect((await stat(join(store.dir, 'y.gguf'))).size).toBe(64);
  });
});
