import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORCHESTRATE_MINI_PREFERENCES,
  OrchestrateMiniPreferencesStore,
  parseOrchestrateMiniPreferences,
} from './preferences';

describe('parseOrchestrateMiniPreferences', () => {
  it('is off with no bounds by default', () => {
    expect(parseOrchestrateMiniPreferences(undefined)).toEqual(DEFAULT_ORCHESTRATE_MINI_PREFERENCES);
    expect(DEFAULT_ORCHESTRATE_MINI_PREFERENCES.open).toBe(false);
  });

  it('keeps a good field when the other is bad', () => {
    expect(parseOrchestrateMiniPreferences({ open: true, bounds: { x: 'left' } })).toEqual({
      open: true,
      bounds: null,
    });
    expect(parseOrchestrateMiniPreferences({ open: 'yes', bounds: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({
      open: false,
      bounds: { x: 1, y: 2, width: 3, height: 4 },
    });
  });
});

describe('OrchestrateMiniPreferencesStore', () => {
  it('round-trips its bounds and visibility through the file', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'orchestrate-mini-')), 'orchestrate-mini.json');
    const store = new OrchestrateMiniPreferencesStore(path);
    await store.load();
    await store.update({ open: true });
    await store.update({ bounds: { x: 10, y: 20, width: 300, height: 340 } });

    const reloaded = new OrchestrateMiniPreferencesStore(path);
    expect(await reloaded.load()).toEqual({ open: true, bounds: { x: 10, y: 20, width: 300, height: 340 } });
  });

  it('starts from the defaults when the file is not JSON', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'orchestrate-mini-')), 'orchestrate-mini.json');
    await writeFile(path, '{ not json');
    const store = new OrchestrateMiniPreferencesStore(path);
    expect(await store.load()).toEqual(DEFAULT_ORCHESTRATE_MINI_PREFERENCES);
    expect(await readFile(path, 'utf8')).toBe('{ not json');
  });
});
