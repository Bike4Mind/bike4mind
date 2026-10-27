import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CuratedStore } from './CuratedStore';

const synced = vi.hoisted(() => [] as string[]);
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      synced.push(String(args[0]));
      return sync();
    };
    return handle;
  };
  return { ...actual, open };
});

const SOURCE = 'abcdef0123456789';
const KEY_A = '00000000000000aa';
const KEY_B = '00000000000000bb';
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array | undefined) => (data ? new TextDecoder().decode(data) : null);

let dir: string;
let store: CuratedStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'curated-store-'));
  store = new CuratedStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('CuratedStore', () => {
  it('switches to a new pair only once both files are written, and prunes the old pair', async () => {
    await store.writeCopy(SOURCE, { manifest: bytes('list 1'), signature: bytes('sig 1') });
    const first = await readdir(join(dir, SOURCE));

    // A crash after the new pair's files but before the pointer: the old pair is still the one read.
    await mkdir(join(dir, SOURCE, 'pair-1-000000000000'));
    await writeFile(join(dir, SOURCE, 'pair-1-000000000000', 'curated-v2.json'), 'list 2');
    const copy = await store.readCopy(SOURCE);
    expect([text(copy?.manifest), text(copy?.signature)]).toEqual(['list 1', 'sig 1']);

    await store.writeCopy(SOURCE, { manifest: bytes('list 3'), signature: bytes('sig 3') });
    const next = await store.readCopy(SOURCE);
    expect([text(next?.manifest), text(next?.signature)]).toEqual(['list 3', 'sig 3']);
    const entries = await readdir(join(dir, SOURCE));
    expect(entries.filter(entry => entry.startsWith('pair-'))).toHaveLength(1);
    expect(entries.some(entry => first.includes(entry) && entry.startsWith('pair-'))).toBe(false);
    expect(entries.some(entry => entry.endsWith('.tmp'))).toBe(false);

    await store.deleteCopy(SOURCE);
    expect(await store.readCopy(SOURCE)).toBeNull();
    expect(await readdir(join(dir, SOURCE))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'flushes every file it writes and every directory that gains an entry',
    async () => {
      synced.length = 0;
      await store.writeCopy(SOURCE, { manifest: bytes('list 1'), signature: bytes('sig 1') });
      const pair = JSON.parse(await readFile(join(dir, SOURCE, 'pair.json'), 'utf8')).dir as string;
      expect(synced).toEqual(
        expect.arrayContaining([
          dir,
          join(dir, SOURCE),
          join(dir, SOURCE, pair),
          join(dir, SOURCE, pair, 'curated-v2.json'),
          join(dir, SOURCE, pair, 'curated-v2.json.sig'),
          expect.stringMatching(/pair\.json\.[^/]+\.tmp$/),
        ])
      );

      synced.length = 0;
      await store.writeState(SOURCE, { lastSuccessAt: 1, lastAttemptAt: 1, failures: 0, floors: {} });
      await store.addRevoked([KEY_A]);
      expect(synced).toEqual([
        expect.stringMatching(/state\.json\.[^/]+\.tmp$/),
        join(dir, SOURCE),
        expect.stringMatching(/revoked-keys\.json\.[^/]+\.tmp$/),
        dir,
      ]);
    }
  );

  it('ignores a pointer to anything but a pair directory', async () => {
    await mkdir(join(dir, SOURCE), { recursive: true });
    await writeFile(join(dir, SOURCE, 'pair.json'), JSON.stringify({ dir: '../elsewhere' }));
    expect(await store.readCopy(SOURCE)).toBeNull();
  });

  it('survives many concurrent writes of the same file', async () => {
    const writes = Array.from({ length: 20 }, (_, failures) =>
      store.writeState(SOURCE, { lastSuccessAt: null, lastAttemptAt: null, failures, floors: {} })
    );
    await expect(Promise.all(writes)).resolves.toBeDefined();
    expect((await readdir(join(dir, SOURCE))).filter(entry => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps per-key floors in the state and drops malformed ones', async () => {
    await store.writeState(SOURCE, { lastSuccessAt: 5, lastAttemptAt: 6, failures: 1, floors: { [KEY_A]: 7 } });
    const state = { lastSuccessAt: 5, lastAttemptAt: 6, failures: 1, floors: { [KEY_A]: 7 } };
    expect(await store.readState(SOURCE)).toEqual(state);
    await writeFile(join(dir, SOURCE, 'state.json'), JSON.stringify({ floors: { [KEY_A]: 1.5, nope: 3, [KEY_B]: 4 } }));
    expect((await store.readState(SOURCE)).floors).toEqual({ [KEY_B]: 4 });
  });

  it('tells a missing revoked set from an unreadable one, keeping the valid ids it can', async () => {
    expect(await store.readRevoked()).toEqual({ ids: new Set(), intact: true });
    await writeFile(join(dir, 'revoked-keys.json'), '[');
    expect(await store.readRevoked()).toEqual({ ids: new Set(), intact: false });
    await writeFile(join(dir, 'revoked-keys.json'), JSON.stringify([KEY_A, 'bad']));
    expect(await store.readRevoked()).toEqual({ ids: new Set([KEY_A]), intact: false });

    expect(await store.addRevoked([KEY_B])).toEqual(new Set([KEY_A, KEY_B]));
    expect(JSON.parse(await readFile(join(dir, 'revoked-keys.json'), 'utf8'))).toEqual([KEY_A, KEY_B]);
    expect(await store.readRevoked()).toEqual({ ids: new Set([KEY_A, KEY_B]), intact: true });
  });
});
