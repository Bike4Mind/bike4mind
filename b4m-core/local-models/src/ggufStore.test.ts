import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DownloadOptions } from './download';
import {
  InvalidModelNameError,
  LocalRuntimeError,
  ModelFileBusyError,
  ModelFileConflictError,
  ModelIncompleteError,
  ModelNotFoundError,
  RuntimeStorageError,
} from './errors';
import { lockFile } from './fileLock';
import { GgufModelStore, assertFileName, assertModelName } from './ggufStore';
import type { HubGgufFile, HuggingFaceHub } from './huggingface';
import type { PullProgress } from './types';
import { ggufWithTemplate, u32 } from './__test__/ggufWriter';

const gguf = (size = 64) => Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(size - 4, 1)]);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

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

async function place(store: GgufModelStore, name: string, bytes: Uint8Array = gguf()): Promise<void> {
  const path = join(store.dir, ...name.split('/'));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, bytes);
}

/** A Hub whose download writes `bytes` (default filler of the listed size) and reports progress, recording calls. */
function fakeHub(bytes?: Buffer) {
  const calls: string[] = [];
  const hub: Pick<HuggingFaceHub, 'download'> = {
    async download(file: HubGgufFile, destination: string, options: DownloadOptions = {}) {
      calls.push(file.path);
      options.onProgress?.({ status: 'downloading', completedBytes: file.sizeBytes / 2, totalBytes: file.sizeBytes });
      await writeFile(destination, bytes ?? gguf(file.sizeBytes));
      options.onProgress?.({ status: 'success', completedBytes: file.sizeBytes, totalBytes: file.sizeBytes });
      return { path: destination, sizeBytes: file.sizeBytes, sha256: file.sha256, resumedBytes: 0 };
    },
  };
  return { hub, calls };
}

const hubFile = (path: string, sizeBytes = 64, sha256: string | null = null): HubGgufFile => ({
  path,
  sizeBytes,
  sha256,
  url: `https://huggingface.co/acme/x/resolve/main/${path}`,
});

const from = (files: HubGgufFile[], repo = 'acme/x') => ({ repo, revision: 'r1', files });

describe('GgufModelStore', () => {
  it('lists nothing for a directory that does not exist yet', async () => {
    expect(await freshStore().list()).toEqual([]);
  });

  it('groups shards under the first, flags projectors and incomplete splits, and skips partial files', async () => {
    const store = freshStore();
    for (const name of [
      'qwen-Q4_K_M.gguf',
      'big-Q8_0-00001-of-00002.gguf',
      'big-Q8_0-00002-of-00002.gguf',
      'half-00002-of-00003.gguf',
      'mmproj-qwen-F16.gguf',
      'loading.gguf.partial',
      'notes.txt',
      'a,b.gguf',
      'org/repo/Q4/deep-Q4_K_M.gguf',
      'org/repo/Q4/deep-Q4_K_M.gguf.source.json',
    ]) {
      await place(store, name);
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
      {
        name: 'org/repo/Q4/deep-Q4_K_M.gguf',
        files: 1,
        projector: false,
        complete: true,
        quantization: 'Q4_K_M',
        sizeBytes: 64,
      },
      { name: 'qwen-Q4_K_M.gguf', files: 1, projector: false, complete: true, quantization: 'Q4_K_M', sizeBytes: 64 },
    ]);
    const deep = await store.get('org/repo/Q4/deep-Q4_K_M.gguf');
    expect(deep.path).toBe(join(store.dir, 'org', 'repo', 'Q4', 'deep-Q4_K_M.gguf'));
    expect(deep.modifiedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(models[1]?.missingShards).toEqual(['half-00001-of-00003.gguf', 'half-00003-of-00003.gguf']);
  });

  it('reads capabilities from the header, reporting a chat model with tools when it is unreadable', async () => {
    const store = freshStore();
    await place(store, 'tools.gguf', ggufWithTemplate('{% if tools %}{{ tools }}{% endif %}<think>'));
    await place(store, 'plain.gguf', ggufWithTemplate('{{ messages }}'));
    await place(store, 'embed.gguf', ggufWithTemplate(null, 'qwen3', u32(3)));
    await place(store, 'unknown.gguf');
    await place(store, 'mmproj-x-f16.gguf', ggufWithTemplate(null));
    await place(store, 'vision-f16.gguf', ggufWithTemplate(null, 'clip'));
    const models = await store.list();
    const capabilities = Object.fromEntries(models.map(model => [model.name, model.capabilities]));
    const none = { tools: false, thinking: false, vision: false, embeddings: false, completion: false };
    expect(models.filter(model => model.projector).map(model => model.name)).toEqual([
      'mmproj-x-f16.gguf',
      'vision-f16.gguf',
    ]);
    expect(capabilities).toEqual({
      'embed.gguf': { ...none, embeddings: true },
      'mmproj-x-f16.gguf': none,
      'vision-f16.gguf': none,
      'plain.gguf': { ...none, completion: true },
      'tools.gguf': { ...none, tools: true, thinking: true, completion: true },
      'unknown.gguf': { ...none, tools: true, completion: true },
    });
  });

  it('copies a GGUF file in and refuses to overwrite, rename unsafely or take a non-GGUF file', async () => {
    const store = freshStore();
    const source = await sourceFile('tiny-Q4_K_M.gguf');
    const added = await store.add(source);
    expect(added).toMatchObject({ name: 'tiny-Q4_K_M.gguf', source: null });
    expect((await readFile(added.path)).equals(gguf())).toBe(true);
    expect((await store.add(source, { name: 'copy.gguf' })).name).toBe('copy.gguf');

    const conflict = await store.add(source).catch((caught: unknown) => caught);
    expect(conflict).toBeInstanceOf(ModelFileConflictError);
    expect(conflict).toMatchObject({
      reason: 'exists',
      message: 'tiny-Q4_K_M.gguf already exists in the models directory',
    });
    await expect(store.add(source, { name: '../escape.gguf' })).rejects.toBeInstanceOf(InvalidModelNameError);
    await expect(store.add(source, { name: 'sub/x.gguf' })).rejects.toThrow('is not a usable GGUF file name');
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

  it('names the missing shards of a split source before copying anything', async () => {
    const store = freshStore();
    const error = await store.add(await sourceFile('s-00001-of-00003.gguf')).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelIncompleteError);
    expect(error).toMatchObject({ missing: ['s-00002-of-00003.gguf', 's-00003-of-00003.gguf'] });
    await expect(readdir(store.dir)).rejects.toThrow();
  });

  it('removes the shards it copied when a later shard fails', async () => {
    const first = await sourceFile('f-00001-of-00002.gguf');
    await writeFile(first.replace('00001-of', '00002-of'), gguf());
    const store = freshStore();
    await mkdir(join(store.dir, 'f-00002-of-00002.gguf.partial'), { recursive: true });
    const error = await store.add(first).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeStorageError);
    expect(error).toMatchObject({ operation: 'write', path: join(store.dir, 'f-00002-of-00002.gguf.partial') });
    expect(await readdir(store.dir)).toEqual(['f-00002-of-00002.gguf.partial']);
  });

  it('blames the source for a read failure', async () => {
    const store = freshStore();
    const source = await sourceFile('dir.gguf');
    await rm(source);
    await mkdir(source);
    const error = await store.add(source).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'RuntimeStorageError', operation: 'read', path: source });
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
    for (const name of ['s-00001-of-00002.gguf', 's-00002-of-00002.gguf.partial', 'keep.gguf']) {
      await place(store, name);
    }
    await store.remove('s-00001-of-00002.gguf');
    expect(await readdir(store.dir)).toEqual(['keep.gguf']);
    await expect(store.remove('s-00001-of-00002.gguf')).rejects.toBeInstanceOf(ModelNotFoundError);
  });

  it('downloads a build under its repo with progress over every shard, keeping shards already present', async () => {
    const store = freshStore();
    const { hub, calls } = fakeHub();
    const build = from([hubFile('Q8/b-00001-of-00002.gguf', 100), hubFile('Q8/b-00002-of-00002.gguf', 300)]);
    await place(store, 'acme/x/Q8/b-00001-of-00002.gguf', gguf(100));

    const progress: PullProgress[] = [];
    const model = await store.download(hub, build, { onProgress: event => progress.push(event) });
    expect(calls).toEqual(['Q8/b-00002-of-00002.gguf']);
    expect(model).toMatchObject({
      name: 'acme/x/Q8/b-00001-of-00002.gguf',
      complete: true,
      sizeBytes: 400,
      source: { repo: 'acme/x', revision: 'r1', sha256: null, sizeBytes: 100 },
    });
    expect(progress).toEqual([
      { status: 'downloading', completedBytes: 250, totalBytes: 400 },
      { status: 'success', completedBytes: 400, totalBytes: 400 },
    ]);

    await store.remove(model.name);
    expect(await readdir(store.dir)).toEqual([]);
  });

  it('keeps files of the same name from different repos apart', async () => {
    const store = freshStore();
    const { hub, calls } = fakeHub();
    await store.download(hub, from([hubFile('model-Q4_K_M.gguf')], 'alice/tune'));
    await store.download(hub, from([hubFile('model-Q4_K_M.gguf')], 'bob/tune'));
    expect(calls).toEqual(['model-Q4_K_M.gguf', 'model-Q4_K_M.gguf']);
    expect((await store.list()).map(model => model.name)).toEqual([
      'alice/tune/model-Q4_K_M.gguf',
      'bob/tune/model-Q4_K_M.gguf',
    ]);
  });

  it('keeps a present file only when its published sha256 matches', async () => {
    const bytes = gguf();
    const file = hubFile('h.gguf', bytes.length, sha(bytes).toUpperCase());
    const store = freshStore();
    const { hub, calls } = fakeHub(bytes);

    await place(store, 'acme/x/h.gguf', bytes);
    const progress: PullProgress[] = [];
    const kept = await store.download(hub, from([file]), { onProgress: event => progress.push(event) });
    expect(calls).toEqual([]);
    expect(progress.some(event => event.status === 'verifying')).toBe(true);
    expect(kept.source).toMatchObject({ sha256: sha(bytes) });

    progress.length = 0;
    await store.download(hub, from([file]), { onProgress: event => progress.push(event) });
    expect(progress.map(event => event.status)).toEqual(['success']);

    const other = freshStore();
    await place(other, 'acme/x/h.gguf', gguf().fill(2, 4));
    const conflict = await other.download(hub, from([file])).catch((caught: unknown) => caught);
    expect(conflict).toBeInstanceOf(ModelFileConflictError);
    expect(conflict).toMatchObject({ reason: 'sha256' });
    expect(calls).toEqual([]);
  });

  it('refuses a file that exists at another size and unsafe names', async () => {
    const store = freshStore();
    const { hub } = fakeHub();
    await place(store, 'acme/x/x.gguf', gguf(10));
    await expect(store.download(hub, from([hubFile('x.gguf', 64)]))).rejects.toMatchObject({
      name: 'ModelFileConflictError',
      reason: 'size',
      message: 'acme/x/x.gguf already exists with a different size',
    });
    await expect(store.download(hub, from([hubFile('weights.safetensors')]))).rejects.toBeInstanceOf(
      InvalidModelNameError
    );
    await expect(store.download(hub, from([hubFile('Q4/a,b.gguf')]))).rejects.toThrow('is not a usable GGUF file name');
    await expect(store.download(hub, from([hubFile('../x.gguf')]))).rejects.toBeInstanceOf(InvalidModelNameError);
    await expect(store.download(hub, from([]))).rejects.toBeInstanceOf(LocalRuntimeError);
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
      'nul .gguf',
      'con  .gguf',
      'com1.gguf',
      'COM0.gguf',
      'lpt0.gguf',
      'LPT9.gguf',
      ' lead.gguf',
      '.hidden.gguf',
      `mod${String.fromCharCode(0xe8)}le.gguf`,
      'a;b.gguf',
      'sub/x.gguf',
      'x.gguf.',
      `${'a'.repeat(196)}.gguf`,
    ]) {
      expect(() => assertFileName(name), name).toThrow(InvalidModelNameError);
    }
  });

  it('accepts model names that are relative paths of portable segments', () => {
    for (const name of ['x.gguf', 'org/repo/x.gguf', 'org/Repo.v2/Q4_K_M/x-00001-of-00002.gguf']) {
      expect(() => assertModelName(name), name).not.toThrow();
    }
    for (const name of [
      '/x.gguf',
      'org//x.gguf',
      'org/../x.gguf',
      'org/./x.gguf',
      'org/.git/x.gguf',
      'org/con/x.gguf',
      'org/dir./x.gguf',
      'org\\x.gguf',
      'org/repo/',
      'a/b/c/d/e/f/g/h/x.gguf',
    ]) {
      expect(() => assertModelName(name), name).toThrow(InvalidModelNameError);
    }
  });

  it('marks a split model incomplete unless every shard name matches exactly', async () => {
    const store = freshStore();
    for (const name of [
      'q-00001-of-00002.gguf',
      'q-00002-of-00002.GGUF',
      'U-00001-of-00002.GGUF',
      'U-00002-of-00002.GGUF',
    ]) {
      await place(store, name);
    }
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

  it('lists, discards and removes partial downloads, pruning emptied directories', async () => {
    const store = freshStore();
    await place(store, 'p.gguf.partial', Buffer.alloc(10));
    await place(store, 'p.gguf.partial.json', Buffer.from('{}'));
    await place(store, 'org/repo/r-00002-of-00002.gguf.partial', Buffer.alloc(20));
    await place(store, 'org/repo/r-00002-of-00002.gguf.partial.json', Buffer.from('{}'));
    expect(await store.partials()).toEqual([
      {
        name: 'org/repo/r-00002-of-00002.gguf',
        path: join(store.dir, 'org', 'repo', 'r-00002-of-00002.gguf.partial'),
        sizeBytes: 20,
        modifiedAt: expect.any(String),
      },
      { name: 'p.gguf', path: join(store.dir, 'p.gguf.partial'), sizeBytes: 10, modifiedAt: expect.any(String) },
    ]);
    await store.discardPartial('p.gguf');
    await expect(store.discardPartial('p.gguf')).rejects.toBeInstanceOf(ModelNotFoundError);
    await expect(store.discardPartial('no/such/dir.gguf')).rejects.toBeInstanceOf(ModelNotFoundError);
    await store.remove('org/repo/r-00002-of-00002.gguf');
    expect(await store.partials()).toEqual([]);
    await expect(store.remove('none.gguf')).rejects.toBeInstanceOf(ModelNotFoundError);
    expect(await readdir(store.dir)).toEqual([]);
  });

  it('deletes a partial record left with no partial, and prunes its folder', async () => {
    const store = freshStore();
    await place(store, 'org/gone/x.gguf.partial.json', Buffer.from('{}'));
    await place(store, 'kept.gguf.partial', Buffer.alloc(4));
    await place(store, 'kept.gguf.partial.json', Buffer.from('{}'));
    expect((await store.partials()).map(partial => partial.name)).toEqual(['kept.gguf']);
    expect((await readdir(store.dir)).sort()).toEqual(['kept.gguf.partial', 'kept.gguf.partial.json']);
  });

  it('refuses to add, remove or discard a file another writer holds, unless forced', async () => {
    const store = freshStore();
    await store.add(await sourceFile('held.gguf'));
    await place(store, 'other.gguf.partial', Buffer.alloc(4));
    const locks = [
      await lockFile(join(store.dir, 'held.gguf'), 'test'),
      await lockFile(join(store.dir, 'new.gguf'), 'test'),
      await lockFile(join(store.dir, 'other.gguf'), 'test'),
    ];
    try {
      await expect(store.add(await sourceFile('new.gguf'))).rejects.toBeInstanceOf(ModelFileBusyError);
      await expect(store.remove('held.gguf')).rejects.toMatchObject({ name: 'ModelFileBusyError', pid: process.pid });
      await expect(store.discardPartial('other.gguf')).rejects.toBeInstanceOf(ModelFileBusyError);
      expect((await readdir(store.dir)).filter(name => !name.endsWith('.lock')).sort()).toEqual([
        'held.gguf',
        'other.gguf.partial',
      ]);
      await store.remove('held.gguf', { force: true });
      await store.discardPartial('other.gguf', { force: true });
      expect(() => locks[0]?.assertHeld()).not.toThrow();
      await expect(locks[0]?.verify()).rejects.toBeInstanceOf(ModelFileBusyError);
    } finally {
      for (const lock of locks) await lock.release();
    }
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
