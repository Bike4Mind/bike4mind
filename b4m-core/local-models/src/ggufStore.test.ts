import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DownloadOptions } from './download';
import { LocalRuntimeError, ModelFileBusyError, ModelNotFoundError, RuntimeStorageError } from './errors';
import { lockFile } from './fileLock';
import { GgufModelStore, assertFileName } from './ggufStore';
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
    await expect(store.add(source, { name: '../escape.gguf' })).rejects.toThrow('is not a usable GGUF file name');
    await expect(store.add(source, { name: 'model.bin' })).rejects.toThrow('is not a usable GGUF file name');
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

  it('refuses a file that exists at another size and unsafe names', async () => {
    const store = freshStore();
    const { hub } = fakeHub();
    await mkdir(store.dir, { recursive: true });
    await writeFile(join(store.dir, 'x.gguf'), gguf(10));
    await expect(store.download(hub, hubFile('x.gguf', 64))).rejects.toThrow(
      'x.gguf already exists with a different size'
    );
    await expect(store.download(hub, hubFile('weights.safetensors'))).rejects.toBeInstanceOf(LocalRuntimeError);
    await expect(store.download(hub, hubFile('Q4/a,b.gguf'))).rejects.toThrow('is not a usable GGUF file name');
  });

  it('accepts only portable file names', () => {
    for (const name of ['Qwen2.5-0.5B-Instruct-Q4_K_M.gguf', 'model (copy) [v2]+fix.GGUF', 'con-model.gguf']) {
      expect(() => assertFileName(name)).not.toThrow();
    }
    for (const name of [
      'a,b.gguf',
      'a:b.gguf',
      'CON.gguf',
      'nul.gguf',
      'com1.gguf',
      'LPT9.gguf',
      ' lead.gguf',
      '.hidden.gguf',
      `mod${String.fromCharCode(0xe8)}le.gguf`,
      'a;b.gguf',
      'sub/x.gguf',
      'x.gguf.',
      `${'a'.repeat(196)}.gguf`,
    ]) {
      expect(() => assertFileName(name), name).toThrow(LocalRuntimeError);
    }
  });

  it('marks a split model incomplete unless every shard name matches exactly', async () => {
    const store = freshStore();
    await mkdir(store.dir, { recursive: true });
    for (const name of ['q-00001-of-00002.gguf', 'q-00002-of-00002.GGUF', 'U-00001-of-00002.GGUF']) {
      await writeFile(join(store.dir, name), gguf());
    }
    await writeFile(join(store.dir, 'U-00002-of-00002.GGUF'), gguf());
    const models = await store.list();
    expect(models.map(({ name, complete }) => ({ name, complete }))).toEqual([
      { name: 'U-00001-of-00002.GGUF', complete: true },
      { name: 'q-00001-of-00002.gguf', complete: false },
    ]);
    await store.remove('U-00001-of-00002.GGUF');
    expect((await readdir(store.dir)).sort()).toEqual(['q-00001-of-00002.gguf', 'q-00002-of-00002.GGUF']);
  });

  it('copies a split model whose extension is upper case', async () => {
    const first = await sourceFile('M-00001-of-00002.GGUF');
    await writeFile(first.replace('00001-of', '00002-of'), gguf());
    const added = await freshStore().add(first);
    expect(added).toMatchObject({ name: 'M-00001-of-00002.GGUF', complete: true, sizeBytes: 128 });
  });

  it('lists, discards and removes partial downloads', async () => {
    const store = freshStore();
    await mkdir(store.dir, { recursive: true });
    await writeFile(join(store.dir, 'p.gguf.partial'), Buffer.alloc(10));
    await writeFile(join(store.dir, 'r-00002-of-00002.gguf.partial'), Buffer.alloc(20));
    expect(await store.partials()).toEqual([
      { name: 'p.gguf', path: join(store.dir, 'p.gguf.partial'), sizeBytes: 10, modifiedAt: expect.any(String) },
      {
        name: 'r-00002-of-00002.gguf',
        path: join(store.dir, 'r-00002-of-00002.gguf.partial'),
        sizeBytes: 20,
        modifiedAt: expect.any(String),
      },
    ]);
    await store.discardPartial('p.gguf');
    await expect(store.discardPartial('p.gguf')).rejects.toBeInstanceOf(ModelNotFoundError);
    await store.remove('r-00002-of-00002.gguf');
    expect(await store.partials()).toEqual([]);
    await expect(store.remove('none.gguf')).rejects.toBeInstanceOf(ModelNotFoundError);
    expect(await readdir(store.dir)).toEqual([]);
  });

  it('refuses to add, remove or discard a file another writer holds', async () => {
    const store = freshStore();
    await store.add(await sourceFile('held.gguf'));
    await writeFile(join(store.dir, 'other.gguf.partial'), Buffer.alloc(4));
    const locks = [
      await lockFile(join(store.dir, 'held.gguf'), 'test'),
      await lockFile(join(store.dir, 'new.gguf'), 'test'),
    ];
    const other = await lockFile(join(store.dir, 'other.gguf'), 'test');
    try {
      await expect(store.add(await sourceFile('new.gguf'))).rejects.toBeInstanceOf(ModelFileBusyError);
      await expect(store.remove('held.gguf')).rejects.toMatchObject({ name: 'ModelFileBusyError', pid: process.pid });
      await expect(store.discardPartial('other.gguf')).rejects.toBeInstanceOf(ModelFileBusyError);
    } finally {
      for (const lock of [...locks, other]) await lock.release();
    }
    expect((await readdir(store.dir)).sort()).toEqual(['held.gguf', 'other.gguf.partial']);
    await store.remove('held.gguf');
    await store.discardPartial('other.gguf');
    expect(await readdir(store.dir)).toEqual([]);
  });

  it('reports file errors as RuntimeStorageError with the errno code', async () => {
    const blocker = await sourceFile('not-a-dir.gguf');
    const store = new GgufModelStore({ dir: join(blocker, 'models') });
    const error = await store.add(await sourceFile('a.gguf')).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeStorageError);
    expect(error).toMatchObject({ code: 'ENOTDIR', runtimeId: 'llama-server' });
    await expect(store.list()).rejects.toBeInstanceOf(RuntimeStorageError);
  });
});
