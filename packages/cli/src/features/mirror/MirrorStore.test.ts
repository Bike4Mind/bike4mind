import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MirrorStore } from './MirrorStore.js';

describe('MirrorStore', () => {
  let dir: string;
  let file: string;
  let store: MirrorStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), 'b4m-mirror-'));
    file = path.join(dir, 'mirrors.json');
    store = new MirrorStore(file);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('configures, pauses, resumes and revokes locally without recording credentials', async () => {
    await store.add({
      name: 'local',
      directory: path.join(dir, 'bundle'),
      accountId: 'u1',
      apiUrl: 'https://example.test',
    });
    expect((await store.list())[0]).toMatchObject({ name: 'local', paused: false, accountId: 'u1' });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(await fs.readFile(file, 'utf8')) as { destinations: Array<Record<string, unknown>> };
    expect(Object.keys(stored.destinations[0]).sort()).toEqual([
      'accountId',
      'apiUrl',
      'createdAt',
      'directory',
      'name',
      'paused',
    ]);
    await store.pause('local', true);
    expect((await new MirrorStore(file).list())[0].paused).toBe(true);
    await store.pause('local', false);
    expect((await store.list())[0].paused).toBe(false);
    await store.revoke('local');
    expect(await store.list()).toEqual([]);
  });

  it('rejects relative paths, duplicate names, missing entries and malformed existing state', async () => {
    await expect(
      store.add({ name: 'a', directory: 'relative', accountId: 'u1', apiUrl: 'https://example.test' })
    ).rejects.toThrow('absolute');
    const entry = { name: 'a', directory: dir, accountId: 'u1', apiUrl: 'https://example.test' };
    await store.add(entry);
    await expect(store.add(entry)).rejects.toThrow('already exists');
    await expect(store.revoke('missing')).rejects.toThrow('not found');
    await fs.writeFile(file, '{broken');
    await expect(store.pause('a', true)).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe('{broken');
  });

  it('explains an invalid name without dumping the validation payload', async () => {
    const error = await store
      .add({ name: 'bad.name', directory: dir, accountId: 'u1', apiUrl: 'https://example.test' })
      .catch((e: Error) => e);
    expect((error as Error).message).toBe("Destination name must be 1-64 letters, digits, '_' or '-'");
    await expect(store.add({ name: 'ok', directory: dir, accountId: 'u1', apiUrl: 'not a url' })).rejects.toThrow(
      'Invalid destination: apiUrl'
    );
  });

  it('reports a malformed registry file readably', async () => {
    await fs.writeFile(file, '{broken');
    await expect(store.list()).rejects.toThrow('malformed');
    await fs.writeFile(file, JSON.stringify({ version: 2, destinations: [] }));
    await expect(store.list()).rejects.toThrow('malformed');
  });

  it('stores a normalized directory', async () => {
    await store.add({ name: 'a', directory: '/a/../b', accountId: 'u1', apiUrl: 'https://example.test' });
    expect((await store.list())[0].directory).toBe(path.resolve('/b'));
  });

  it('leaves no temp files behind after a successful add', async () => {
    await store.add({ name: 'a', directory: dir, accountId: 'u1', apiUrl: 'https://example.test' });
    const leftovers = (await fs.readdir(dir)).filter(entry => entry.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});
