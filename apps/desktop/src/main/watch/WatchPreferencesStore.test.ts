import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WATCH_PREFERENCES } from '@shared/watch';
import { WatchPreferencesStore } from './WatchPreferencesStore';

async function fileIn(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'watch-prefs-')), 'watch-preferences.json');
}

describe('WatchPreferencesStore', () => {
  it('starts from the defaults when there is no file, or a corrupt one', async () => {
    const path = await fileIn();
    expect(await new WatchPreferencesStore(path).load()).toEqual(DEFAULT_WATCH_PREFERENCES);
    await writeFile(path, '{not json');
    expect(await new WatchPreferencesStore(path).load()).toEqual(DEFAULT_WATCH_PREFERENCES);
  });

  it('round-trips an update through an owner-only file', async () => {
    const path = await fileIn();
    const store = new WatchPreferencesStore(path);
    await store.load();
    await store.update({ miniOpen: true, miniBounds: { x: 5, y: 6, width: 360, height: 220 } });
    await store.update({ showInMenuBar: false });

    const reloaded = await new WatchPreferencesStore(path).load();
    expect(reloaded).toEqual({
      showInMenuBar: false,
      miniOpen: true,
      miniBounds: { x: 5, y: 6, width: 360, height: 220 },
    });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(reloaded);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('serves the latest value from memory before the write lands', async () => {
    const store = new WatchPreferencesStore(await fileIn());
    await store.load();
    const write = store.update({ miniOpen: true });
    expect(store.current().miniOpen).toBe(true);
    await write;
  });
});
