import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { RecentFolderStore } from './RecentFolderStore';

let root: string;
let file: string;

async function folder(name: string): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  return path;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'b4m-recent-folders-'));
  file = join(root, 'state', 'recent-folders.json');
});

describe('RecentFolderStore', () => {
  it('is empty until a folder is used', async () => {
    expect(await new RecentFolderStore(file).list()).toEqual([]);
  });

  it('lists most recent first, by basename, and survives a restart', async () => {
    const app = await folder('app');
    const docs = await folder('docs');
    const store = new RecentFolderStore(file);
    await store.record(app);
    await store.record(docs);

    expect(await new RecentFolderStore(file).list()).toEqual([
      { path: docs, name: 'docs' },
      { path: app, name: 'app' },
    ]);
  });

  it('moves a reused folder to the front instead of listing it twice', async () => {
    const app = await folder('app');
    const docs = await folder('docs');
    const store = new RecentFolderStore(file);
    await store.record(app);
    await store.record(docs);
    await store.record(`${app}/../app/`);

    expect((await store.list()).map(entry => entry.path)).toEqual([app, docs]);
  });

  it('keeps only the newest entries past the cap', async () => {
    const store = new RecentFolderStore(file, 3);
    const paths = await Promise.all(['a', 'b', 'c', 'd'].map(folder));
    for (const path of paths) await store.record(path);

    expect((await store.list()).map(entry => entry.name)).toEqual(['d', 'c', 'b']);
  });

  it('hides a folder that no longer exists but keeps it on disk', async () => {
    const gone = await folder('gone');
    const kept = await folder('kept');
    const store = new RecentFolderStore(file);
    await store.record(gone);
    await store.record(kept);
    await rm(gone, { recursive: true });

    expect((await store.list()).map(entry => entry.name)).toEqual(['kept']);
    expect(JSON.parse(await readFile(file, 'utf8')).folders).toEqual([kept, gone]);
  });

  it('forgets a removed entry', async () => {
    const app = await folder('app');
    const docs = await folder('docs');
    const store = new RecentFolderStore(file);
    await store.record(app);
    await store.record(docs);
    await store.remove(app);

    expect((await new RecentFolderStore(file).list()).map(entry => entry.path)).toEqual([docs]);
  });

  it('applies concurrent changes in call order', async () => {
    const app = await folder('app');
    const docs = await folder('docs');
    const store = new RecentFolderStore(file);
    await Promise.all([store.record(app), store.record(docs), store.remove(app)]);

    expect((await new RecentFolderStore(file).list()).map(entry => entry.path)).toEqual([docs]);
  });

  it('treats a malformed file as empty and drops non-string entries', async () => {
    const app = await folder('app');
    await mkdir(join(root, 'state'), { recursive: true });
    await writeFile(file, '{not json', 'utf8');
    expect(await new RecentFolderStore(file).list()).toEqual([]);

    await writeFile(file, JSON.stringify({ folders: [42, '', app, app] }), 'utf8');
    expect((await new RecentFolderStore(file).list()).map(entry => entry.path)).toEqual([app]);
  });
});
