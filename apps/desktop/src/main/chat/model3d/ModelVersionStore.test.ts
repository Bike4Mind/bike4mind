import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_VERSION_MAX_SOURCE_BYTES, type ModelVersionInput, ModelVersionStore } from './ModelVersionStore';

const PNG = new Uint8Array([137, 80, 78, 71, 1]);

let root: string;
let clock: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'model-versions-'));
  clock = 1_000;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function store(cap?: number, warn = vi.fn()): ModelVersionStore {
  return new ModelVersionStore(root, { cap, now: () => ++clock, warn });
}

function input(source: string, extra: Partial<ModelVersionInput> = {}): ModelVersionInput {
  return { path: '/work/chest.model.js', source, jointAngles: {}, thumbnail: PNG, ...extra };
}

describe('ModelVersionStore', () => {
  it('records numbered versions with their source, pose, thumbnail and time', async () => {
    const versions = store();
    const first = await versions.record('s1', input('a', { jointAngles: { lid: 30 } }));
    const second = await versions.record('s1', input('b'));
    expect(first).toMatchObject({ number: 1, source: 'a', jointAngles: { lid: 30 }, createdAt: 1_001 });
    expect(second?.number).toBe(2);
    const listed = await versions.listWithThumbnails('s1');
    expect(listed.map(entry => entry.number)).toEqual([1, 2]);
    expect(listed[0].thumbnail).toEqual(PNG);
  });

  it('keeps nothing for the same file and source as the newest version', async () => {
    const versions = store();
    await versions.record('s1', input('a'));
    expect(await versions.record('s1', input('a'))).toBeNull();
    // The same source in another file is a different model.
    expect(await versions.record('s1', input('a', { path: '/work/lamp.model.js' }))).not.toBeNull();
    expect(await versions.list('s1')).toHaveLength(2);
  });

  it('serialises concurrent records, so two windows reporting one build keep it once', async () => {
    const versions = store();
    const results = await Promise.all([versions.record('s1', input('a')), versions.record('s1', input('a'))]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await versions.list('s1')).toHaveLength(1);
  });

  it('prunes the oldest past the cap, with their thumbnails, and never reuses a number', async () => {
    const versions = store(3);
    for (const source of ['a', 'b', 'c', 'd', 'e']) await versions.record('s1', input(source));
    const listed = await versions.list('s1');
    expect(listed.map(entry => entry.number)).toEqual([3, 4, 5]);
    const files = readdirSync(join(root, 's1')).sort();
    expect(files).toEqual(['v3.png', 'v4.png', 'v5.png', 'versions.json']);
    expect(await versions.get('s1', 1)).toBeNull();
    expect((await versions.record('s1', input('f')))?.number).toBe(6);
  });

  it('records a restore as a new version, leaving the restored one in place', async () => {
    const versions = store();
    await versions.record('s1', input('a', { jointAngles: { lid: 10 } }));
    await versions.record('s1', input('b'));
    const restored = await versions.record('s1', input('a', { note: 'Restored v1', restoredFrom: 1 }));
    expect(restored).toMatchObject({ number: 3, source: 'a', note: 'Restored v1', restoredFrom: 1 });
    expect((await versions.list('s1')).map(entry => entry.source)).toEqual(['a', 'b', 'a']);
  });

  it('survives a new store over the same folder, as after an app restart', async () => {
    await store().record('s1', input('a'));
    const reopened = store();
    expect((await reopened.list('s1')).map(entry => entry.source)).toEqual(['a']);
    expect((await reopened.record('s1', input('b')))?.number).toBe(2);
  });

  it('keeps conversations apart and removes one on delete', async () => {
    const versions = store();
    await versions.record('s1', input('a'));
    await versions.record('s2', input('b'));
    await versions.remove('s1');
    expect(await versions.list('s1')).toEqual([]);
    expect((await versions.list('s2')).map(entry => entry.source)).toEqual(['b']);
  });

  it('hashes a session id that is not a plain folder name', async () => {
    const versions = store();
    await versions.record('../escape', input('a'));
    expect(existsSync(join(root, '..', 'escape'))).toBe(false);
    expect(readdirSync(root)).toHaveLength(1);
    expect(readdirSync(root)[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps a version without its thumbnail when none was rendered', async () => {
    const versions = store();
    await versions.record('s1', input('a', { thumbnail: null }));
    expect((await versions.listWithThumbnails('s1'))[0].thumbnail).toBeNull();
  });

  it('skips a source too large to keep', async () => {
    const versions = store();
    expect(await versions.record('s1', input('x'.repeat(MODEL_VERSION_MAX_SOURCE_BYTES + 1)))).toBeNull();
    expect(await versions.list('s1')).toEqual([]);
  });

  it('sets an unreadable index aside instead of overwriting it', async () => {
    mkdirSync(join(root, 's1'));
    writeFileSync(join(root, 's1', 'versions.json'), '{not json');
    const warn = vi.fn();
    const versions = store(undefined, warn);
    expect(await versions.list('s1')).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreadable'));
    const aside = readdirSync(join(root, 's1')).find(name => name.includes('.corrupt-'));
    expect(aside && readFileSync(join(root, 's1', aside), 'utf8')).toBe('{not json');
  });
});
